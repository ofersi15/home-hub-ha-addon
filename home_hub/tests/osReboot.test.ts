import { describe, expect, it } from 'vitest';
import { SupervisorError } from '../src/supervisor.js';
import { OS_REBOOT_GRACE_MS, osPendingVersion, resumeUpdate, runUpdate, type ExecResult, type UpdateDeps } from '../src/updateFlow.js';
import { memoryUpdateStateStore, type UpdateState } from '../src/updateState.js';
import { FakeSupervisor, fakeTime } from './fakes.js';

const REBOOT = 'e'.repeat(32);
const BACKUP = 'hub-pre-update-os-18.3-20261022-0800';

function deps(sup: FakeSupervisor, initial: UpdateState | null = null) {
  const time = fakeTime();
  const state = memoryUpdateStateStore(initial);
  const d: UpdateDeps = { sup, sleep: time.sleep, now: time.now, state, pollMs: 15_000, jobsWaitMs: 60_000 };
  return { d, time, state };
}

async function settle(res: ExecResult): Promise<ExecResult> {
  await res.after?.();
  return res;
}

/** HAOS with 18.3 installed in slot A, 18.2 booted from B (what the Pi reported on 2026-10-22). */
const pendingOs = { version: '18.2', version_latest: '18.3', version_pending: '18.3', update_available: false };
const bootedOs = { version: '18.3', version_latest: '18.3', version_pending: null, update_available: false };

/** Healthy HA; `/os/info` flips to the booted version once the reboot suggestion is applied. */
function pendingScenario(opts: { suggestion?: boolean; rebootAfter?: boolean } = {}) {
  const sup = new FakeSupervisor();
  let rebooted = false;
  sup.cores.set('/api/', { message: 'API running.' });
  sup.cores.set('/api/config', { state: 'RUNNING' });
  sup.gets.set('/info', { state: 'running' });
  sup.gets.set('/core/info', { version: '2026.10.2', state: 'running' });
  sup.gets.set('/jobs/info', { jobs: [] });
  sup.gets.set('/os/info', () => (rebooted && opts.rebootAfter !== false ? bootedOs : pendingOs));
  // The Supervisor keeps offering the reboot even afterwards: we must still never reboot twice.
  sup.gets.set('/resolution/info', { suggestions: opts.suggestion === false ? [] : [{ uuid: REBOOT, type: 'execute_reboot', context: 'system' }] });
  sup.posts.set('/backups/new/full', { slug: 'bkos' });
  sup.posts.set(`/resolution/suggestion/${REBOOT}`, () => {
    rebooted = true;
    throw new SupervisorError('socket hang up', 'network');
  });
  return sup;
}

const reboots = (sup: FakeSupervisor) => sup.posted().filter((p) => p === `/resolution/suggestion/${REBOOT}`).length;

describe('osPendingVersion', () => {
  it('reads version_pending', () => {
    expect(osPendingVersion(pendingOs)).toBe('18.3');
    expect(osPendingVersion(bootedOs)).toBeNull();
  });
  it('falls back to an inactive boot slot holding version_latest', () => {
    expect(
      osPendingVersion({
        version: '18.2',
        version_latest: '18.3',
        update_available: false,
        boot_slots: { A: { state: 'inactive', version: '18.3' }, B: { state: 'booted', version: '18.2' } },
      }),
    ).toBe('18.3');
    // Inactive slot holds an OLDER version (the normal state after a good update): nothing pending.
    expect(
      osPendingVersion({ version: '18.3', version_latest: '18.3', boot_slots: { A: { state: 'booted', version: '18.3' }, B: { state: 'inactive', version: '18.2' } } }),
    ).toBeNull();
  });
  it('never treats a downgrade as pending', () => {
    expect(osPendingVersion({ version: '18.3', version_pending: '18.2' })).toBeNull();
  });
});

describe('OS installed but not booted', () => {
  it('backup first, then one reboot, then verifies the new version', async () => {
    const sup = pendingScenario();
    const { d, state } = deps(sup);
    const res = await runUpdate(d, 'os', 'cmdOs', { auto: true });
    expect(res.status).toBe('done');
    expect(res.backupName).toBe(BACKUP);
    expect(res.result).toContain('Updated os 18.2 -> 18.3');
    expect(res.result).toContain('Rebooted once to boot it.');
    // The still-offered reboot is NOT applied a second time.
    expect(res.result).toContain('execute_reboot (system); not applied automatically');
    await settle(res);
    expect(sup.posted()).toEqual(['/backups/new/full', `/resolution/suggestion/${REBOOT}`]);
    expect(state.load()).toBeNull();
  });

  it('records the reboot before asking for it, so a resume after the reboot never reboots again', async () => {
    const sup = pendingScenario();
    const { d, state } = deps(sup);
    let saved: UpdateState | null = null;
    sup.posts.set(`/resolution/suggestion/${REBOOT}`, () => {
      saved = state.load();
      throw new SupervisorError('socket hang up', 'network');
    });
    await runUpdate(d, 'os', 'cmdOs');
    expect(saved).toMatchObject({ phase: 'updating', rebootRequested: true, toVersion: '18.3' });

    // The process died in the reboot: next start resumes from the saved state.
    const sup2 = pendingScenario();
    sup2.gets.set('/os/info', bootedOs);
    const { d: d2 } = deps(sup2, saved);
    const res = await settle(await resumeUpdate(d2, saved as unknown as UpdateState));
    expect(res.status).toBe('done');
    expect(reboots(sup2)).toBe(0);
  });

  it('no reboot suggestion: fails naming the backup, never reboots', async () => {
    const sup = pendingScenario({ suggestion: false });
    const { d } = deps(sup);
    const res = await settle(await runUpdate(d, 'os', 'cmdOs'));
    expect(res.status).toBe('failed');
    expect(res.error).toContain('needs a reboot');
    expect(res.error).toContain(BACKUP);
    expect(reboots(sup)).toBe(0);
  });

  it('booted back into the old slot: fails (verify), names the backup, reboots only once', async () => {
    const sup = pendingScenario({ rebootAfter: false });
    const { d } = deps(sup);
    const res = await settle(await runUpdate(d, 'os', 'cmdOs'));
    expect(res.status).toBe('failed');
    expect(res.error).toContain('expected 18.3');
    expect(res.error).toContain(BACKUP);
    expect(reboots(sup)).toBe(1);
  });
});

describe('our OS update that does not reboot by itself', () => {
  it('waits the grace period, then reboots once', async () => {
    const sup = pendingScenario();
    let installed = false;
    sup.gets.set('/os/info', () => {
      if (reboots(sup) > 0) return bootedOs;
      return installed ? pendingOs : { version: '18.2', version_latest: '18.3', update_available: true };
    });
    sup.posts.set('/os/update', () => {
      installed = true;
      return {};
    });
    const { d, time } = deps(sup);
    const start = time.now();
    let rebootAt = 0;
    sup.posts.set(`/resolution/suggestion/${REBOOT}`, () => {
      rebootAt = time.now();
      throw new SupervisorError('socket hang up', 'network');
    });
    const res = await settle(await runUpdate(d, 'os', 'cmdOs'));
    expect(res.status).toBe('done');
    expect(res.result).toContain('Rebooted once to boot it.');
    expect(reboots(sup)).toBe(1);
    expect(rebootAt - start).toBeGreaterThanOrEqual(OS_REBOOT_GRACE_MS);
    expect(sup.posted()).toEqual(['/backups/new/full', '/os/update', `/resolution/suggestion/${REBOOT}`]);
  });
});
