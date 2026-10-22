/**
 * Update engine: lock -> Supervisor idle -> backup -> update -> verify -> (restart suggestions).
 *
 * - One update at a time: the lock is the persisted UpdateState (/data/update-state.json). While it
 *   exists no other update starts.
 * - Backup first, always. No backup, no update.
 * - The phase is persisted BEFORE each step that can kill this process (a Core update restarts HA, an
 *   OS update reboots the host, a Supervisor update restarts the Supervisor and our container). On the
 *   next start `resumeUpdate` finishes the job from the saved phase.
 * - A failure after the backup always names the backup and says "restore from this backup".
 * - The state is cleared only AFTER the command doc has the outcome (the caller runs `after`).
 * - OS: a version that is installed but not booted yet ("pending") is finished with one reboot (Supervisor
 *   `execute_reboot` suggestion), backup first like any update; never a second reboot (DECISIONS D14).
 * - HA `update.*` entities that the Supervisor does not manage (HACS integrations/cards, device firmware):
 *   HA-config backup -> `update.install` -> verify the entity's installed_version -> restart HA once if a
 *   "restart required" repair is open, reboot once if the update raised a NEW reboot suggestion (D15).
 */
import { createBackup, type BackupSpec } from './backup.js';
import { PLATFORM_TARGETS } from './contract.js';
import { errMsg, logger } from './log.js';
import type { HaIssue } from './haWs.js';
import { SupervisorError, type SupervisorApi } from './supervisor.js';
import type { UpdateState, UpdateStateStore } from './updateState.js';
import { nyParts, safeName, type Clock, type Sleep } from './util.js';

const log = logger('update');

/**
 * Also ask the Supervisor for its own pre-update backup (core/add-on endpoints)? Off since 0.2.0: our
 * 'hub-' backup is always taken first, and the Supervisor's extra backups are not 'hub-' backups, so
 * retention could never clean them up and daily auto-updates would fill the SD card (DECISIONS D9).
 */
export const USE_BUILTIN_UPDATE_BACKUP = false;

export interface ExecResult {
  status: 'done' | 'failed';
  result: string | null;
  error: string | null;
  backupName: string | null;
  /** Not the target's fault (lock held, Supervisor busy): does not count toward backoff / block. */
  transient?: boolean;
  /** Run after the outcome is written to the command doc: clears the lock, applies restart suggestions. */
  after?: () => Promise<void>;
}

export interface UpdateDeps {
  sup: SupervisorApi;
  sleep: Sleep;
  now: Clock;
  state: UpdateStateStore;
  pollMs?: number;
  /** Override verify budgets (tests). */
  verifyTimeoutMs?: (target: string) => number;
  backupTimeoutMs?: number;
  /** How long a manual update waits for running Supervisor jobs to finish (default 10 min). */
  jobsWaitMs?: number;
  /** Home Assistant (WebSocket): needed for update.* entity targets only. */
  ha?: EntityUpdateHa;
}

/** What entity updates need from HA. */
export interface EntityUpdateHa {
  readonly connected: boolean;
  callService(domain: string, service: string, data: Record<string, unknown>, entityId: string, timeoutMs?: number): Promise<void>;
  listIssues(): Promise<HaIssue[]>;
}

export type Target = 'core' | 'os' | 'supervisor' | { addon: string } | { entity: string };

const isAddon = (t: Target): t is { addon: string } => typeof t !== 'string' && 'addon' in t;
const isEntity = (t: Target): t is { entity: string } => typeof t !== 'string' && 'entity' in t;

/** An HA update entity the add-on may install (not a Supervisor one: those are core/os/supervisor/add-on targets). */
export const isEntityTarget = (t: string) => /^update\.[a-z0-9_]+$/.test(t);

export function parseTarget(t: string): Target | null {
  if ((PLATFORM_TARGETS as readonly string[]).includes(t)) return t as 'core' | 'os' | 'supervisor';
  if (isEntityTarget(t)) return { entity: t };
  return /^[a-z0-9_]+$/.test(t) ? { addon: t } : null;
}

const targetKey = (t: Target) => (typeof t === 'string' ? t : isAddon(t) ? t.addon : t.entity);

/**
 * Verify budget after the update call: Core/OS 20 min (restart / reboot), Supervisor 10, add-ons 5,
 * update.* entities 45 (device firmware over Z-Wave is slow; the loop ends as soon as it is done).
 */
