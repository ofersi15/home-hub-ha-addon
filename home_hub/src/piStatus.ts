/**
 * Pi health snapshot -> hub/main/home/pi (PiStatus). Supervisor read-only endpoints, plus host-wide
 * CPU/memory/uptime from /proc via node:os (not namespaced inside the container), plus CPU
 * temperature from sysfs (or an HA System Monitor sensor as a fallback).
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import { autoUpdateEnabled, type AddonInfo, type HomeSettings, type PiStatus, type UpdateInfo } from './contract.js';
import { errMsg, logger } from './log.js';
import type { SupervisorApi } from './supervisor.js';
import { iso } from './util.js';

const log = logger('pi');
const HOUR = 60 * 60 * 1000;

/** Restarts (transitions back to started) observed per add-on in the last hour = crash-loop signal. */
export class AddonFlapTracker {
  private lastState = new Map<string, string>();
  private restarts = new Map<string, number[]>();

  record(slug: string, state: string, nowMs: number): void {
    const prev = this.lastState.get(slug);
    this.lastState.set(slug, state);
    if (prev !== undefined && prev !== 'started' && state === 'started') {
      const list = this.restarts.get(slug) ?? [];
      list.push(nowMs);
      this.restarts.set(slug, list);
    }
  }

  recentRestarts(slug: string, nowMs: number): number {
    const list = (this.restarts.get(slug) ?? []).filter((t) => nowMs - t <= HOUR);
    this.restarts.set(slug, list);
    return list.length;
  }
}

export interface AddonListItem {
  slug: string;
  name: string;
  state: string;
  version: string;
  version_latest?: string;
  update_available?: boolean;
}

export function mapAddonState(s: string | undefined): AddonInfo['state'] {
  if (s === 'started' || s === 'startup') return 'started';
  if (s === 'stopped') return 'stopped';
  if (s === 'error') return 'error';
  return 'unknown';
}

