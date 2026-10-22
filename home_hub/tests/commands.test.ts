import { describe, expect, it, vi } from 'vitest';
import { CommandProcessor, backupNameFor, isSensitiveCommand, serviceData, validateCommand, type ValidationCtx } from '../src/commands.js';
import { HomeCommand, HomeSettings, PATHS } from '../src/contract.js';
import type { HaApi } from '../src/haWs.js';
import type { UpdateDeps } from '../src/updateFlow.js';
import { FakeStore, FakeSupervisor, fakeTime } from './fakes.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const settings = HomeSettings.parse({
  entities: ['light.kitchen', 'lock.front_door', 'cover.garage', 'cover.blinds', 'cover.mystery'],
  services: ['light.turn_on', 'lock.unlock', 'cover.open_cover'],
});
const classes: Record<string, string> = { 'cover.garage': 'garage', 'cover.blinds': 'blind' };

function cmd(over: Partial<HomeCommand> = {}): HomeCommand {
  return HomeCommand.parse({
    kind: 'call_service',
    service: 'light.turn_on',
    entityId: 'light.kitchen',
    status: 'approved',
    requestedBy: 'user:arielle',
    createdAt: new Date(NOW - 60_000).toISOString(),
    ...over,
  });
}

const ctx = (over: Partial<ValidationCtx> = {}): ValidationCtx => ({
  settings,
  deviceClassOf: (id) => classes[id] ?? null,
  nowMs: NOW,
  selfSlug: 'abc123_home_hub',
  ...over,
});

describe('validateCommand: allowlists', () => {
  it('accepts an allowlisted service on an allowlisted entity', () => {
    expect(validateCommand(cmd(), ctx())).toEqual({ ok: true });
  });
  it('rejects a service that is not allowlisted', () => {
    const v = validateCommand(cmd({ service: 'light.turn_off' }), ctx());
    expect(v).toMatchObject({ ok: false, status: 'rejected' });
  });
  it('rejects an entity that is not allowlisted', () => {
    const v = validateCommand(cmd({ entityId: 'light.bedroom' }), ctx());
    expect(v).toMatchObject({ ok: false, status: 'rejected' });
    if (!v.ok) expect(v.error).toContain('light.bedroom');
  });
  it('rejects call_service without entity', () => {
    expect(validateCommand(cmd({ entityId: null }), ctx()).ok).toBe(false);
  });
});

describe('validateCommand: sensitive needs a human approval', () => {
  it('refuses lock.unlock without approvedBy even though allowlisted', () => {
    const v = validateCommand(cmd({ service: 'lock.unlock', entityId: 'lock.front_door' }), ctx());
    expect(v).toMatchObject({ ok: false, status: 'rejected' });
  });
  it('refuses a sensitive command approved only by an agent/system', () => {
    const v = validateCommand(cmd({ service: 'lock.unlock', entityId: 'lock.front_door', approvedBy: 'agent:muse' }), ctx());
    expect(v.ok).toBe(false);
  });
  it('allows it with a household approval', () => {
    const v = validateCommand(cmd({ service: 'lock.unlock', entityId: 'lock.front_door', approvedBy: 'user:ofer', approvedAt: new Date(NOW).toISOString() }), ctx());
    expect(v.ok).toBe(true);
  });
  it('garage cover is sensitive, blinds are not, unknown cover class is treated as sensitive', () => {
    const dc = (id: string) => classes[id] ?? null;
    expect(isSensitiveCommand(cmd({ service: 'cover.open_cover', entityId: 'cover.garage' }), dc)).toBe(true);
    expect(isSensitiveCommand(cmd({ service: 'cover.open_cover', entityId: 'cover.blinds' }), dc)).toBe(false);
    expect(isSensitiveCommand(cmd({ service: 'cover.open_cover', entityId: 'cover.mystery' }), dc)).toBe(true);
    expect(validateCommand(cmd({ service: 'cover.open_cover', entityId: 'cover.blinds' }), ctx()).ok).toBe(true);
    expect(validateCommand(cmd({ service: 'cover.open_cover', entityId: 'cover.garage' }), ctx()).ok).toBe(false);
  });
  it('honours the sensitive flag set by the Hub', () => {
    expect(validateCommand(cmd({ sensitive: true }), ctx()).ok).toBe(false);
    expect(validateCommand(cmd({ sensitive: true, approvedBy: 'user:arielle' }), ctx()).ok).toBe(true);
  });
});