export function defaultVerifyTimeoutMs(target: string): number {
  if (target === 'core' || target === 'os') return 20 * 60 * 1000;
  if (target === 'supervisor') return 10 * 60 * 1000;
  if (isEntityTarget(target)) return 45 * 60 * 1000;
  return 5 * 60 * 1000;
}

/** `update.install` waits for the install inside HA; past this the call times out and verification decides. */
export const ENTITY_INSTALL_CALL_MS = 2 * 60 * 1000;

interface VersionInfo {
  name: string;
  installed: string;
  latest: string;
  updateAvailable: boolean;
  state?: string;
  /** OS: installed, waiting for a reboot (osPendingVersion). */
  pending?: string;
}

interface SupInfo {
  name?: string;
  version?: string;
  version_latest?: string;
  update_available?: boolean;
  state?: string;
}

export interface OsInfo {
  version?: string;
  version_latest?: string;
  update_available?: boolean;
  /** HAOS: the version installed into the other slot, booted on the next reboot. */
  version_pending?: string | null;
  boot_slots?: Record<string, { state?: string; version?: string }>;
}

/**
 * The newer OS version that is installed but not booted (it needs a reboot), or null. HAOS reports
 * `update_available: false` in that state, so without this nothing would ever finish the update.
 * Uses `version_pending`; older Supervisors: an inactive boot slot that holds `version_latest`.
 */
export function osPendingVersion(i: OsInfo | null | undefined): string | null {
  if (!i?.version) return null;
  const inactiveLatest = Object.values(i.boot_slots ?? {}).some((s) => s.state !== 'booted' && s.version === i.version_latest);
  const pending = i.version_pending || (inactiveLatest ? i.version_latest : null);
  return pending && pending !== i.version && versionAtLeast(pending, i.version) ? pending : null;
}

const PLATFORM_NAMES = { core: 'Home Assistant Core', os: 'Home Assistant OS', supervisor: 'Supervisor' } as const;

interface EntityState {
  state?: string;
  attributes?: Record<string, unknown>;
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : null);

/** HA reports `in_progress` as true or a percentage while an install runs. */
export const entityInProgress = (a: Record<string, unknown>) => a.in_progress === true || typeof a.in_progress === 'number';

async function readVersion(sup: SupervisorApi, t: Target): Promise<VersionInfo> {
  if (isEntity(t)) {
    const s = await sup.core<EntityState>(`/api/states/${t.entity}`);
    const a = s.attributes ?? {};
    const installed = str(a.installed_version) ?? 'unknown';
    const latest = str(a.latest_version) ?? installed;
    return {
      name: str(a.title) ?? str(a.friendly_name) ?? t.entity,
      installed,
      latest,
      updateAvailable: s.state === 'on' && !entityInProgress(a) && latest !== installed,
    };
  }
  const path = typeof t === 'string' ? `/${t}/info` : `/addons/${t.addon}/info`;
  const i = await sup.get<SupInfo & OsInfo>(path);
  const name = typeof t === 'string' ? PLATFORM_NAMES[t] : (i.name ?? t.addon);
  const pending = t === 'os' ? osPendingVersion(i) : null;
  return {
    name,
    installed: i.version ?? 'unknown',
    latest: i.version_latest ?? i.version ?? 'unknown',
    updateAvailable: i.update_available === true,
    ...(i.state !== undefined ? { state: i.state } : {}),
    ...(pending ? { pending } : {}),
  };
}

/**
 * `installed >= wanted`, comparing the numeric parts (2026.11.1 >= 2026.11.0; 16.10 >= 16.9). Equal
 * strings are always fine; anything unparseable counts as "not reached".
 */
export function versionAtLeast(installed: string, wanted: string): boolean {
  if (installed === wanted) return true;
  const a = installed.match(/\d+/g)?.map(Number);
  const b = wanted.match(/\d+/g)?.map(Number);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  // Same numbers but different strings (e.g. 2026.11.0 vs 2026.11.0b1 has more parts, handled above).
  return false;
}

/** `hub-pre-update-<target>-<toVersion>-<yyyymmdd-hhmm>` (New York time). */
export function preUpdateBackupName(target: string, version: string, nowMs: number): string {
  const p = nyParts(nowMs);
  const stamp = `${p.date.replace(/-/g, '')}-${p.hhmm.replace(':', '')}`;
  return `hub-pre-update-${safeName(target)}-${safeName(version)}-${stamp}`;
}

