/**
 * Update flow: backup first -> update via the matching Supervisor endpoint -> verify healthy.
 * A failed verify (or failed update) always names the backup so a human can restore it.
 *
 * OS / Supervisor / self updates can kill this process (reboot / restart). Before the update call we
 * persist an "in-flight" record in /data; on the next start `resumeInflight` finishes verification and
 * completes the command.
 */
import { createBackup, type BackupSpec } from './backup.js';
import { PLATFORM_TARGETS } from './contract.js';
import type { Inflight } from './inflight.js';
import { errMsg } from './log.js';
import { SupervisorError, type SupervisorApi } from './supervisor.js';
import { safeName, type Clock, type Sleep } from './util.js';

/** Use the Supervisor's own pre-update backup where the endpoint supports it (core, add-ons), in addition to ours. */
export const USE_BUILTIN_UPDATE_BACKUP = true;

export interface ExecResult {
  status: 'done' | 'failed';
  result: string | null;
  error: string | null;
  backupName: string | null;
}

export interface UpdateDeps {
  sup: SupervisorApi;
  sleep: Sleep;
  now: Clock;
  saveInflight(i: Inflight): void;
  clearInflight(): void;
  pollMs?: number;
  /** Override verify budgets (tests). */
  verifyTimeoutMs?: (target: string) => number;
  backupTimeoutMs?: number;
}

export type Target = 'core' | 'os' | 'supervisor' | { addon: string };

export function parseTarget(t: string): Target | null {
  if ((PLATFORM_TARGETS as readonly string[]).includes(t)) return t as 'core' | 'os' | 'supervisor';
  return /^[a-z0-9_]+$/.test(t) ? { addon: t } : null;
}

const targetKey = (t: Target) => (typeof t === 'string' ? t : t.addon);

export function defaultVerifyTimeoutMs(target: string): number {
  if (target === 'core' || target === 'os') return 15 * 60 * 1000;
  if (target === 'supervisor') return 10 * 60 * 1000;
  return 5 * 60 * 1000;
}

interface VersionInfo {
  name: string;
  installed: string;
  latest: string;
  updateAvailable: boolean;
  state?: string;
}

interface SupInfo {
  name?: string;
  version?: string;
  version_latest?: string;
  update_available?: boolean;
  state?: string;
}

async function readVersion(sup: SupervisorApi, t: Target): Promise<VersionInfo> {
  const path = typeof t === 'string' ? `/${t}/info` : `/addons/${t.addon}/info`;
  const i = await sup.get<SupInfo>(path);
  const name =
    t === 'core' ? 'Home Assistant Core' : t === 'os' ? 'Home Assistant OS' : t === 'supervisor' ? 'Supervisor' : (i.name ?? (t as { addon: string }).addon);
  return {
    name,
    installed: i.version ?? 'unknown',
    latest: i.version_latest ?? i.version ?? 'unknown',
    updateAvailable: i.update_available === true,
    ...(i.state !== undefined ? { state: i.state } : {}),
  };
}

export function preUpdateBackupName(target: string, version: string): string {
  return `hub-pre-update-${safeName(target)}-${safeName(version)}`;
}

function backupSpec(t: Target, name: string): BackupSpec {
  // Add-on: partial backup of just that add-on. Core/OS/Supervisor: full backup.
  return typeof t === 'string' ? { name, kind: 'full' } : { name, kind: 'partial', addons: [t.addon], homeassistant: false };
}

async function postUpdate(sup: SupervisorApi, t: Target, version: string): Promise<void> {
  const long = { timeoutMs: 60 * 60 * 1000 };
  if (t === 'core') await sup.post('/core/update', { version, backup: USE_BUILTIN_UPDATE_BACKUP }, long);
  else if (t === 'os') await sup.post('/os/update', { version }, long);
  else if (t === 'supervisor') await sup.post('/supervisor/update', { version }, long);
  else await sup.post(`/store/addons/${t.addon}/update`, { backup: USE_BUILTIN_UPDATE_BACKUP }, long);
}

/** One health probe. ok=false carries the reason (used in the failure message). */
export async function checkHealthy(sup: SupervisorApi, t: Target, version: string, requireStarted: boolean): Promise<{ ok: boolean; detail: string }> {
  try {
    const api = await sup.core<{ message?: string }>('/api/');
    if (!api || typeof api.message !== 'string') return { ok: false, detail: 'HA API did not answer' };
    const cfg = await sup.core<{ state?: string }>('/api/config');
    if (cfg.state !== undefined && cfg.state !== 'RUNNING') return { ok: false, detail: `HA state is ${cfg.state}` };
    const sysInfo = await sup.get<{ state?: string }>('/info');
    if (sysInfo.state !== undefined && sysInfo.state !== 'running') return { ok: false, detail: `Supervisor state is ${sysInfo.state}` };
    const core = await sup.get<SupInfo>('/core/info');
    if (core.state !== undefined && core.state !== 'running') return { ok: false, detail: `Core state is ${core.state}` };
    if (t === 'core' && core.version !== version) return { ok: false, detail: `Core is ${core.version ?? '?'}, expected ${version}` };
    if (t === 'os' || t === 'supervisor') {
      const v = await readVersion(sup, t);
      if (v.installed !== version) return { ok: false, detail: `${v.name} is ${v.installed}, expected ${version}` };
    }
    if (typeof t !== 'string') {
      const a = await readVersion(sup, t);
      if (a.installed !== version) return { ok: false, detail: `${a.name} is ${a.installed}, expected ${version}` };
      if (requireStarted && a.state !== 'started') return { ok: false, detail: `${a.name} state is ${a.state ?? 'unknown'}` };
    }
    return { ok: true, detail: 'HA healthy' };
  } catch (e) {
    return { ok: false, detail: errMsg(e) };
  }
}