describe('validateCommand: expiry and kinds', () => {
  it('expires commands older than 10 minutes', () => {
    const v = validateCommand(cmd({ createdAt: new Date(NOW - 11 * 60_000).toISOString() }), ctx());
    expect(v).toMatchObject({ ok: false, status: 'expired' });
  });
  it('counts from approval time when a command waited for approval', () => {
    const v = validateCommand(
      cmd({ createdAt: new Date(NOW - 60 * 60_000).toISOString(), approvedAt: new Date(NOW - 2 * 60_000).toISOString(), approvedBy: 'user:ofer' }),
      ctx(),
    );
    expect(v.ok).toBe(true);
  });
  it('core/os/supervisor updates need Ofer', () => {
    const base = { kind: 'update' as const, service: null, entityId: null, target: 'core' };
    expect(validateCommand(cmd({ ...base }), ctx()).ok).toBe(false);
    expect(validateCommand(cmd({ ...base, approvedBy: 'user:arielle' }), ctx()).ok).toBe(false);
    expect(validateCommand(cmd({ ...base, approvedBy: 'user:ofer' }), ctx()).ok).toBe(true);
    expect(validateCommand(cmd({ ...base, target: 'a0d7b954_vscode' }), ctx()).ok).toBe(true);
    expect(validateCommand(cmd({ ...base, target: '../host' }), ctx()).ok).toBe(false);
  });
  it('restart_addon refuses self and platform targets', () => {
    const base = { kind: 'restart_addon' as const, service: null, entityId: null };
    expect(validateCommand(cmd({ ...base, target: 'local_threadfin' }), ctx()).ok).toBe(true);
    expect(validateCommand(cmd({ ...base, target: 'abc123_home_hub' }), ctx()).ok).toBe(false);
    expect(validateCommand(cmd({ ...base, target: 'core' }), ctx()).ok).toBe(false);
    expect(validateCommand(cmd({ ...base, target: null }), ctx()).ok).toBe(false);
  });
});

describe('helpers', () => {
  it('strips retargeting keys from service data', () => {
    expect(serviceData({ brightness: 100, entity_id: 'lock.front_door', area_id: 'x', device_id: 'y' })).toEqual({ brightness: 100 });
  });
  it('names manual backups hub-<NY date>-<reason>', () => {
    expect(backupNameFor(Date.parse('2026-10-22T02:00:00Z'), 'Before Trip!')).toBe('hub-2026-10-21-before-trip');
    expect(backupNameFor(NOW, null)).toBe('hub-2026-10-22-manual');
  });
});

function setup() {
  const store = new FakeStore();
  const sup = new FakeSupervisor();
  const time = fakeTime(NOW);
  const calls: unknown[][] = [];
  const ha: HaApi = {
    callService: async (...args) => {
      calls.push(args);
    },
    getStates: async () => [],
    getRegistry: async () => ({ areas: [], devices: [], entities: [] }),
  };
  const update: UpdateDeps = { sup, sleep: time.sleep, now: time.now, saveInflight: vi.fn(), clearInflight: vi.fn(), pollMs: 1000 };
  const proc = new CommandProcessor({
    store,
    ha,
    sup,
    update,
    settings: () => settings,
    deviceClassOf: (id) => classes[id] ?? null,
    selfSlug: () => 'abc123_home_hub',
    now: time.now,
  });
  return { store, sup, time, calls, proc };
}