function backupSpec(t: Target, name: string): BackupSpec {
  // Add-on: partial backup of just that add-on. update.* entity: HA config (custom_components, www).
  // Core/OS/Supervisor: full backup.
  if (isAddon(t)) return { name, kind: 'partial', addons: [t.addon], homeassistant: false };
  if (isEntity(t)) return { name, kind: 'partial', addons: [], homeassistant: true };
  return { name, kind: 'full' };
}

async function postUpdate(deps: UpdateDeps, t: Target, version: string): Promise<void> {
  const sup = deps.sup;
  if (isEntity(t)) {
    if (!deps.ha) throw new Error('Home Assistant is not connected');
    try {
      await deps.ha.callService('update', 'install', {}, t.entity, ENTITY_INSTALL_CALL_MS);
    } catch (e) {
      // Still installing inside HA (firmware): verification decides.
      if (!/timed out/i.test(errMsg(e))) throw e;
    }
    return;
  }
  const long = { timeoutMs: 60 * 60 * 1000 };
  if (t === 'core') await sup.post('/core/update', { version, backup: USE_BUILTIN_UPDATE_BACKUP }, long);
  else if (t === 'os') await sup.post('/os/update', { version }, long);
  else if (t === 'supervisor') await sup.post('/supervisor/update', { version }, long);
  else await sup.post(`/store/addons/${t.addon}/update`, { backup: USE_BUILTIN_UPDATE_BACKUP }, long);
}

/** Name of a running Supervisor job (backup, update, ...), or null when idle. Unknown -> null. */
export async function supervisorBusy(sup: SupervisorApi): Promise<string | null> {
  try {
    const info = await sup.get<{ jobs?: { name?: string; done?: boolean }[] }>('/jobs/info');
    const running = (info.jobs ?? []).find((j) => j.done === false);
    return running ? (running.name ?? 'a Supervisor job') : null;
  } catch (e) {
    log.debug('GET /jobs/info failed; assuming idle', { error: errMsg(e) });
    return null;
  }
}

interface Health {
  ok: boolean;
  detail: string;
  /** Add-on reached the new version but is stopped/error (candidate for one start). */
  addonDown?: boolean;
}

/**
 * One health probe: HA `/api/` answers, HA config state RUNNING, Supervisor running, `/core/info`
 * state running, the target reports `toVersion` (or newer), and an add-on that ran before runs again.
 */
export async function checkHealthy(sup: SupervisorApi, t: Target, toVersion: string, requireStarted: boolean): Promise<Health> {
  try {
    const api = await sup.core<{ message?: string }>('/api/');
    if (!api || typeof api.message !== 'string') return { ok: false, detail: 'HA API did not answer' };
    const cfg = await sup.core<{ state?: string }>('/api/config');
    if (cfg.state !== undefined && cfg.state !== 'RUNNING') return { ok: false, detail: `HA state is ${cfg.state}` };
    const sysInfo = await sup.get<{ state?: string }>('/info');
    if (sysInfo.state !== undefined && sysInfo.state !== 'running') return { ok: false, detail: `Supervisor state is ${sysInfo.state}` };
    const core = await sup.get<SupInfo>('/core/info');
    if (core.state !== undefined && core.state !== 'running') return { ok: false, detail: `Core state is ${core.state}` };
    const v = t === 'core' ? { name: PLATFORM_NAMES.core, installed: core.version ?? 'unknown', state: core.state } : await readVersion(sup, t);
    if (!versionAtLeast(v.installed, toVersion)) return { ok: false, detail: `${v.name} is ${v.installed}, expected ${toVersion}` };
    if (isAddon(t) && requireStarted && v.state !== 'started') {
      return { ok: false, detail: `${v.name} state is ${v.state ?? 'unknown'}`, addonDown: v.state === 'stopped' || v.state === 'error' };
    }
    return { ok: true, detail: 'HA healthy' };
  } catch (e) {
    return { ok: false, detail: errMsg(e) };
  }
}

function failed(msg: string, backupName: string | null, extra: Partial<ExecResult> = {}): ExecResult {
  return { status: 'failed', result: null, error: msg.slice(0, 2000), backupName, ...extra };
}

const restoreHint = (backupName: string) => `Restore from this backup if needed: '${backupName}'.`;

