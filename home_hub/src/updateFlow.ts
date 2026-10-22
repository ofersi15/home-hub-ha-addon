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
 */
import { createBackup, type BackupSpec } from './backup.js';
import { PLATFORM_TARGETS } from './contract.js';
import { errMsg, logger } from './log.js';
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
}

export type Target = 'core' | 'os' | 'supervisor' | { addon: string };

export function parseTarget(t: string): Target | null {
  if ((PLATFORM_TARGETS as readonly string[]).includes(t)) return t as 'core' | 'os' | 'supervisor';
  return /^[a-z0-9_]+$/.test(t) ? { addon: t } : null;
}

const targetKey = (t: Target) => (typeof t === 'string' ? t : t.addon);

/** Verify budget after the update call: Core/OS 20 min (restart / reboot), Supervisor 10, add-ons 5. */
export function defaultVerifyTimeoutMs(target: string): number {
  if (target === 'core' || target === 'os') return 20 * 60 * 1000;
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

const PLATFORM_NAMES = { core: 'Home Assistant Core', os: 'Home Assistant OS', supervisor: 'Supervisor' } as const;

async function readVersion(sup: SupervisorApi, t: Target): Promise<VersionInfo> {
  const path = typeof t === 'string' ? `/${t}/info` : `/addons/${t.addon}/info`;
  const i = await sup.get<SupInfo>(path);
  const name = typeof t === 'string' ? PLATFORM_NAMES[t] : (i.name ?? t.addon);
  return {
    name,
    installed: i.version ?? 'unknown',
    latest: i.version_latest ?? i.version ?? 'unknown',
    updateAvailable: i.update_available === true,
    ...(i.state !== undefined ? { state: i.state } : {}),
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
    if (typeof t !== 'string' && requireStarted && v.state !== 'started') {
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
  if (!info.updateAvailable) {
    return { status: 'done', result: `${info.name} is already up to date (${info.installed}); nothing to do.`, error: null, backupName: null };
  }

  // Never start while the Supervisor runs a backup or another job.
  const busy = await waitIdle(deps);
  if (busy) return failed(`Supervisor is busy (${busy}); update of ${info.name} was not started.`, null, { transient: true });

  const toVersion = info.latest;
  const backupName = preUpdateBackupName(key, toVersion, deps.now());
  const base: Omit<UpdateState, 'phase'> = {
    target: key,
    fromVersion: info.installed,
    toVersion,
    backupName,
    startedAt: deps.now(),
    commandId,
    requireStarted: typeof t !== 'string' && info.state === 'started',
    auto: opts.auto === true,
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
    await postUpdate(deps.sup, t, toVersion);
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

/**
 * Restart/reboot suggestions the Supervisor raised (GET /resolution/info). Only `execute_restart`, and
 * `execute_reboot` right after our own OS update, are followed; anything else is reported, not applied.
 */
export async function restartSuggestions(sup: SupervisorApi, target: string): Promise<{ apply: Suggestion[]; skipped: Suggestion[] }> {
  try {
    const info = await sup.get<{ suggestions?: Suggestion[] }>('/resolution/info');
    const relevant = (info.suggestions ?? []).filter((s) => s.type === 'execute_restart' || s.type === 'execute_reboot');
    const ok = (s: Suggestion) => /^[0-9a-f]{32}$/.test(s.uuid) && (s.type === 'execute_restart' || target === 'os');
    return { apply: relevant.filter(ok), skipped: relevant.filter((s) => !ok(s)) };
  } catch (e) {
    log.debug('GET /resolution/info failed', { error: errMsg(e) });
    return { apply: [], skipped: [] };
  }
}

const describeSuggestion = (s: Suggestion) => `${s.type}${s.context ? ` (${s.context}${s.reference ? ` ${s.reference}` : ''})` : ''}`;

async function finishVerify(deps: UpdateDeps, s: UpdateState): Promise<ExecResult> {
  const clear = async () => deps.state.clear();
  const t = parseTarget(s.target);
  if (!t) return failed(`Unknown update target '${s.target}'`, s.backupName, { after: clear });
  const budget = (deps.verifyTimeoutMs ?? defaultVerifyTimeoutMs)(s.target);
  const deadline = deps.now() + budget;
  const pollMs = deps.pollMs ?? 15_000;
  let started = false;
  let last: Health = { ok: false, detail: 'not checked' };
  do {
    // The first probe right after an update is pointless (restarts take a moment): wait one interval.
    await deps.sleep(pollMs);
    last = await checkHealthy(deps.sup, t, s.toVersion, s.requireStarted);
    if (!last.ok && last.addonDown && !started && typeof t !== 'string') {
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

  const sugg = await restartSuggestions(deps.sup, s.target);
  let note = started ? ' Started it once after the update.' : '';
  if (sugg.apply.length) note += ` Supervisor suggested ${sugg.apply.map(describeSuggestion).join(', ')}; applied once.`;
  if (sugg.skipped.length) note += ` Supervisor suggests ${sugg.skipped.map(describeSuggestion).join(', ')}; not applied automatically.`;
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
