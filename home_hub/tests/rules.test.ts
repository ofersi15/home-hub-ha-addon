import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HomeEventRule } from '../src/contract.js';
import { RuleEngine } from '../src/rules.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-22T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const door = HomeEventRule.parse({ id: 'door-open', name: 'Door left open', entityId: 'binary_sensor.front_door', toState: 'on', forMinutes: 10, action: 'notify', message: 'Front door open 10 min' });
const washer = HomeEventRule.parse({ id: 'washer', name: 'Washer done', entityId: 'sensor.washer_state', toState: 'idle', action: 'task', message: 'Move laundry' });

function engine() {
  const fired: { ruleId: string; state: string; at: number }[] = [];
  const e = new RuleEngine((r, _id, state, at) => fired.push({ ruleId: r.id, state, at }), Date.now);
  e.setRules([door, washer]);
  return { e, fired };
}

describe('RuleEngine', () => {
  it('fires immediately for forMinutes = 0 on entering the state, not on attribute-only changes', () => {
    const { e, fired } = engine();
    e.onStateChange('sensor.washer_state', 'running', 'idle');
    e.onStateChange('sensor.washer_state', 'idle', 'idle');
    expect(fired.map((f) => f.ruleId)).toEqual(['washer']);
  });

  it('fires after forMinutes when the state holds', async () => {
    const { e, fired } = engine();
    e.onStateChange('binary_sensor.front_door', 'off', 'on');
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(fired).toHaveLength(0);
    e.onStateChange('binary_sensor.front_door', 'on', 'on'); // attribute change must not reset the timer
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fired).toEqual([{ ruleId: 'door-open', state: 'on', at: Date.parse('2026-10-22T12:10:00Z') }]);
  });

  it('cancels the timer when the state changes away', async () => {
    const { e, fired } = engine();
    e.onStateChange('binary_sensor.front_door', 'off', 'on');
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    e.onStateChange('binary_sensor.front_door', 'on', 'off');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fired).toHaveLength(0);
    expect(e.pendingTimers()).toBe(0);
  });

  it('seeding arms only the remaining time and does not double-fire old states', async () => {
    const { e, fired } = engine();
    e.seed([
      { entityId: 'binary_sensor.front_door', state: 'on', lastChangedMs: Date.now() - 7 * 60_000 },
      { entityId: 'sensor.washer_state', state: 'idle', lastChangedMs: Date.now() - 60_000 },
    ]);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(fired.map((f) => f.ruleId)).toEqual(['door-open']);
    const { e: e2, fired: f2 } = engine();
    e2.seed([{ entityId: 'binary_sensor.front_door', state: 'on', lastChangedMs: Date.now() - 60 * 60_000 }]);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(f2).toHaveLength(0);
  });

  it('disabling or changing a rule clears its timer', async () => {
    const { e, fired } = engine();
    e.onStateChange('binary_sensor.front_door', 'off', 'on');
    e.setRules([{ ...door, enabled: false }, washer]);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fired).toHaveLength(0);
    expect(e.pendingTimers()).toBe(0);
  });
});
