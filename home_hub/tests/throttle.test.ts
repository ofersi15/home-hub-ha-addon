import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EntityMirror } from '../src/mirror.js';
import { CoalescingThrottle } from '../src/throttle.js';
import { FakeStore } from './fakes.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

describe('CoalescingThrottle', () => {
  it('writes the first value immediately, then at most once per interval with the latest value', async () => {
    const flushed: [string, number][] = [];
    const t = new CoalescingThrottle<number>(5000, (k, v) => void flushed.push([k, v]), Date.now);
    t.push('a', 1);
    expect(flushed).toEqual([['a', 1]]);
    t.push('a', 2);
    t.push('a', 3);
    t.push('a', 4);
    await vi.advanceTimersByTimeAsync(4999);
    expect(flushed).toEqual([['a', 1]]);
    await vi.advanceTimersByTimeAsync(1);
    expect(flushed).toEqual([
      ['a', 1],
      ['a', 4],
    ]);
    // Quiet afterwards: nothing else is written.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(flushed).toHaveLength(2);
  });

  it('keys are independent', async () => {
    const flushed: string[] = [];
    const t = new CoalescingThrottle<number>(5000, (k, v) => void flushed.push(`${k}=${v}`), Date.now);
    t.push('a', 1);
    t.push('b', 1);
    t.push('a', 2);
    expect(flushed).toEqual(['a=1', 'b=1']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(flushed).toEqual(['a=1', 'b=1', 'a=2']);
  });

  it('after a quiet period a new value goes out immediately', async () => {
    const flushed: number[] = [];
    const t = new CoalescingThrottle<number>(5000, (_k, v) => void flushed.push(v), Date.now);
    t.push('a', 1);
    await vi.advanceTimersByTimeAsync(6000);
    t.push('a', 2);
    expect(flushed).toEqual([1, 2]);
  });

  it('cancel drops a pending value; flushAll writes pending values now', async () => {
    const flushed: string[] = [];
    const t = new CoalescingThrottle<number>(5000, (k, v) => void flushed.push(`${k}=${v}`), Date.now);
    t.push('a', 1);
    t.push('b', 1);
    t.push('a', 2);
    t.push('b', 2);
    t.cancel('a');
    await t.flushAll();
    expect(flushed).toEqual(['a=1', 'b=1', 'b=2']);
  });
});

describe('EntityMirror throttling', () => {
  const st = (state: string, extra: Record<string, unknown> = {}) => ({
    entity_id: 'sensor.washer_power',
    state,
    attributes: { friendly_name: 'Washer power', unit_of_measurement: 'W', entity_picture: '/api/x?token=secret', ...extra },
    last_changed: '2026-10-22T11:59:00+00:00',
  });

  it('coalesces bursts per entity and only mirrors allowlisted entities', async () => {
    const store = new FakeStore();
    const m = new EntityMirror(store, Date.now, 5000);
    m.setAllowlist(['sensor.washer_power']);
    m.onStateChanged('sensor.washer_power', st('100'));
    m.onStateChanged('sensor.washer_power', st('120'));
    m.onStateChanged('sensor.washer_power', st('3'));
    m.onStateChanged('light.other', { entity_id: 'light.other', state: 'on', attributes: {}, last_changed: '2026-10-22T11:00:00Z' });
    await vi.advanceTimersByTimeAsync(5000);
    const sets = store.writes.filter((w) => w.op === 'set');
    expect(sets.map((w) => [w.path, w.data?.state])).toEqual([
      ['hub/main/homeEntities/sensor.washer_power', '100'],
      ['hub/main/homeEntities/sensor.washer_power', '3'],
    ]);
    expect(sets[0]?.data?.attributes).toEqual({ unit_of_measurement: 'W' });
    expect(sets[0]?.data?.lastChanged).toBe('2026-10-22T11:59:00.000Z');
  });

  it('removing an entity from the allowlist deletes its doc and drops pending writes', async () => {
    const store = new FakeStore();
    const m = new EntityMirror(store, Date.now, 5000);
    m.setAllowlist(['sensor.washer_power']);
    m.onStateChanged('sensor.washer_power', st('1'));
    m.onStateChanged('sensor.washer_power', st('2'));
    m.setAllowlist([]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(store.writes.map((w) => w.op)).toEqual(['set', 'remove']);
  });
});
