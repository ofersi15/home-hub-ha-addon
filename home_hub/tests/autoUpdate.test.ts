import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyHumanResets,
  BACKOFF_MS,
  emptyHistory,
  historyStore,
  inBackoff,
  inWindow,
  isBlocked,
  pickAutoUpdate,
  protectedBackups,
  recordOutcome,
  updateRank,
  type PickInput,
  type UpdateCandidate,
} from '../src/autoUpdate.js';
import { HomeSettings } from '../src/contract.js';

// 2026-10-22 is EDT (UTC-4): 07:30Z = 03:30 NY.
const at = (utc: string) => Date.parse(utc);

describe('inWindow (America/New_York)', () => {
  const w = { start: '03:00', end: '05:00' };
  it('is inclusive at start, exclusive at end', () => {
    expect(inWindow(at('2026-10-22T06:59:00Z'), w)).toBe(false); // 02:59
    expect(inWindow(at('2026-10-22T07:00:00Z'), w)).toBe(true); // 03:00
    expect(inWindow(at('2026-10-22T08:59:00Z'), w)).toBe(true); // 04:59
    expect(inWindow(at('2026-10-22T09:00:00Z'), w)).toBe(false); // 05:00
  });
  it('uses NY time across DST (EST in December: UTC-5)', () => {
    expect(inWindow(at('2026-12-10T08:30:00Z'), w)).toBe(true); // 03:30 EST
    expect(inWindow(at('2026-12-10T07:30:00Z'), w)).toBe(false); // 02:30 EST
  });
  it('handles windows that wrap midnight', () => {
    const night = { start: '23:00', end: '02:00' };
    expect(inWindow(at('2026-10-23T03:30:00Z'), night)).toBe(true); // 23:30
    expect(inWindow(at('2026-10-23T05:00:00Z'), night)).toBe(true); // 01:00
    expect(inWindow(at('2026-10-23T06:30:00Z'), night)).toBe(false); // 02:30
  });
  it('empty or malformed windows never match', () => {
    expect(inWindow(at('2026-10-22T07:30:00Z'), { start: '03:00', end: '03:00' })).toBe(false);
    expect(inWindow(at('2026-10-22T07:30:00Z'), { start: '3am', end: '05:00' })).toBe(false);
  });
});

const SELF = 'd7b51f8a_home_hub';
const inside = at('2026-10-22T07:30:00Z'); // 03:30 NY
const outside = at('2026-10-22T16:00:00Z'); // 12:00 NY

const all: UpdateCandidate[] = [
  { target: 'os', latest: '16.3', updateAvailable: true },
  { target: 'core', latest: '2026.11.0', updateAvailable: true },
  { target: SELF, latest: '0.3.0', updateAvailable: true },
  { target: 'supervisor', latest: '2026.11.0', updateAvailable: true },
  { target: 'core_mosquitto', latest: '6.5.0', updateAvailable: true },
  { target: 'a0d7b954_vscode', latest: '5.1.0', updateAvailable: false },
];

function input(over: Partial<PickInput> & { autoUpdate?: Record<string, boolean>; mode?: 'immediate' | 'window' } = {}): PickInput {
  const { autoUpdate, mode, ...rest } = over;
  return {
    settings: HomeSettings.parse({ autoUpdate: autoUpdate ?? { '*': true, core: true, os: true, supervisor: true }, autoUpdateMode: mode ?? 'window' }),
    candidates: all,
    nowMs: inside,
    history: emptyHistory(),
    selfSlug: SELF,
    locked: false,
    ...rest,
  };
}

/** Drain the picker as the engine does: one at a time, each success removes that update. */
function drain(i: PickInput): string[] {
  const order: string[] = [];
  let candidates = i.candidates;
  for (;;) {
    const p = pickAutoUpdate({ ...i, candidates });
    if (!p) return order;
    order.push(p.target);
    candidates = candidates.filter((c) => c.target !== p.target);
  }
}

describe('pickAutoUpdate: ordering', () => {
  it('add-ons first, then supervisor, core, os; never this add-on itself', () => {
    expect(drain(input())).toEqual(['core_mosquitto', 'supervisor', 'core', 'os']);
  });
  it('rank puts this add-on last', () => {
    expect(['os', SELF, 'core', 'x', 'supervisor'].sort((a, b) => updateRank(a, SELF) - updateRank(b, SELF))).toEqual(['x', 'supervisor', 'core', 'os', SELF]);
  });
  it("'*' covers add-ons but never core/os/supervisor; an explicit false wins over '*'", () => {
    expect(drain(input({ autoUpdate: { '*': true } }))).toEqual(['core_mosquitto']);
    expect(drain(input({ autoUpdate: { '*': true, core_mosquitto: false, core: true } }))).toEqual(['core']);
    expect(drain(input({ autoUpdate: {} }))).toEqual([]);
  });
});

