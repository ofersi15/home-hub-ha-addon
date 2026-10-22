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

const battery = HomeEventRule.parse({ id: 'blinds-batt', name: 'Blinds battery low', entityId: 'sensor.blinds_battery', below: 20, action: 'notify', message: 'Charge the blinds' });

function numeric(rule = battery) {
  const fired: { ruleId: string; state: string; at: number }[] = [];
  const e = new RuleEngine((r, _id, state, at) => fired.push({ ruleId: r.id, state, at }), Date.now);
  e.setRules([rule]);
  return { e, fired };
}

describe('RuleEngine: numeric `below` rules', () => {
  it('fires when the value drops below, once per episode (repeatHours 0)', async () => {
    const { e, fired } = numeric();
    e.onStateChange('sensor.blinds_battery', '50', '21');
    e.onStateChange('sensor.blinds_battery', '21', '19.5');
    e.onStateChange('sensor.blinds_battery', '19.5', '15');
    e.onStateChange('sensor.blinds_battery', '15', '12');
    await vi.advanceTimersByTimeAsync(7 * 24 * 3600_000);
    expect(fired.map((f) => f.state)).toEqual(['19.5']);
  });

  it('a new episode (back above, then below again) fires again', () => {
    const { e, fired } = numeric();
    e.onStateChange('sensor.blinds_battery', '50', '10');
    e.onStateChange('sensor.blinds_battery', '10', '100'); // charged
    e.onStateChange('sensor.blinds_battery', '100', '18');
    expect(fired.map((f) => f.state)).toEqual(['10', '18']);
  });

  it('unknown / unavailable / non-numbers are ignored (no fire, episode not ended)', () => {
    const { e, fired } = numeric();
    e.onStateChange('sensor.blinds_battery', '50', 'unavailable');
    e.onStateChange('sensor.blinds_battery', 'unavailable', 'unknown');
    expect(fired).toHaveLength(0);
    e.onStateChange('sensor.blinds_battery', 'unknown', '15');
    e.onStateChange('sensor.blinds_battery', '15', 'unavailable');
    e.onStateChange('sensor.blinds_battery', 'unavailable', '14');
    expect(fired.map((f) => f.state)).toEqual(['15']);
  });

  it('repeatHours: re-fires at most once per N hours while the condition holds', async () => {
    const { e, fired } = numeric({ ...battery, repeatHours: 24 });
    e.onStateChange('sensor.blinds_battery', '50', '15');
    await vi.advanceTimersByTimeAsync(23 * 3600_000);
    e.onStateChange('sensor.blinds_battery', '15', '14');
    expect(fired).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(fired.map((f) => f.state)).toEqual(['15', '14']); // repeat reports the latest value
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(fired).toHaveLength(3);
    e.onStateChange('sensor.blinds_battery', '14', '90');
    await vi.advanceTimersByTimeAsync(72 * 3600_000);
    expect(fired).toHaveLength(3);
    expect(e.pendingTimers()).toBe(0);
  });

  it('repeats land in distinct UTC buckets of repeatHours (the Hub dedupes per bucket)', async () => {
    vi.setSystemTime(new Date('2026-10-22T17:43:00Z'));
    const { e, fired } = numeric({ ...battery, repeatHours: 6 });
    e.onStateChange('sensor.blinds_battery', '50', '15');
    await vi.advanceTimersByTimeAsync(5 * 24 * 3600_000);
    const buckets = fired.map((f) => Math.floor(f.at / (6 * 3600_000)));
    expect(fired.length).toBe(21); // first fire + one per 6 h for 5 days
    expect(new Set(buckets).size).toBe(buckets.length);
    for (let i = 1; i < buckets.length; i++) expect(buckets[i]).toBe((buckets[i - 1] as number) + 1);
  });

  it('honors forMinutes for numeric rules', async () => {
    const { e, fired } = numeric({ ...battery, forMinutes: 30 });
    e.onStateChange('sensor.blinds_battery', '50', '15');
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    e.onStateChange('sensor.blinds_battery', '15', '40'); // recovered before 30 min
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fired).toHaveLength(0);
    e.onStateChange('sensor.blinds_battery', '40', '15');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(fired).toHaveLength(1);
  });

  it('seed adopts a low value as already fired (no fire on restart), then repeats a full period later', async () => {
    const { e, fired } = numeric({ ...battery, repeatHours: 12 });
    e.seed([{ entityId: 'sensor.blinds_battery', state: '9', lastChangedMs: Date.now() - 3600_000 }]);
    await vi.advanceTimersByTimeAsync(11 * 3600_000);
    expect(fired).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(3600_000);
    expect(fired).toHaveLength(1);
    // A re-seed (HA reconnect) keeps the episode: no extra fire.
    e.seed([{ entityId: 'sensor.blinds_battery', state: '9', lastChangedMs: Date.now() - 3600_000 }]);
    expect(fired).toHaveLength(1);
  });

  it('toState rules with repeatHours repeat while the state holds', async () => {
    const { e, fired } = numeric(HomeEventRule.parse({ id: 'door', name: 'd', entityId: 'binary_sensor.door', toState: 'on', forMinutes: 10, repeatHours: 1, action: 'notify', message: 'm' }));
    e.onStateChange('binary_sensor.door', 'off', 'on');
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 2 * 3600_000);
    expect(fired).toHaveLength(3);
  });
});
