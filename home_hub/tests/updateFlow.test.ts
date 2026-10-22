import { describe, expect, it } from 'vitest';
import type { Inflight } from '../src/inflight.js';
import { SupervisorError } from '../src/supervisor.js';
import { preUpdateBackupName, resumeInflight, runUpdate, type UpdateDeps } from '../src/updateFlow.js';
import { FakeSupervisor, fakeTime } from './fakes.js';

function deps(sup: FakeSupervisor) {
  const time = fakeTime();
  let inflight: Inflight | null = null;
  const log: string[] = [];
  const d: UpdateDeps = {
    sup,
    sleep: time.sleep,
    now: time.now,
    saveInflight: (i) => {
      inflight = i;
      log.push('saveInflight');
    },
    clearInflight: () => {
      inflight = null;
      log.push('clearInflight');
    },
    pollMs: 15_000,
  };
  return { d, time, log, inflight: () => inflight };
}

function healthyHa(sup: FakeSupervisor) {
  sup.cores.set('/api/', { message: 'API running.' });
  sup.cores.set('/api/config', { state: 'RUNNING' });
  sup.gets.set('/info', { state: 'running', supported: false });
}

/** Core: installed 2026.10.2, update to 2026.11.0; after the update POST it reports the new version. */
function coreScenario(opts: { verifyOk: boolean }) {
  const sup = new FakeSupervisor();
  let updated = false;
  sup.gets.set('/core/info', () => ({
    version: updated && opts.verifyOk ? '2026.11.0' : '2026.10.2',
    version_latest: '2026.11.0',
    update_available: !(updated && opts.verifyOk),
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
  it('takes a named backup BEFORE updating, then verifies and reports done', async () => {
    const sup = coreScenario({ verifyOk: true });
    const { d, log } = deps(sup);
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(sup.posted()).toEqual(['/backups/new/full', '/core/update']);
    const backupCall = sup.calls.find((c) => c.path === '/backups/new/full');
    expect(backupCall?.body).toMatchObject({ name: 'hub-pre-update-core-2026.11.0' });
    expect(sup.calls.find((c) => c.path === '/core/update')?.body).toMatchObject({ version: '2026.11.0', backup: true });
    expect(res.status).toBe('done');
    expect(res.backupName).toBe('hub-pre-update-core-2026.11.0');
    expect(res.result).toContain('hub-pre-update-core-2026.11.0');
    expect(log).toEqual(['saveInflight', 'clearInflight']);
  });

  it('a failed verify fails the command and names the backup', async () => {
    const sup = coreScenario({ verifyOk: false });
    const { d } = deps(sup);
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(res.status).toBe('failed');
    expect(res.error).toContain("Restore backup 'hub-pre-update-core-2026.11.0'");
    expect(res.backupName).toBe('hub-pre-update-core-2026.11.0');
  });

  it('verify fails when HA API is down', async () => {
    const sup = coreScenario({ verifyOk: true });
    sup.cores.set('/api/', () => {
      throw new SupervisorError('core GET /api/: HTTP 502', 'api', 502);
    });
    const { d } = deps(sup);
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(res.status).toBe('failed');
    expect(res.error).toContain('hub-pre-update-core-2026.11.0');
  });

  it('never updates when the backup fails', async () => {
    const sup = coreScenario({ verifyOk: true });
    sup.gets.set('/jobs/aaaaaaaa-1111', { done: true, errors: [{ message: 'disk full' }] });
    const { d } = deps(sup);
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(res.status).toBe('failed');
    expect(res.error).toContain('NOT attempted');
    expect(res.error).toContain('disk full');
    expect(sup.posted()).not.toContain('/core/update');
  });

  it('an update API error names the backup', async () => {
    const sup = coreScenario({ verifyOk: true });
    sup.posts.set('/core/update', () => {
      throw new SupervisorError('POST /core/update: Update failed', 'api', 400);
    });
    const { d } = deps(sup);
    const res = await runUpdate(d, 'core', 'cmd1');
    expect(res.status).toBe('failed');
    expect(res.error).toContain("Backup 'hub-pre-update-core-2026.11.0' was taken first");
  });

  it('add-on: partial backup of just that add-on, store update endpoint, waits until started', async () => {
    const sup = new FakeSupervisor();
    let updated = false;
    let polls = 0;
    sup.gets.set('/addons/a0d7b954_vscode/info', () => {
      if (updated) polls++;
      return {
        name: 'Studio Code Server',
        version: updated ? '5.1.0' : '5.0.0',
        version_latest: '5.1.0',
        update_available: !updated,
        state: updated && polls < 3 ? 'stopped' : 'started',
      };
    });
    sup.posts.set('/backups/new/partial', { slug: 'bkaddon' });
    sup.posts.set('/store/addons/a0d7b954_vscode/update', () => {
      updated = true;
      return {};
    });
    sup.gets.set('/core/info', { version: '2026.10.2' });
    healthyHa(sup);
    const { d } = deps(sup);
    const res = await runUpdate(d, 'a0d7b954_vscode', 'cmd2');
    expect(sup.posted()).toEqual(['/backups/new/partial', '/store/addons/a0d7b954_vscode/update']);
    expect(sup.calls[1]?.body).toMatchObject({ name: 'hub-pre-update-a0d7b954_vscode-5.1.0', addons: ['a0d7b954_vscode'] });
    expect(res.status).toBe('done');
  });

  it('no update available -> done without a backup', async () => {
    const sup = new FakeSupervisor();
    sup.gets.set('/os/info', { version: '16.3', version_latest: '16.3', update_available: false });
    const { d } = deps(sup);
    const res = await runUpdate(d, 'os', 'cmd3');
    expect(res.status).toBe('done');
    expect(sup.posted()).toEqual([]);
  });

  it('OS update: connection drop (reboot) is not a failure; in-flight state is saved first and resumable', async () => {
    const sup = new FakeSupervisor();
    sup.gets.set('/os/info', { version: '16.2', version_latest: '16.3', update_available: true });
    sup.posts.set('/backups/new/full', { slug: 'bkos' });
    sup.posts.set('/os/update', () => {
      throw new SupervisorError('POST /os/update: socket hang up', 'network');
    });
    const { d, time } = deps(sup);
    // Simulate the process dying during verification: the saved in-flight record is what survives.
    let saved: Inflight | null = null;
    d.saveInflight = (i) => {
      saved = i;
    };
    d.verifyTimeoutMs = () => 30_000;
    sup.cores.set('/api/', () => {
      throw new SupervisorError('down', 'network');
    });
    const first = await runUpdate(d, 'os', 'cmd4');
    expect(first.status).toBe('failed');
    expect(saved).toMatchObject({ commandId: 'cmd4', target: 'os', version: '16.3', backupName: 'hub-pre-update-os-16.3' });

    // After the reboot: OS reports the new version and HA is healthy -> resume completes it.
    sup.gets.set('/os/info', { version: '16.3', version_latest: '16.3', update_available: false });
    sup.gets.set('/core/info', { version: '2026.10.2' });
    healthyHa(sup);
    time.advance(60_000);
    const resumed = await resumeInflight(d, saved as unknown as Inflight);
    expect(resumed.status).toBe('done');
    expect(resumed.backupName).toBe('hub-pre-update-os-16.3');
  });

  it('backup names are safe', () => {
    expect(preUpdateBackupName('core', '2026.11.0b1')).toBe('hub-pre-update-core-2026.11.0b1');
    expect(preUpdateBackupName('local_threadfin', 'v1.2 beta')).toBe('hub-pre-update-local_threadfin-v1.2-beta');
  });
});
