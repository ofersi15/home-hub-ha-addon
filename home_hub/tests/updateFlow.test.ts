import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SupervisorError } from '../src/supervisor.js';
import { preUpdateBackupName, resumeUpdate, runUpdate, versionAtLeast, type ExecResult, type UpdateDeps } from '../src/updateFlow.js';
import { fileUpdateStateStore, memoryUpdateStateStore, type UpdateState } from '../src/updateState.js';
import { FakeSupervisor, fakeTime } from './fakes.js';

// 2026-10-22T12:00Z = 08:00 in New York (EDT).
const STAMP = '20261022-0800';
const CORE_BACKUP = `hub-pre-update-core-2026.11.0-${STAMP}`;

function deps(sup: FakeSupervisor, initial: UpdateState | null = null) {
  const time = fakeTime();
  const state = memoryUpdateStateStore(initial);
  const d: UpdateDeps = { sup, sleep: time.sleep, now: time.now, state, pollMs: 15_000, jobsWaitMs: 60_000 };
  return { d, time, state };
}

/** Finish like the command processor: (write the doc), then run the follow-up. */
async function settle(res: ExecResult): Promise<ExecResult> {
  await res.after?.();
  return res;
}

function healthyHa(sup: FakeSupervisor) {
  sup.cores.set('/api/', { message: 'API running.' });
  sup.cores.set('/api/config', { state: 'RUNNING' });
  sup.gets.set('/info', { state: 'running', supported: false });
  sup.gets.set('/jobs/info', { ignore_conditions: [], jobs: [{ name: 'old_job', done: true }] });
  sup.gets.set('/resolution/info', { suggestions: [] });
}

/** Core: installed 2026.10.2, update to 2026.11.0; after the update POST it reports `after`. */
function coreScenario(opts: { verifyOk: boolean; after?: string }) {
  const sup = new FakeSupervisor();
  let updated = false;
  sup.gets.set('/core/info', () => ({
    version: updated && opts.verifyOk ? (opts.after ?? '2026.11.0') : '2026.10.2',
    version_latest: '2026.11.0',
    update_available: !(updated && opts.verifyOk),
    state: 'running',
  }));
  sup.posts.set('/backups/new/full', { job_id: 'aaaaaaaa-1111' });
  sup.gets.set('/jobs/aaaaaaaa-1111', { done: true, reference: 'bk123', errors: [] });
  sup.posts.set('/core/update', () => {
    updated = true;
    return {};
  });
  healthyHa(sup);
  return sup;
}