/** Wait for running Supervisor jobs to finish; returns the still-running job's name after the budget. */
async function waitIdle(deps: UpdateDeps): Promise<string | null> {
  const deadline = deps.now() + (deps.jobsWaitMs ?? 10 * 60 * 1000);
  let busy = await supervisorBusy(deps.sup);
  while (busy && deps.now() < deadline) {
    await deps.sleep(deps.pollMs ?? 15_000);
    busy = await supervisorBusy(deps.sup);
  }
  return busy;
}

export interface RunOpts {
  /** Auto-update (system:addon) rather than a Hub command. */
  auto?: boolean;
}

export async function runUpdate(deps: UpdateDeps, targetStr: string, commandId: string | null, opts: RunOpts = {}): Promise<ExecResult> {
  const t = parseTarget(targetStr);
  if (!t) return failed(`Unknown update target '${targetStr}'`, null);
  const key = targetKey(t);
  if (isEntity(t) && !deps.ha?.connected) {
    return failed(`Home Assistant is not connected; update of ${key} was not started.`, null, { transient: true });
  }

  // 0. The global lock: one update at a time, across restarts.
  const held = deps.state.load();
  if (held) {
    return failed(`Another update is in progress (${held.target} -> ${held.toVersion}, ${held.phase}); ${key} was not started.`, null, { transient: true });
  }

  let info: VersionInfo;
  try {
    info = await readVersion(deps.sup, t);
  } catch (e) {
    return failed(`Could not read ${key} version info: ${errMsg(e)}`, null);
  }
  // OS installed but not booted: finishing it = backup + one reboot.
  const activate = !info.updateAvailable && info.pending !== undefined;
  if (!info.updateAvailable && !activate) {
    return { status: 'done', result: `${info.name} is already up to date (${info.installed}); nothing to do.`, error: null, backupName: null };
  }

  // Never start while the Supervisor runs a backup or another job.
  const busy = await waitIdle(deps);
  if (busy) return failed(`Supervisor is busy (${busy}); update of ${info.name} was not started.`, null, { transient: true });

  const toVersion = activate ? (info.pending as string) : info.latest;
  // update.* entity: the backup name drops the redundant "update." (hub-pre-update-local_tuya_update-...).
  const backupName = preUpdateBackupName(key.replace(/^update\./, ''), toVersion, deps.now());
  const base: Omit<UpdateState, 'phase'> = {
    target: key,
    fromVersion: info.installed,
    toVersion,
    backupName,
    startedAt: deps.now(),
    commandId,
    requireStarted: isAddon(t) && info.state === 'started',
    auto: opts.auto === true,
    rebootRequested: activate,
    ...(isEntity(t) ? { preSuggestions: await suggestionIds(deps.sup) } : {}),
  };
  const clear = async () => deps.state.clear();

  // 1. Backup first. No backup, no update.
  deps.state.save({ ...base, phase: 'backup' });
  try {
    await createBackup({ sup: deps.sup, sleep: deps.sleep, now: deps.now, ...(deps.backupTimeoutMs ? { timeoutMs: deps.backupTimeoutMs } : {}) }, backupSpec(t, backupName));
  } catch (e) {
    return failed(`Backup failed: '${backupName}' (${errMsg(e)}). The update of ${info.name} to ${toVersion} was NOT attempted.`, null, { after: clear });
  }

  // 2. Update. The phase is on disk first: this call may restart HA, reboot the host, or kill us.
  deps.state.save({ ...base, phase: 'updating' });
  try {
    if (activate) {
      if (!(await requestReboot(deps.sup))) {
        return failed(
          `${info.name} ${toVersion} is installed but needs a reboot, and the Supervisor offers no reboot suggestion; reboot the Pi from Home Assistant. Backup '${backupName}' was taken.`,
          backupName,
          { after: clear },
        );
      }
    } else await postUpdate(deps, t, toVersion);
  } catch (e) {
    if (!(e instanceof SupervisorError && e.kind === 'network')) {
      return failed(`Update of ${info.name} to ${toVersion} failed: ${errMsg(e)}. ${restoreHint(backupName)}`, backupName, { after: clear });
    }
    // Connection dropped (restart/reboot in progress): verification decides.
  }

  // 3. Verify.
  deps.state.save({ ...base, phase: 'verifying' });
  return finishVerify(deps, { ...base, phase: 'verifying' });
}

interface Suggestion {
  uuid: string;
  type: string;
  context?: string;
  reference?: string | null;
}