describe('CommandProcessor', () => {
  it('claims, runs and completes an approved command', async () => {
    const { store, calls, proc } = setup();
    store.docs.set(PATHS.homeCommand('c1'), { ...cmd({ data: { brightness: 80, entity_id: 'lock.front_door' } }) });
    proc.onApproved(['c1']);
    await proc.idle();
    expect(calls).toEqual([['light', 'turn_on', { brightness: 80 }, 'light.kitchen']]);
    const doc = store.docs.get(PATHS.homeCommand('c1'));
    expect(doc).toMatchObject({ status: 'done', error: null });
    expect(doc?.claimedAt).toBeTypeOf('string');
    expect(doc?.finishedAt).toBeTypeOf('string');
    const statuses = store.writes.filter((w) => w.op === 'update').map((w) => w.data?.status);
    expect(statuses).toEqual(['claimed', 'done']);
  });

  it('marks stale commands expired without running them', async () => {
    const { store, calls, proc } = setup();
    store.docs.set(PATHS.homeCommand('c2'), { ...cmd({ createdAt: new Date(NOW - 20 * 60_000).toISOString() }) });
    proc.onApproved(['c2']);
    await proc.idle();
    expect(calls).toHaveLength(0);
    expect(store.docs.get(PATHS.homeCommand('c2'))).toMatchObject({ status: 'expired' });
  });

  it('refuses a sensitive entity without approval (claim -> failed with reason) and never calls HA', async () => {
    const { store, calls, proc } = setup();
    store.docs.set(PATHS.homeCommand('c3'), { ...cmd({ service: 'lock.unlock', entityId: 'lock.front_door' }) });
    proc.onApproved(['c3']);
    await proc.idle();
    expect(calls).toHaveLength(0);
    expect(store.docs.get(PATHS.homeCommand('c3'))).toMatchObject({ status: 'failed' });
    expect(String(store.docs.get(PATHS.homeCommand('c3'))?.error)).toContain('Refused by the add-on');
    // Only transitions the Hub rules allow: approved -> claimed -> failed.
    expect(store.writes.filter((w) => w.op === 'update').map((w) => w.data?.status)).toEqual(['claimed', 'failed']);
  });

  it('a command flagged sensitive without a human approval is never claimed (closed as expired)', async () => {
    const { store, calls, proc } = setup();
    store.docs.set(PATHS.homeCommand('c5'), { ...cmd({ service: 'lock.unlock', entityId: 'lock.front_door', sensitive: true, approvedBy: 'agent:muse' }) });
    proc.onApproved(['c5']);
    await proc.idle();
    expect(calls).toHaveLength(0);
    expect(store.writes.filter((w) => w.op === 'update').map((w) => w.data?.status)).toEqual(['expired']);
    expect(String(store.docs.get(PATHS.homeCommand('c5'))?.error)).toContain('Refused by the add-on');
  });

  it('refuses off-contract docs and skips non-approved ones', async () => {
    const { store, calls, proc } = setup();
    store.docs.set(PATHS.homeCommand('bad'), { kind: 'shell', status: 'approved', command: 'reboot' });
    store.docs.set(PATHS.homeCommand('done'), { ...cmd(), status: 'done' });
    proc.onApproved(['bad', 'done', 'missing']);
    await proc.idle();
    expect(calls).toHaveLength(0);
    expect(store.docs.get(PATHS.homeCommand('bad'))).toMatchObject({ status: 'failed' });
    expect(store.docs.get(PATHS.homeCommand('done'))).toMatchObject({ status: 'done' });
  });

  it('restart_addon posts only that add-on restart', async () => {
    const { store, sup, proc } = setup();
    sup.posts.set('/addons/local_threadfin/restart', {});
    store.docs.set(PATHS.homeCommand('r1'), { ...cmd({ kind: 'restart_addon', service: null, entityId: null, target: 'local_threadfin' }) });
    proc.onApproved(['r1']);
    await proc.idle();
    expect(sup.posted()).toEqual(['/addons/local_threadfin/restart']);
    expect(store.docs.get(PATHS.homeCommand('r1'))).toMatchObject({ status: 'done' });
  });

  it('auto-update creates an audited command as system:addon, then runs it', async () => {
    const { store, sup, proc } = setup();
    sup.gets.set('/addons/a0d7b954_vscode/info', { name: 'Studio Code Server', version: '5.0.0', version_latest: '5.1.0', update_available: false });
    const res = await proc.runLocalUpdate('a0d7b954_vscode');
    expect(res?.status).toBe('done');
    const added = store.writes.find((w) => w.op === 'add');
    expect(added?.path).toMatch(/^hub\/main\/homeCommands\//);
    expect(added?.data).toMatchObject({ kind: 'update', target: 'a0d7b954_vscode', requestedBy: 'system:addon', status: 'claimed' });
  });

  it('auto-update does nothing if the command cannot be recorded (audit first)', async () => {
    const { store, sup, proc } = setup();
    store.failAdd = true;
    const res = await proc.runLocalUpdate('a0d7b954_vscode');
    expect(res).toBeNull();
    expect(sup.calls).toHaveLength(0);
  });

  it('auto-update never touches core', async () => {
    const { store, sup, proc } = setup();
    const res = await proc.runLocalUpdate('core');
    expect(res).toBeNull();
    expect(sup.calls).toHaveLength(0);
    expect(store.writes).toHaveLength(0);
  });
});