async function verifyUntil(deps: UpdateDeps, t: Target, version: string, requireStarted: boolean, deadline: number): Promise<{ ok: boolean; detail: string }> {
  const pollMs = deps.pollMs ?? 15_000;
  let last = { ok: false, detail: 'not checked' };
  // First probe right away is pointless for restarts; wait one interval first.
  do {
    await deps.sleep(pollMs);
    last = await checkHealthy(deps.sup, t, version, requireStarted);
    if (last.ok) return last;
  } while (deps.now() < deadline);
  return last;
}

function failed(msg: string, backupName: string | null): ExecResult {
  return { status: 'failed', result: null, error: msg.slice(0, 2000), backupName };
}

export async function runUpdate(deps: UpdateDeps, targetStr: string, commandId: string | null): Promise<ExecResult> {
  const t = parseTarget(targetStr);
  if (!t) return failed(`Unknown update target '${targetStr}'`, null);
  const key = targetKey(t);

  let info: VersionInfo;
  try {
    info = await readVersion(deps.sup, t);
  } catch (e) {
    return failed(`Could not read ${key} version info: ${errMsg(e)}`, null);
  }
  if (!info.updateAvailable) {
    return { status: 'done', result: `${info.name} is already up to date (${info.installed}); nothing to do.`, error: null, backupName: null };
  }
  const version = info.latest;
  const backupName = preUpdateBackupName(key, version);

  // 1. Backup first. No backup, no update.
  try {
    await createBackup({ sup: deps.sup, sleep: deps.sleep, now: deps.now, ...(deps.backupTimeoutMs ? { timeoutMs: deps.backupTimeoutMs } : {}) }, backupSpec(t, backupName));
  } catch (e) {
    return failed(`Backup '${backupName}' failed (${errMsg(e)}); update of ${info.name} to ${version} was NOT attempted.`, backupName);
  }

  // 2. Update. Persist in-flight state first: OS/Supervisor/self updates may kill this process.
  const startedAt = deps.now();
  const requireStarted = typeof t !== 'string' && info.state === 'started';
  deps.saveInflight({ commandId, target: key, version, backupName, startedAt, fromVersion: info.installed, requireStarted });
  try {
    await postUpdate(deps.sup, t, version);
  } catch (e) {
    if (!(e instanceof SupervisorError && e.kind === 'network')) {
      deps.clearInflight();
      return failed(`Update of ${info.name} to ${version} failed: ${errMsg(e)}. Backup '${backupName}' was taken first; restore it if needed.`, backupName);
    }
    // Connection dropped (restart in progress): fall through to verification.
  }

  // 3. Verify.
  const outcome = await finishVerify(deps, { commandId, target: key, version, backupName, startedAt, fromVersion: info.installed, requireStarted });
  return outcome;
}

async function finishVerify(deps: UpdateDeps, inflight: Inflight): Promise<ExecResult> {
  const t = parseTarget(inflight.target);
  if (!t) {
    deps.clearInflight();
    return failed(`Unknown update target '${inflight.target}'`, inflight.backupName);
  }
  const budget = (deps.verifyTimeoutMs ?? defaultVerifyTimeoutMs)(inflight.target);
  const deadline = Math.max(inflight.startedAt + budget, deps.now() + (deps.pollMs ?? 15_000));
  const v = await verifyUntil(deps, t, inflight.version, inflight.requireStarted, deadline);
  deps.clearInflight();
  if (v.ok) {
    return {
      status: 'done',
      result: `Updated ${inflight.target} ${inflight.fromVersion} -> ${inflight.version}. Backup '${inflight.backupName}' created first; ${v.detail}.`,
      error: null,
      backupName: inflight.backupName,
    };
  }
  return failed(
    `Update of ${inflight.target} to ${inflight.version} could not be verified healthy within ${Math.round(budget / 60000)} min (${v.detail}). Restore backup '${inflight.backupName}' if needed.`,
    inflight.backupName,
  );
}

/** After a restart: finish an update that was in flight when the process died. */
export async function resumeInflight(deps: UpdateDeps, inflight: Inflight): Promise<ExecResult> {
  return finishVerify(deps, inflight);
}