/** uuids of the Supervisor's current suggestions ([] when unknown). */
async function suggestionIds(sup: SupervisorApi): Promise<string[]> {
  try {
    const info = await sup.get<{ suggestions?: Suggestion[] }>('/resolution/info');
    return (info.suggestions ?? []).map((s) => s.uuid);
  } catch {
    return [];
  }
}

/**
 * Restart/reboot suggestions the Supervisor raised (GET /resolution/info). Only `execute_restart`, and
 * `execute_reboot` right after our own OS update (unless we already rebooted for it) or one that is NEW
 * since an update.* entity update (`preSuggestions`: e.g. Pi firmware), are followed; anything else is
 * reported, not applied.
 */
export async function restartSuggestions(
  sup: SupervisorApi,
  target: string,
  rebooted = false,
  preSuggestions?: readonly string[],
): Promise<{ apply: Suggestion[]; skipped: Suggestion[] }> {
  try {
    const info = await sup.get<{ suggestions?: Suggestion[] }>('/resolution/info');
    const relevant = (info.suggestions ?? []).filter((s) => s.type === 'execute_restart' || s.type === 'execute_reboot');
    const rebootOk = (s: Suggestion) => (target === 'os' ? !rebooted : preSuggestions !== undefined && !preSuggestions.includes(s.uuid));
    const ok = (s: Suggestion) => /^[0-9a-f]{32}$/.test(s.uuid) && (s.type === 'execute_restart' || rebootOk(s));
    return { apply: relevant.filter(ok), skipped: relevant.filter((s) => !ok(s)) };
  } catch (e) {
    log.debug('GET /resolution/info failed', { error: errMsg(e) });
    return { apply: [], skipped: [] };
  }
}

/**
 * Reboot the host through the Supervisor's `execute_reboot` suggestion (no host power endpoint is
 * allowlisted). False when there is no such suggestion. A dropped connection means the reboot started.
 */
export async function requestReboot(sup: SupervisorApi): Promise<boolean> {
  const info = await sup.get<{ suggestions?: Suggestion[] }>('/resolution/info');
  const sg = (info.suggestions ?? []).find((s) => s.type === 'execute_reboot' && /^[0-9a-f]{32}$/.test(s.uuid));
  if (!sg) return false;
  log.info('Rebooting the host to boot the installed OS version', { suggestion: sg.uuid });
  try {
    await sup.post(`/resolution/suggestion/${sg.uuid}`, {}, { timeoutMs: 10 * 60 * 1000 });
  } catch (e) {
    if (!(e instanceof SupervisorError && e.kind === 'network')) throw e;
  }
  return true;
}

/** A Repairs issue asking for an HA restart (HACS: `restart_required` after an integration update). */
export const isRestartIssue = (i: HaIssue) =>
  i.ignored !== true && (/restart_required/i.test(i.issue_id) || /restart_required/i.test(i.translation_key ?? ''));

/** OS still on the old version after our update, with the new one installed: wait this long, then reboot once. */
export const OS_REBOOT_GRACE_MS = 3 * 60 * 1000;

const describeSuggestion = (s: Suggestion) => `${s.type}${s.context ? ` (${s.context}${s.reference ? ` ${s.reference}` : ''})` : ''}`;