describe('runUpdate', () => {
  it('backup first (named with target, version, NY time), then update, then verify; lock persisted before each step', async () => {
    const sup = coreScenario({ verifyOk: true });
    const { d, state } = deps(sup);
    const phaseAt: Record<string, string | undefined> = {};
    const backupHandler = sup.posts.get('/backups/new/full');
    sup.posts.set('/backups/new/full', () => {
      phaseAt.backup = state.load()?.phase;
      return backupHandler;
    });
    const updateHandler = sup.posts.get('/core/update') as () => unknown;
    sup.posts.set('/core/update', () => {
      phaseAt.update = state.load()?.phase;
      return updateHandler();
    });
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(sup.posted()).toEqual(['/backups/new/full', '/core/update']);
    expect(sup.calls.find((c) => c.path === '/backups/new/full')?.body).toMatchObject({ name: CORE_BACKUP });
    // Our own backup only; the Supervisor's extra pre-update backup is off (retention can't clean it).
    expect(sup.calls.find((c) => c.path === '/core/update')?.body).toEqual({ version: '2026.11.0', backup: false });
    expect(phaseAt).toEqual({ backup: 'backup', update: 'updating' });
    expect(res.status).toBe('done');
    expect(res.backupName).toBe(CORE_BACKUP);
    expect(res.result).toContain(CORE_BACKUP);
    // The lock is held until the outcome is recorded (the caller runs `after`).
    expect(state.load()?.phase).toBe('verifying');
    await settle(res);
    expect(state.load()).toBeNull();
    expect(state.history).toEqual(['backup', 'updating', 'verifying', 'cleared']);
  });

  it('accepts a newer reported version than the one we asked for', async () => {
    const sup = coreScenario({ verifyOk: true, after: '2026.11.1' });
    const { d } = deps(sup);
    expect((await runUpdate(d, 'core', 'c')).status).toBe('done');
  });

  it('a failed verify fails the command, names the backup and says restore from this backup', async () => {
    const sup = coreScenario({ verifyOk: false });
    const { d, state } = deps(sup);
    const res = await settle(await runUpdate(d, 'core', 'cmd1'));
    expect(res.status).toBe('failed');
    expect(res.error).toContain(`Restore from this backup if needed: '${CORE_BACKUP}'`);
    expect(res.error).toContain('20 min');
    expect(res.backupName).toBe(CORE_BACKUP);
    expect(state.load()).toBeNull();
  });

  it('verify fails when HA API is down', async () => {
    const sup = coreScenario({ verifyOk: true });
    sup.cores.set('/api/', () => {
      throw new SupervisorError('core GET /api/: HTTP 502', 'api', 502);
    });
    const { d } = deps(sup);
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(res.status).toBe('failed');
    expect(res.error).toContain(CORE_BACKUP);
  });

  it('verify fails while /core/info is not running', async () => {
    const sup = coreScenario({ verifyOk: true });
    let updated = false;
    sup.gets.set('/core/info', () =>
      updated ? { version: '2026.11.0', state: 'startup' } : { version: '2026.10.2', version_latest: '2026.11.0', update_available: true, state: 'running' },
    );
    sup.posts.set('/core/update', () => {
      updated = true;
      return {};
    });
    const { d } = deps(sup);
    d.verifyTimeoutMs = () => 60_000;
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(res.status).toBe('failed');
    expect(res.error).toContain('Core state is startup');
    expect(res.error).toContain(CORE_BACKUP);
  });

  it('never updates when the backup fails, and alerts with "Backup failed"', async () => {
    const sup = coreScenario({ verifyOk: true });
    sup.gets.set('/jobs/aaaaaaaa-1111', { done: true, errors: [{ message: 'disk full' }] });
    const { d, state } = deps(sup);
    const res = await settle(await runUpdate(d, 'core', 'cmd1'));
    expect(res.status).toBe('failed');
    expect(res.error).toMatch(/^Backup failed/);
    expect(res.error).toContain('NOT attempted');
    expect(res.error).toContain('disk full');
    expect(res.backupName).toBeNull();
    expect(sup.posted()).not.toContain('/core/update');
    expect(state.load()).toBeNull();
  });

  it('an update API error names the backup', async () => {
    const sup = coreScenario({ verifyOk: true });
    sup.posts.set('/core/update', () => {
      throw new SupervisorError('POST /core/update: Update failed', 'api', 400);
    });
    const { d } = deps(sup);
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(res.status).toBe('failed');
    expect(res.error).toContain(`Restore from this backup if needed: '${CORE_BACKUP}'`);
  });

  it('the lock: refuses to start while another update is in flight (no Supervisor writes)', async () => {
    const sup = coreScenario({ verifyOk: true });
    const held: UpdateState = {
      target: 'os',
      fromVersion: '16.2',
      toVersion: '16.3',
      backupName: 'hub-pre-update-os-16.3-20261022-0700',
      phase: 'verifying',
      startedAt: Date.now(),
      commandId: 'other',
      requireStarted: false,
      auto: true,
      rebootRequested: false,
    };
    const { d, state } = deps(sup, held);
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(res).toMatchObject({ status: 'failed', transient: true });
    expect(res.error).toContain('Another update is in progress (os -> 16.3');
    expect(res.after).toBeUndefined(); // must never clear someone else's lock
    expect(sup.posted()).toEqual([]);
    expect(state.load()).toEqual(held);
  });

  it('waits for running Supervisor jobs; gives up without a backup if they never finish', async () => {
    const sup = coreScenario({ verifyOk: true });
    sup.gets.set('/jobs/info', { jobs: [{ name: 'backup_manager_full_backup', done: false }] });
    const { d } = deps(sup);
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(res).toMatchObject({ status: 'failed', transient: true });
    expect(res.error).toContain('backup_manager_full_backup');
    expect(sup.posted()).toEqual([]);
  });

  it('starts once a job finishes', async () => {
    const sup = coreScenario({ verifyOk: true });
    let polls = 0;
    sup.gets.set('/jobs/info', () => ({ jobs: [{ name: 'store_reload', done: polls++ >= 2 }] }));
    const { d } = deps(sup);
    expect((await runUpdate(d, 'core', 'cmd1')).status).toBe('done');
  });

  it('add-on: partial backup of just that add-on; starts it once if it does not come back', async () => {
    const sup = new FakeSupervisor();
    let updated = false;
    let running = true;
    sup.gets.set('/addons/a0d7b954_vscode/info', () => ({
      name: 'Studio Code Server',
      version: updated ? '5.1.0' : '5.0.0',
      version_latest: '5.1.0',
      update_available: !updated,
      state: running ? 'started' : 'stopped',
    }));
    sup.posts.set('/backups/new/partial', { slug: 'bkaddon' });
    sup.posts.set('/store/addons/a0d7b954_vscode/update', () => {
      updated = true;
      running = false;
      return {};
    });
    sup.posts.set('/addons/a0d7b954_vscode/start', () => {
      running = true;
      return {};
    });
    sup.gets.set('/core/info', { version: '2026.10.2', state: 'running' });
    healthyHa(sup);
    const { d } = deps(sup);
    const res = await runUpdate(d, 'a0d7b954_vscode', 'cmd2');
    expect(sup.posted()).toEqual(['/backups/new/partial', '/store/addons/a0d7b954_vscode/update', '/addons/a0d7b954_vscode/start']);
    expect(sup.calls.find((c) => c.path === '/backups/new/partial')?.body).toMatchObject({
      name: `hub-pre-update-a0d7b954_vscode-5.1.0-${STAMP}`,
      addons: ['a0d7b954_vscode'],
      homeassistant: false,
    });
    expect(res.status).toBe('done');
    expect(res.result).toContain('Started it once');
  });

  it('add-on that stays down after one start fails with the backup name', async () => {
    const sup = new FakeSupervisor();
    let updated = false;
    sup.gets.set('/addons/local_x/info', () => ({ name: 'X', version: updated ? '2' : '1', version_latest: '2', update_available: !updated, state: updated ? 'error' : 'started' }));
    sup.posts.set('/backups/new/partial', { slug: 'bk' });
    sup.posts.set('/store/addons/local_x/update', () => {
      updated = true;
      return {};
    });
    sup.posts.set('/addons/local_x/start', {});
    sup.gets.set('/core/info', { version: '2026.10.2', state: 'running' });
    healthyHa(sup);
    const { d } = deps(sup);
    const res = await runUpdate(d, 'local_x', 'c');
    expect(sup.posted().filter((p) => p.endsWith('/start'))).toHaveLength(1);
    expect(res.status).toBe('failed');
    expect(res.error).toContain(`'hub-pre-update-local_x-2-${STAMP}'`);
  });

  it('no update available -> done without a backup', async () => {
    const sup = new FakeSupervisor();
    sup.gets.set('/os/info', { version: '16.3', version_latest: '16.3', update_available: false });
    const { d } = deps(sup);
    const res = await runUpdate(d, 'os', 'cmd3');
    expect(res.status).toBe('done');
    expect(sup.posted()).toEqual([]);
  });

  it('OS update: after verify, applies an execute_reboot suggestion once (after the lock is cleared)', async () => {
    const sup = new FakeSupervisor();
    let updated = false;
    sup.gets.set('/os/info', () => ({ version: updated ? '16.3' : '16.2', version_latest: '16.3', update_available: !updated }));
    sup.gets.set('/core/info', { version: '2026.10.2', state: 'running' });
    sup.posts.set('/backups/new/full', { slug: 'bkos' });
    sup.posts.set('/os/update', () => {
      updated = true;
      throw new SupervisorError('POST /os/update: socket hang up', 'network'); // host reboots
    });
    healthyHa(sup);
    const uuid = 'a'.repeat(32);
    sup.gets.set('/resolution/info', { suggestions: [{ uuid, type: 'execute_reboot', context: 'system', reference: null }, { uuid: 'b'.repeat(32), type: 'clear_full_backup', context: 'system' }] });
    const { d, state } = deps(sup);
    let lockAtSuggestion: UpdateState | null | undefined;
    sup.posts.set(`/resolution/suggestion/${uuid}`, () => {
      lockAtSuggestion = state.load();
      return {};
    });
    const res = await runUpdate(d, 'os', 'cmd4');
    expect(res.status).toBe('done');
    expect(res.result).toContain('execute_reboot (system); applied once');
    expect(sup.posted()).not.toContain(`/resolution/suggestion/${uuid}`);
    await settle(res);
    expect(sup.posted().filter((p) => p.startsWith('/resolution/'))).toEqual([`/resolution/suggestion/${uuid}`]);
    expect(lockAtSuggestion).toBeNull();
  });

  it('Core update: execute_restart is applied, execute_reboot is only reported', async () => {
    const sup = coreScenario({ verifyOk: true });
    sup.gets.set('/resolution/info', {
      suggestions: [
        { uuid: 'c'.repeat(32), type: 'execute_reboot', context: 'system' },
        { uuid: 'd'.repeat(32), type: 'execute_restart', context: 'core' },
      ],
    });
    sup.posts.set(`/resolution/suggestion/${'d'.repeat(32)}`, {});
    const { d } = deps(sup);
    const res = await settle(await runUpdate(d, 'core', 'c'));
    expect(res.result).toContain('execute_restart (core); applied once');
    expect(res.result).toContain('execute_reboot (system); not applied automatically');
    expect(sup.posted().filter((p) => p.startsWith('/resolution/'))).toEqual([`/resolution/suggestion/${'d'.repeat(32)}`]);
  });
});

