/**
 * Auto-update policy (settings/home):
 *  - which targets: `autoUpdateEnabled` (platform targets only via their own flag; add-ons via their
 *    own flag or '*');
 *  - when: 'immediate' (whenever the 5-minute Pi poll sees an update) or 'window' (inside
 *    autoUpdateWindow, New York wall clock);
 *  - order: add-ons, then Supervisor, then Core, then OS (this add-on itself is never picked: the
 *    Supervisor forbids an add-on updating itself);
 *  - safety: one at a time (the update lock), 6 h backoff after a failure, blocked after 2 consecutive
 *    failures until a household member presses Retry (settings.autoUpdateRetry[target]).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoUpdateEnabled, type HomeSettings } from './contract.js';
import { nyParts } from './util.js';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const BACKOFF_MS = 6 * 60 * 60 * 1000;
export const MAX_FAILURES = 2;
export const RETENTION_EVERY_MS = 24 * 60 * 60 * 1000;

function toMinutes(s: string): number | null {
  const m = s.match(HHMM);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** True when `nowMs` (NY local time) is in [start, end). Handles windows that wrap midnight. start == end -> never. */
export function inWindow(nowMs: number, window: { start: string; end: string }): boolean {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null || start === end) return false;
  const cur = nyParts(nowMs).minutes;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}


/** Update order: add-ons 0, update.* entities 0.5, supervisor 1, core 2, os 3, this add-on 4 (never auto-picked). */
export function updateRank(target: string, selfSlug: string | null): number {
  if (target === selfSlug) return 4;
  if (target.startsWith('update.')) return 0.5;
  if (target === 'supervisor') return 1;
  if (target === 'core') return 2;
  if (target === 'os') return 3;
  return 0;
}

// ---- failure history (persisted) ----

export interface TargetHistory {
  /** Consecutive auto-update failures. */
  failures: number;
  lastFailureAt: number;
  /** Backup named in the last failure (kept by retention while this entry exists). */
  backupName: string | null;
}

export interface AutoUpdateHistory {
  targets: Record<string, TargetHistory>;
  lastRetentionAt: number | null;
}

export const emptyHistory = (): AutoUpdateHistory => ({ targets: {}, lastRetentionAt: null });

export function isBlocked(h: AutoUpdateHistory, target: string): boolean {
  return (h.targets[target]?.failures ?? 0) >= MAX_FAILURES;
}

export function inBackoff(h: AutoUpdateHistory, target: string, nowMs: number): boolean {
  const e = h.targets[target];
  return e !== undefined && e.failures > 0 && nowMs - e.lastFailureAt < BACKOFF_MS;
}

/** Success resets the target; a failure counts toward the 6 h backoff and the 2-strike block. */
export function recordOutcome(h: AutoUpdateHistory, target: string, ok: boolean, nowMs: number, backupName: string | null): void {
  if (ok) {
    delete h.targets[target];
    return;
  }
  const prev = h.targets[target];
  h.targets[target] = { failures: (prev?.failures ?? 0) + 1, lastFailureAt: nowMs, backupName: backupName ?? prev?.backupName ?? null };
}

/**
 * A human re-enables a target: Retry pressed after the last failure (autoUpdateRetry[target] newer), or
 * auto-update for it switched off. Returns the targets released.
 */
export function applyHumanResets(h: AutoUpdateHistory, settings: Pick<HomeSettings, 'autoUpdate' | 'autoUpdateRetry'>): string[] {
  const released: string[] = [];
  for (const [target, e] of Object.entries(h.targets)) {
    const retry = Date.parse(settings.autoUpdateRetry[target] ?? '');
    if ((Number.isFinite(retry) && retry > e.lastFailureAt) || !autoUpdateEnabled(settings.autoUpdate, target)) {
      delete h.targets[target];
      released.push(target);
    }
  }
  return released;
}

/** Backup names retention must keep (named in failure alerts that are still open). */
export function protectedBackups(h: AutoUpdateHistory): string[] {
  return Object.values(h.targets)
    .map((e) => e.backupName)
    .filter((n): n is string => typeof n === 'string');
}

export function historyStore(dir: string) {
  const file = join(dir, 'autoupdate.json');
  return {
    load(): AutoUpdateHistory {
      try {
        if (!existsSync(file)) return emptyHistory();
        const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<AutoUpdateHistory> | unknown[];
        // 0.1.0 stored an array of attempted "slug@version" strings: start fresh.
        if (Array.isArray(raw) || typeof raw !== 'object' || raw === null) return emptyHistory();
        return { targets: raw.targets ?? {}, lastRetentionAt: raw.lastRetentionAt ?? null };
      } catch {
        return emptyHistory();
      }
    },
    save(h: AutoUpdateHistory): void {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(h));
      renameSync(`${file}.tmp`, file);
    },
  };
}

// ---- picking ----

export interface UpdateCandidate {
  target: string;
  latest: string;
  updateAvailable: boolean;
}

export interface PickInput {
  settings: Pick<HomeSettings, 'autoUpdate' | 'autoUpdateMode' | 'autoUpdateWindow'>;
  candidates: UpdateCandidate[];
  nowMs: number;
  history: AutoUpdateHistory;
  selfSlug: string | null;
  /** The update lock is held (an update is running or being verified). */
  locked: boolean;
  /** Targets to leave alone this round (e.g. the Hub refused the audit doc recently). */
  skip?: ReadonlySet<string>;
}

/** Why a target is not picked (for the Pi status and logs); null = eligible. */
export function ineligible(i: Omit<PickInput, 'candidates' | 'locked'>, c: UpdateCandidate): string | null {
  if (!c.updateAvailable) return 'no update';
  if (c.target === i.selfSlug) return 'self';
  if (!autoUpdateEnabled(i.settings.autoUpdate, c.target)) return 'disabled';
  if (isBlocked(i.history, c.target)) return 'blocked';
  if (inBackoff(i.history, c.target, i.nowMs)) return 'backoff';
  if (i.skip?.has(c.target)) return 'skipped';
  return null;
}

/** The one update to run now, or null. */
export function pickAutoUpdate(i: PickInput): UpdateCandidate | null {
  if (i.locked) return null;
  if (i.settings.autoUpdateMode !== 'immediate' && !inWindow(i.nowMs, i.settings.autoUpdateWindow)) return null;
  const eligible = i.candidates.filter((c) => ineligible(i, c) === null);
  eligible.sort((a, b) => updateRank(a.target, i.selfSlug) - updateRank(b.target, i.selfSlug));
  return eligible[0] ?? null;
}