async function finishVerify(deps: UpdateDeps, s: UpdateState): Promise<ExecResult> {
  const clear = async () => deps.state.clear();
  const t = parseTarget(s.target);
  if (!t) return failed(`Unknown update target '${s.target}'`, s.backupName, { after: clear });
  const budget = (deps.verifyTimeoutMs ?? defaultVerifyTimeoutMs)(s.target);
  const deadline = deps.now() + budget;
  const pollMs = deps.pollMs ?? 15_000;
  let started = false;
  let rebooted = s.rebootRequested; // asked (or tried) once: never again
  let rebootDone = s.rebootRequested;
  let pendingSince: number | null = null;
  let last: Health = { ok: false, detail: 'not checked' };
  do {
    // The first probe right after an update is pointless (restarts take a moment): wait one interval.
    await deps.sleep(pollMs);
    last = await checkHealthy(deps.sup, t, s.toVersion, s.requireStarted);
    if (!last.ok && t === 'os' && !rebooted) {
      // Installed, but the host did not reboot into it: after a grace period, reboot once.
      const pending = await deps.sup.get<OsInfo>('/os/info').then(osPendingVersion, () => null);
      if (pending && versionAtLeast(pending, s.toVersion)) {
        pendingSince ??= deps.now();
        if (deps.now() - pendingSince >= OS_REBOOT_GRACE_MS) {
          rebooted = true;
          deps.state.save({ ...s, rebootRequested: true });
          try {
            rebootDone = await requestReboot(deps.sup);
            if (!rebootDone) log.warn('OS update installed but there is no reboot suggestion to apply', { version: pending });
          } catch (e) {
            log.warn('Requesting the reboot failed', { error: errMsg(e) });
          }
        }
      }
    }
    if (!last.ok && last.addonDown && !started && isAddon(t)) {
      // Updated but not running: start it once.
      started = true;
      log.warn('Add-on did not come back after its update; starting it once', { slug: t.addon });
      try {
        await deps.sup.post(`/addons/${t.addon}/start`, {}, { timeoutMs: 5 * 60 * 1000 });
      } catch (e) {
        log.warn('Starting the add-on failed', { slug: t.addon, error: errMsg(e) });
      }
    }
  } while (!last.ok && deps.now() < deadline);

  if (!last.ok) {
    return failed(
      `Update of ${s.target} to ${s.toVersion} could not be verified healthy within ${Math.round(budget / 60000)} min (${last.detail}). ${restoreHint(s.backupName)}`,
      s.backupName,
      { after: clear },
    );
  }

  const sugg = await restartSuggestions(deps.sup, s.target, rebooted, s.preSuggestions);
  // HACS integrations need an HA restart to load; skipped when a Supervisor restart/reboot covers it.
  const restartHa =
    isEntity(t) && deps.ha !== undefined && sugg.apply.length === 0 && (await deps.ha.listIssues().then((l) => l.some(isRestartIssue), () => false));
  let note = started ? ' Started it once after the update.' : '';
  if (rebootDone) note += ' Rebooted once to boot it.';
  if (sugg.apply.length) note += ` Supervisor suggested ${sugg.apply.map(describeSuggestion).join(', ')}; applied once.`;
  if (sugg.skipped.length) note += ` Supervisor suggests ${sugg.skipped.map(describeSuggestion).join(', ')}; not applied automatically.`;
  if (restartHa) note += ' Home Assistant asked for a restart; restarted it once.';
  return {
    status: 'done',
    result: `Updated ${s.target} ${s.fromVersion} -> ${s.toVersion}. Backup '${s.backupName}' created first; ${last.detail}.${note}`.slice(0, 2000),
    error: null,
    backupName: s.backupName,
    after: async () => {
      deps.state.clear();
      // After the lock is gone and the outcome is recorded: a reboot here must not leave a stale lock.
      for (const sg of sugg.apply) {
        log.info('Applying Supervisor suggestion after our update', { target: s.target, suggestion: describeSuggestion(sg) });
        try {
          await deps.sup.post(`/resolution/suggestion/${sg.uuid}`, {}, { timeoutMs: 10 * 60 * 1000 });
        } catch (e) {
          if (!(e instanceof SupervisorError && e.kind === 'network')) log.warn('Applying the suggestion failed', { error: errMsg(e) });
        }
      }
      if (restartHa) {
        log.info('Restarting Home Assistant after our update (restart required)', { target: s.target });
        try {
          await deps.sup.post('/core/restart', {}, { timeoutMs: 10 * 60 * 1000 });
        } catch (e) {
          if (!(e instanceof SupervisorError && e.kind === 'network')) log.warn('Restarting Home Assistant failed', { error: errMsg(e) });
        }
      }
    },
  };
}

/** On startup: finish an update the process did not see through (restart, reboot, crash). */
export async function resumeUpdate(deps: UpdateDeps, s: UpdateState): Promise<ExecResult> {
  const clear = async () => deps.state.clear();
  if (s.phase === 'backup') {
    // We died while the backup ran; the update call never happened.
    return failed(`Interrupted while taking backup '${s.backupName}' (the add-on restarted). The update of ${s.target} to ${s.toVersion} was NOT attempted.`, null, {
      after: clear,
    });
  }
  // 'updating': the call may or may not have gone through; verification decides (it fails if the
  // version never changes). 'verifying': carry on.
  const next: UpdateState = { ...s, phase: 'verifying' };
  deps.state.save(next);
  return finishVerify(deps, next);
}