describe('resume after a restart (each persisted phase)', () => {
  const base: UpdateState = {
    target: 'core',
    fromVersion: '2026.10.2',
    toVersion: '2026.11.0',
    backupName: CORE_BACKUP,
    phase: 'updating',
    startedAt: Date.parse('2026-10-22T11:30:00Z'),
    commandId: 'cmd9',
    requireStarted: false,
    auto: true,
    rebootRequested: false,
  };

  it('phase backup: the update never ran -> failed, NOT attempted, no Supervisor writes, lock cleared', async () => {
    const sup = coreScenario({ verifyOk: true });
    const { d, state } = deps(sup, { ...base, phase: 'backup' });
    const res = await settle(await resumeUpdate(d, { ...base, phase: 'backup' }));
    expect(res.status).toBe('failed');
    expect(res.error).toContain('NOT attempted');
    expect(sup.posted()).toEqual([]);
    expect(state.load()).toBeNull();
  });

  it('phase updating: Core came back on the new version -> done', async () => {
    const sup = coreScenario({ verifyOk: true });
    sup.gets.set('/core/info', { version: '2026.11.0', state: 'running', update_available: false });
    const { d, state } = deps(sup, base);
    const res = await resumeUpdate(d, base);
    expect(state.history).toEqual(['verifying']);
    await settle(res);
    expect(res).toMatchObject({ status: 'done', backupName: CORE_BACKUP });
    expect(sup.posted()).toEqual([]); // never re-runs the update
    expect(state.load()).toBeNull();
  });

  it('phase updating: the update never happened (old version) -> failed naming the backup', async () => {
    const sup = coreScenario({ verifyOk: false });
    const { d } = deps(sup, base);
    const res = await resumeUpdate(d, base);
    expect(res.status).toBe('failed');
    expect(res.error).toContain(`Restore from this backup if needed: '${CORE_BACKUP}'`);
  });

  it('phase verifying: waits up to 20 min for HA after an OS reboot, then succeeds', async () => {
    const sup = new FakeSupervisor();
    healthyHa(sup);
    const t0 = fakeTime().now();
    sup.gets.set('/os/info', { version: '16.3', version_latest: '16.3', update_available: false });
    sup.gets.set('/core/info', { version: '2026.10.2', state: 'running' });
    const s: UpdateState = { ...base, target: 'os', fromVersion: '16.2', toVersion: '16.3', backupName: 'hub-pre-update-os-16.3-x', phase: 'verifying' };
    const { d, time } = deps(sup, s);
    sup.cores.set('/api/', () => {
      if (time.now() - t0 < 12 * 60_000) throw new SupervisorError('starting', 'network');
      return { message: 'API running.' };
    });
    const res = await resumeUpdate(d, s);
    expect(res.status).toBe('done');
    expect(time.now() - t0).toBeGreaterThanOrEqual(12 * 60_000);
  });

  it('phase verifying: add-on budget is 5 min', async () => {
    const sup = new FakeSupervisor();
    healthyHa(sup);
    sup.gets.set('/core/info', { version: '2026.10.2', state: 'running' });
    sup.gets.set('/addons/local_x/info', { name: 'X', version: '1', state: 'started' });
    const s: UpdateState = { ...base, target: 'local_x', fromVersion: '1', toVersion: '2', backupName: 'hub-pre-update-local_x-2-x', phase: 'verifying', requireStarted: true };
    const { d, time } = deps(sup, s);
    const t0 = time.now();
    const res = await resumeUpdate(d, s);
    expect(res.status).toBe('failed');
    expect(res.error).toContain("'hub-pre-update-local_x-2-x'");
    expect(time.now() - t0).toBeLessThanOrEqual(5 * 60_000 + 15_000);
  });

  it('the file store survives a restart, and migrates a 0.1.0 inflight.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hub-state-'));
    const a = fileUpdateStateStore(dir);
    expect(a.load()).toBeNull();
    a.save({ ...base, phase: 'verifying' });
    expect(JSON.parse(readFileSync(join(dir, 'update-state.json'), 'utf8'))).toMatchObject({ phase: 'verifying', toVersion: '2026.11.0' });
    const b = fileUpdateStateStore(dir); // "after the restart"
    expect(b.load()).toEqual({ ...base, phase: 'verifying' });
    b.clear();
    expect(fileUpdateStateStore(dir).load()).toBeNull();

    writeFileSync(
      join(dir, 'inflight.json'),
      JSON.stringify({ commandId: 'c1', target: 'os', version: '16.3', fromVersion: '16.2', backupName: 'hub-pre-update-os-16.3', startedAt: 1, requireStarted: false }),
    );
    expect(fileUpdateStateStore(dir).load()).toMatchObject({ target: 'os', toVersion: '16.3', phase: 'updating', commandId: 'c1' });
  });
});

describe('helpers', () => {
  it('backup names: hub-pre-update-<target>-<version>-<yyyymmdd-hhmm> in NY time, safe characters', () => {
    expect(preUpdateBackupName('core', '2026.11.0b1', Date.parse('2026-10-22T07:05:00Z'))).toBe('hub-pre-update-core-2026.11.0b1-20261022-0305');
    expect(preUpdateBackupName('local_threadfin', 'v1.2 beta', Date.parse('2026-12-01T04:59:00Z'))).toBe('hub-pre-update-local_threadfin-v1.2-beta-20261130-2359');
  });
  it('versionAtLeast', () => {
    expect(versionAtLeast('2026.11.0', '2026.11.0')).toBe(true);
    expect(versionAtLeast('2026.11.1', '2026.11.0')).toBe(true);
    expect(versionAtLeast('16.10', '16.9')).toBe(true);
    expect(versionAtLeast('2026.10.2', '2026.11.0')).toBe(false);
    expect(versionAtLeast('unknown', '1.0')).toBe(false);
  });
});