/** Host-wide CPU% between successive calls (null on the first call). */
export function cpuSampler(): () => number | null {
  let prev: { idle: number; total: number } | null = null;
  return () => {
    const cpus = os.cpus();
    if (!cpus.length) return null;
    let idle = 0;
    let total = 0;
    for (const c of cpus) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    const before = prev;
    prev = { idle, total };
    if (!before || total <= before.total) return null;
    return round1(100 * (1 - (idle - before.idle) / (total - before.total)));
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function readSysCpuTemp(path = '/sys/class/thermal/thermal_zone0/temp'): number | null {
  try {
    const milli = Number(readFileSync(path, 'utf8').trim());
    return Number.isFinite(milli) && milli > 0 ? round1(milli / 1000) : null;
  } catch {
    return null;
  }
}

export interface PiDeps {
  sup: SupervisorApi;
  now: () => number;
  flaps: AddonFlapTracker;
  settings: () => HomeSettings | null;
  cpuTempC: () => number | null;
  cpuPercent: () => number | null;
  memoryPercent?: () => number | null;
  osUptimeSeconds?: () => number | null;
  /** Auto-update stopped for this target after 2 consecutive failures (PiStatus.updates[].blocked). */
  blocked?: (target: string) => boolean;
}

interface VersionedInfo {
  version?: string;
  version_latest?: string;
  update_available?: boolean;
  supported?: boolean;
  healthy?: boolean;
}

export function mapBoot(b: unknown): AddonInfo['boot'] {
  return b === 'auto' || b === 'manual' ? b : null;
}

const RELEASE_URL: Record<'core' | 'os' | 'supervisor', (v: string) => string> = {
  core: (v) => `https://github.com/home-assistant/core/releases/tag/${v}`,
  os: (v) => `https://github.com/home-assistant/operating-system/releases/tag/${v}`,
  supervisor: (v) => `https://github.com/home-assistant/supervisor/releases/tag/${v}`,
};
const PLATFORM_NAMES = { core: 'Home Assistant Core', os: 'Home Assistant OS', supervisor: 'Supervisor' } as const;

export interface PiSnapshot {
  status: PiStatus;
  /** Internal detail for auto-update (latest versions per add-on). */
  addonUpdates: { slug: string; updateAvailable: boolean; latest: string }[];
  coreVersion: string | null;
  supported: boolean | null;
}

async function tryGet<T>(sup: SupervisorApi, path: string): Promise<T | null> {
  try {
    return await sup.get<T>(path);
  } catch (e) {
    log.debug(`GET ${path} failed`, { error: errMsg(e) });
    return null;
  }
}

export async function collectPiStatus(deps: PiDeps): Promise<PiSnapshot> {
  const { sup } = deps;
  const nowMs = deps.now();
  const [sysInfo, host, osInfo, core, supervisor, addonsList, backups, resolution] = await Promise.all([
    tryGet<{ supported?: boolean }>(sup, '/info'),
    tryGet<{ disk_total?: number; disk_used?: number; disk_free?: number; boot_timestamp?: number }>(sup, '/host/info'),
    tryGet<VersionedInfo>(sup, '/os/info'),
    tryGet<VersionedInfo>(sup, '/core/info'),
    tryGet<VersionedInfo>(sup, '/supervisor/info'),
    tryGet<{ addons?: AddonListItem[] }>(sup, '/addons'),
    tryGet<{ backups?: { slug: string; name: string; date: string }[] }>(sup, '/backups'),
    tryGet<{ unsupported?: string[]; unhealthy?: string[] }>(sup, '/resolution/info'),
  ]);

  const updates: UpdateInfo[] = [];
  for (const [target, info] of [
    ['core', core],
    ['os', osInfo],
    ['supervisor', supervisor],
  ] as const) {
    if (!info?.version) continue;
    const latest = info.version_latest ?? info.version;
    updates.push({
      target,
      name: PLATFORM_NAMES[target],
      installed: info.version,
      latest,
      updateAvailable: info.update_available === true,
      releaseNotesUrl: RELEASE_URL[target](latest),
      blocked: deps.blocked?.(target) ?? false,
    });
  }

  const settings = deps.settings();
  const addons: AddonInfo[] = [];
  const addonUpdates: PiSnapshot['addonUpdates'] = [];
  for (const a of addonsList?.addons ?? []) {
    deps.flaps.record(a.slug, a.state, nowMs);
    // Per-add-on info: project URL (release notes) + authoritative version/state.
    const info = await tryGet<{ url?: string | null; state?: string; version?: string; version_latest?: string; update_available?: boolean; boot?: string }>(
      sup,
      `/addons/${a.slug}/info`,
    );
    const version = info?.version ?? a.version;
    const latest = info?.version_latest ?? a.version_latest ?? version;
    const updateAvailable = (info?.update_available ?? a.update_available) === true;
    addons.push({
      slug: a.slug,
      name: a.name,
      state: mapAddonState(info?.state ?? a.state),
      version,
      updateAvailable,
      recentRestarts: deps.flaps.recentRestarts(a.slug, nowMs),
      autoUpdatePolicy: settings && autoUpdateEnabled(settings.autoUpdate, a.slug) ? 'auto' : 'off',
      boot: mapBoot(info?.boot),
    });
    addonUpdates.push({ slug: a.slug, updateAvailable, latest });
    if (updateAvailable) {
      updates.push({
        target: a.slug,
        name: a.name,
        installed: version,
        latest,
        updateAvailable,
        releaseNotesUrl: info?.url ?? null,
        blocked: deps.blocked?.(a.slug) ?? false,
      });
    }
  }

  const latestBackup = [...(backups?.backups ?? [])]
    .filter((b) => Number.isFinite(Date.parse(b.date)))
    .sort((x, y) => Date.parse(y.date) - Date.parse(x.date))[0];
  const diskTotal = host?.disk_total ?? null;
  const diskUsed = host?.disk_used ?? null;
  const bootTs = host?.boot_timestamp; // microseconds since epoch
  const uptimeSeconds =
    typeof bootTs === 'number' && bootTs > 0 ? Math.max(0, Math.round((nowMs - bootTs / 1000) / 1000)) : (deps.osUptimeSeconds?.() ?? Math.round(os.uptime()));

  const status: PiStatus = {
    cpuTempC: deps.cpuTempC(),
    cpuPercent: deps.cpuPercent(),
    memoryPercent: deps.memoryPercent ? deps.memoryPercent() : round1(100 * (1 - os.freemem() / os.totalmem())),
    diskUsedPercent: diskTotal && diskUsed !== null ? round1((100 * diskUsed) / diskTotal) : null,
    diskFreeGb: host?.disk_free != null ? round1(host.disk_free) : null,
    uptimeSeconds,
    updates,
    addons,
    lastBackup: latestBackup ? { slug: latestBackup.slug, name: latestBackup.name, date: iso(Date.parse(latestBackup.date)) } : null,
    supervisor: supervisorHealth(supervisor, sysInfo, resolution),
    updatedAt: iso(nowMs),
  };
  return { status, addonUpdates, coreVersion: core?.version ?? null, supported: sysInfo?.supported ?? null };
}

/** supported/healthy flags + reasons. `supported: false` is reported, never treated as an error. */
export function supervisorHealth(
  supervisor: VersionedInfo | null,
  sysInfo: { supported?: boolean } | null,
  resolution: { unsupported?: string[]; unhealthy?: string[] } | null,
): PiStatus['supervisor'] {
  const supported = supervisor?.supported ?? sysInfo?.supported;
  if (supported === undefined && !resolution) return null;
  const unsupportedReasons = (resolution?.unsupported ?? []).map(String).slice(0, 50);
  const unhealthyReasons = (resolution?.unhealthy ?? []).map(String).slice(0, 50);
  return {
    supported: supported ?? unsupportedReasons.length === 0,
    healthy: supervisor?.healthy ?? unhealthyReasons.length === 0,
    unsupportedReasons,
    unhealthyReasons,
  };
}

/** Cheap add-on state poll between full snapshots, so crash-loop flaps are less likely to be missed. */
export async function sampleAddonStates(sup: SupervisorApi, flaps: AddonFlapTracker, nowMs: number): Promise<void> {
  const list = await tryGet<{ addons?: AddonListItem[] }>(sup, '/addons');
  for (const a of list?.addons ?? []) flaps.record(a.slug, a.state, nowMs);
}
