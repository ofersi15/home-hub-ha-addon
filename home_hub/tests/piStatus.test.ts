import { describe, expect, it } from 'vitest';
import { HomeSettings, PiStatus } from '../src/contract.js';
import { AddonFlapTracker, collectPiStatus, mapAddonState } from '../src/piStatus.js';
import { FakeSupervisor } from './fakes.js';

const NOW = Date.parse('2026-10-22T12:00:00Z');

function sup() {
  const s = new FakeSupervisor();
  s.gets.set('/info', { supported: false, state: 'running' });
  s.gets.set('/host/info', { disk_total: 58.0, disk_used: 20.3, disk_free: 37.7, boot_timestamp: (NOW - 3600_000) * 1000 });
  s.gets.set('/os/info', { version: '16.2', version_latest: '16.3', update_available: true });
  s.gets.set('/core/info', { version: '2026.10.2', version_latest: '2026.10.2', update_available: false });
  s.gets.set('/supervisor/info', { version: '2026.10.3', version_latest: '2026.10.3', update_available: false, supported: false, healthy: true });
  s.gets.set('/resolution/info', { unsupported: ['docker_configuration', 'software'], unhealthy: [] });
  s.gets.set('/addons', {
    addons: [
      { slug: 'core_mosquitto', name: 'Mosquitto broker', state: 'started', version: '6.4.0', version_latest: '6.5.0', update_available: true },
      { slug: 'local_threadfin', name: 'Threadfin', state: 'stopped', version: '1.0', version_latest: '1.0', update_available: false },
      { slug: 'db21ed7f_x', name: 'Something', state: 'startup', version: '2', version_latest: '2', update_available: false },
    ],
  });
  s.gets.set('/addons/core_mosquitto/info', { url: 'https://github.com/home-assistant/addons/tree/master/mosquitto', state: 'started', version: '6.4.0', version_latest: '6.5.0', update_available: true, boot: 'auto' });
  s.gets.set('/addons/local_threadfin/info', { url: null, state: 'stopped', version: '1.0', version_latest: '1.0', update_available: false, boot: 'manual' });
  // db21ed7f_x info missing -> falls back to the list entry
  s.gets.set('/backups', {
    backups: [
      { slug: 'old', name: 'Old', date: '2026-10-01T03:00:00+00:00' },
      { slug: 'new', name: 'hub-2026-10-21-manual', date: '2026-10-21T03:00:00+00:00' },
    ],
  });
  return s;
}

describe('collectPiStatus', () => {
  it('produces a contract-valid PiStatus with updates, add-ons and last backup', async () => {
    const settings = HomeSettings.parse({ autoUpdate: { core_mosquitto: true } });
    const snap = await collectPiStatus({
      sup: sup(),
      now: () => NOW,
      flaps: new AddonFlapTracker(),
      settings: () => settings,
      cpuTempC: () => 51.2,
      cpuPercent: () => 7.5,
      memoryPercent: () => 40,
    });
    const st = PiStatus.parse(snap.status);
    expect(snap.supported).toBe(false);
    expect(st).toMatchObject({ cpuTempC: 51.2, cpuPercent: 7.5, memoryPercent: 40, diskUsedPercent: 35, diskFreeGb: 37.7, uptimeSeconds: 3600 });
    expect(st.updates.map((u) => [u.target, u.updateAvailable])).toEqual([
      ['core', false],
      ['os', true],
      ['supervisor', false],
      ['core_mosquitto', true],
    ]);
    expect(st.updates[1]?.releaseNotesUrl).toBe('https://github.com/home-assistant/operating-system/releases/tag/16.3');
    expect(st.updates[3]?.releaseNotesUrl).toContain('mosquitto');
    expect(st.addons.map((a) => [a.slug, a.state, a.autoUpdatePolicy, a.boot])).toEqual([
      ['core_mosquitto', 'started', 'auto', 'auto'],
      ['local_threadfin', 'stopped', 'off', 'manual'],
      ['db21ed7f_x', 'started', 'off', null],
    ]);
    // Unsupported is reported, not an error.
    expect(st.supervisor).toEqual({ supported: false, healthy: true, unsupportedReasons: ['docker_configuration', 'software'], unhealthyReasons: [] });
    expect(st.lastBackup).toEqual({ slug: 'new', name: 'hub-2026-10-21-manual', date: '2026-10-21T03:00:00.000Z' });
    expect(snap.addonUpdates.find((a) => a.slug === 'core_mosquitto')).toEqual({ slug: 'core_mosquitto', updateAvailable: true, latest: '6.5.0' });
  });

  it('survives Supervisor endpoints failing (nulls, no throw)', async () => {
    const snap = await collectPiStatus({ sup: new FakeSupervisor(), now: () => NOW, flaps: new AddonFlapTracker(), settings: () => null, cpuTempC: () => null, cpuPercent: () => null, memoryPercent: () => null, osUptimeSeconds: () => null });
    expect(PiStatus.parse(snap.status)).toMatchObject({ diskUsedPercent: null, updates: [], addons: [], lastBackup: null, supervisor: null });
  });
});

describe('AddonFlapTracker (crash-loop detection)', () => {
  it('counts restarts within the last hour', () => {
    const f = new AddonFlapTracker();
    const t0 = NOW;
    f.record('x', 'started', t0);
    expect(f.recentRestarts('x', t0)).toBe(0);
    f.record('x', 'error', t0 + 60_000);
    f.record('x', 'started', t0 + 120_000);
    f.record('x', 'stopped', t0 + 180_000);
    f.record('x', 'started', t0 + 240_000);
    f.record('x', 'started', t0 + 300_000);
    expect(f.recentRestarts('x', t0 + 300_000)).toBe(2);
    expect(f.recentRestarts('x', t0 + 2 * 3600_000)).toBe(0);
  });
  it('maps Supervisor states', () => {
    expect(mapAddonState('startup')).toBe('started');
    expect(mapAddonState('error')).toBe('error');
    expect(mapAddonState(undefined)).toBe('unknown');
  });
});