describe('pickAutoUpdate: immediate vs window', () => {
  it('window mode: only inside the window', () => {
    expect(pickAutoUpdate(input({ nowMs: outside }))).toBeNull();
    expect(pickAutoUpdate(input({ nowMs: inside }))?.target).toBe('core_mosquitto');
  });
  it('immediate mode: any time of day', () => {
    expect(pickAutoUpdate(input({ nowMs: outside, mode: 'immediate' }))?.target).toBe('core_mosquitto');
  });
  it('nothing while the update lock is held', () => {
    expect(pickAutoUpdate(input({ mode: 'immediate', locked: true }))).toBeNull();
  });
  it('skips targets the caller paused', () => {
    expect(pickAutoUpdate(input({ skip: new Set(['core_mosquitto']) }))?.target).toBe('supervisor');
  });
});

describe('failures: 6 h backoff and 2-strike block', () => {
  it('one failure backs off 6 h, then retries; a second failure blocks until a human re-enables', () => {
    const h = emptyHistory();
    const t0 = inside;
    recordOutcome(h, 'core_mosquitto', false, t0, 'hub-pre-update-core_mosquitto-6.5.0-x');
    expect(inBackoff(h, 'core_mosquitto', t0 + BACKOFF_MS - 1)).toBe(true);
    expect(pickAutoUpdate(input({ history: h, mode: 'immediate', nowMs: t0 + 60_000 }))?.target).toBe('supervisor');
    expect(pickAutoUpdate(input({ history: h, mode: 'immediate', nowMs: t0 + BACKOFF_MS }))?.target).toBe('core_mosquitto');

    recordOutcome(h, 'core_mosquitto', false, t0 + BACKOFF_MS, null);
    expect(isBlocked(h, 'core_mosquitto')).toBe(true);
    expect(pickAutoUpdate(input({ history: h, mode: 'immediate', nowMs: t0 + 30 * 24 * 3600_000 }))?.target).toBe('supervisor');
    // The backup named in the alert is protected from retention while the failure is open.
    expect(protectedBackups(h)).toEqual(['hub-pre-update-core_mosquitto-6.5.0-x']);
  });

  it('a success resets the count', () => {
    const h = emptyHistory();
    recordOutcome(h, 'core', false, inside, null);
    recordOutcome(h, 'core', true, inside + 1, null);
    recordOutcome(h, 'core', false, inside + 2, null);
    expect(isBlocked(h, 'core')).toBe(false);
  });

  it('Retry newer than the last failure unblocks; an older Retry does not', () => {
    const h = emptyHistory();
    recordOutcome(h, 'core', false, inside, null);
    recordOutcome(h, 'core', false, inside + 1000, null);
    const settings = (retryAt: string) => HomeSettings.parse({ autoUpdate: { core: true }, autoUpdateRetry: { core: retryAt } });
    expect(applyHumanResets(h, settings(new Date(inside - 60_000).toISOString()))).toEqual([]);
    expect(isBlocked(h, 'core')).toBe(true);
    expect(applyHumanResets(h, settings(new Date(inside + 60_000).toISOString()))).toEqual(['core']);
    expect(isBlocked(h, 'core')).toBe(false);
  });

  it('switching auto-update off for a target also clears it', () => {
    const h = emptyHistory();
    recordOutcome(h, 'os', false, inside, null);
    recordOutcome(h, 'os', false, inside, null);
    expect(applyHumanResets(h, HomeSettings.parse({ autoUpdate: { os: false } }))).toEqual(['os']);
  });

  it('history persists, and a 0.1.0 attempted-list file starts fresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-hist-'));
    const st = historyStore(dir);
    const h = st.load();
    recordOutcome(h, 'core', false, 123, 'b');
    h.lastRetentionAt = 456;
    st.save(h);
    expect(historyStore(dir).load()).toEqual({ targets: { core: { failures: 1, lastFailureAt: 123, backupName: 'b' } }, lastRetentionAt: 456 });
    writeFileSync(join(dir, 'autoupdate.json'), JSON.stringify(['a0d7b954_vscode@5.1.0']));
    expect(historyStore(dir).load()).toEqual(emptyHistory());
  });
});
