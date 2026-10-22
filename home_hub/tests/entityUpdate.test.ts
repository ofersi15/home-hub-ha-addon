import { describe, expect, it } from 'vitest';
import { updateRank } from '../src/autoUpdate.js';
import type { HaIssue, HaState } from '../src/haWs.js';
import { entityUpdateCandidates } from '../src/piStatus.js';
import { isAllowed, SupervisorError } from '../src/supervisor.js';
import { parseTarget, runUpdate, type EntityUpdateHa, type ExecResult, type UpdateDeps } from '../src/updateFlow.js';
import { memoryUpdateStateStore } from '../src/updateState.js';
import { FakeSupervisor, fakeTime } from './fakes.js';

const TUYA = 'update.local_tuya_update';
const STAMP = '20261022-0800';

async function settle(res: ExecResult): Promise<ExecResult> {
  await res.after?.();
  return res;
}

interface Opts {
  entity?: string;
  from?: string;
  to?: string;
  /** Install never finishes (firmware stuck). */
  stuck?: boolean;
  /** The install call itself times out (firmware still flashing); it finishes later. */
  slowCall?: boolean;
  issuesAfter?: HaIssue[];
  suggestionsBefore?: { uuid: string; type: string; context?: string }[];
  suggestionsAfter?: { uuid: string; type: string; context?: string }[];
  connected?: boolean;
}

function scenario(o: Opts = {}) {
  const entity = o.entity ?? TUYA;
  const from = o.from ?? 'v5.2.5';
  const to = o.to ?? 'v5.2.6';
  const sup = new FakeSupervisor();
  const installs: string[] = [];
  let installed = false;
  let polls = 0;
  sup.cores.set('/api/', { message: 'API running.' });
  sup.cores.set('/api/config', { state: 'RUNNING' });
  sup.gets.set('/info', { state: 'running' });
  sup.gets.set('/core/info', { version: '2026.10.2', state: 'running' });
  sup.gets.set('/jobs/info', { jobs: [] });
  sup.gets.set('/resolution/info', () => ({ suggestions: installed ? (o.suggestionsAfter ?? []) : (o.suggestionsBefore ?? []) }));
  sup.cores.set(`/api/states/${entity}`, () => {
    // A slow firmware flash reports done only after a few verify polls.
    const done = installed && !o.stuck && (!o.slowCall || ++polls > 3);
    return {
      state: done ? 'off' : 'on',
      attributes: { title: 'Local Tuya', installed_version: done ? to : from, latest_version: to, in_progress: installed && !done ? 40 : false },
    };
  });
  sup.posts.set('/backups/new/partial', { slug: 'bkent' });
  sup.posts.set('/core/restart', () => {
    throw new SupervisorError('socket hang up', 'network');
  });
  const ha: EntityUpdateHa = {
    connected: o.connected ?? true,
    async callService(domain, service, _data, entityId) {
      installs.push(`${domain}.${service} ${entityId}`);
      installed = true;
      if (o.slowCall) throw new Error('HA request call_service timed out');
    },
    async listIssues() {
      return installed ? (o.issuesAfter ?? []) : [];
    },
  };
  const time = fakeTime();
  const state = memoryUpdateStateStore();
  const d: UpdateDeps = { sup, sleep: time.sleep, now: time.now, state, pollMs: 15_000, jobsWaitMs: 60_000, ha };
  return { sup, d, installs, state, entity };
}

describe('update.* entity targets', () => {
  it('parses update entities as their own target kind', () => {
    expect(parseTarget(TUYA)).toEqual({ entity: TUYA });
    expect(parseTarget('core_samba')).toEqual({ addon: 'core_samba' });
    expect(parseTarget('update.Bad-Id')).toBeNull();
  });

  it('HACS integration: HA-config backup -> update.install -> verify -> one HA restart for the open repair', async () => {
    const { sup, d, installs, state } = scenario({ issuesAfter: [{ domain: 'hacs', issue_id: 'restart_required_123', translation_key: 'restart_required' }] });
    const res = await runUpdate(d, TUYA, 'cmdT', { auto: true });
    expect(res.status).toBe('done');
    expect(res.backupName).toBe(`hub-pre-update-local_tuya_update-v5.2.6-${STAMP}`);
    expect(res.result).toContain('Updated update.local_tuya_update v5.2.5 -> v5.2.6');
    expect(res.result).toContain('restarted it once');
    expect(installs).toEqual([`update.install ${TUYA}`]);
    const backup = sup.calls.find((c) => c.path === '/backups/new/partial');
    expect(backup?.body).toMatchObject({ addons: [], homeassistant: true });
    // The restart happens after the outcome is recorded and the lock is gone.
    expect(sup.posted()).not.toContain('/core/restart');
    await settle(res);
    expect(sup.posted()).toEqual(['/backups/new/partial', '/core/restart']);
    expect(state.load()).toBeNull();
  });

  it('a card (no repair) is not followed by a restart; an ignored repair does not count', async () => {
    const { sup, d } = scenario({ entity: 'update.mushroom_update', from: 'v5.2.3', to: 'v5.2.4', issuesAfter: [{ domain: 'hacs', issue_id: 'restart_required_9', ignored: true }] });
    const res = await settle(await runUpdate(d, 'update.mushroom_update', 'cmdM'));
    expect(res.status).toBe('done');
    expect(res.result).not.toContain('restart');
    expect(sup.posted()).toEqual(['/backups/new/partial']);
  });

  it('firmware: an install call that times out is verified by polling until it lands', async () => {
    const { sup, d } = scenario({ entity: 'update.bedroom_switch_firmware', from: '3.30.0', to: '3.40.0', slowCall: true });
    const res = await settle(await runUpdate(d, 'update.bedroom_switch_firmware', 'cmdF'));
    expect(res.status).toBe('done');
    expect(sup.posted()).toEqual(['/backups/new/partial']);
  });

  it('firmware that never finishes fails after 45 min and names the backup', async () => {
    const { d } = scenario({ entity: 'update.bedroom_switch_firmware', from: '3.30.0', to: '3.40.0', stuck: true });
    const res = await settle(await runUpdate(d, 'update.bedroom_switch_firmware', 'cmdF'));
    expect(res.status).toBe('failed');
    expect(res.error).toContain('within 45 min');
    expect(res.error).toContain('hub-pre-update-bedroom_switch_firmware-3.40.0');
  });

  it('a reboot the update asked for (new suggestion) is applied once; an older one is not', async () => {
    const old = { uuid: 'a'.repeat(32), type: 'execute_reboot', context: 'system' };
    const fresh = { uuid: 'b'.repeat(32), type: 'execute_reboot', context: 'system' };
    const { sup, d } = scenario({ entity: 'update.raspberry_pi_4_firmware', from: '2026-01-09', to: '2026-03-01', suggestionsBefore: [old], suggestionsAfter: [old, fresh] });
    sup.posts.set(`/resolution/suggestion/${fresh.uuid}`, {});
    const res = await settle(await runUpdate(d, 'update.raspberry_pi_4_firmware', 'cmdP'));
    expect(res.status).toBe('done');
    expect(sup.posted().filter((p) => p.startsWith('/resolution/'))).toEqual([`/resolution/suggestion/${fresh.uuid}`]);
    // The reboot covers the restart: no separate HA restart.
    expect(sup.posted()).not.toContain('/core/restart');
  });

  it('HA not connected: transient, nothing touched', async () => {
    const { sup, d, installs } = scenario({ connected: false });
    const res = await runUpdate(d, TUYA, 'cmdT', { auto: true });
    expect(res).toMatchObject({ status: 'failed', transient: true });
    expect(sup.posted()).toEqual([]);
    expect(installs).toEqual([]);
  });

  it('runs after add-ons and before Supervisor/Core/OS', () => {
    const order = ['os', 'supervisor', TUYA, 'core_samba', 'core'].sort((a, b) => updateRank(a, null) - updateRank(b, null));
    expect(order).toEqual(['core_samba', TUYA, 'supervisor', 'core', 'os']);
  });

  it('allowlist: Core restart only; no other core service paths', () => {
    expect(isAllowed('POST', '/core/restart')).toBe(true);
    expect(isAllowed('POST', '/core/stop')).toBe(false);
    expect(isAllowed('POST', '/core/rebuild')).toBe(false);
  });
});

describe('entityUpdateCandidates', () => {
  const st = (entity_id: string, state: string, attrs: Record<string, unknown> = {}): HaState => ({
    entity_id,
    state,
    last_changed: '2026-10-22T12:00:00Z',
    attributes: { installed_version: '1.0', latest_version: '1.1', supported_features: 23, ...attrs },
  });
  const platforms: Record<string, string> = {
    'update.local_tuya_update': 'hacs',
    'update.mushroom_update': 'hacs',
    'update.bedroom_switch_firmware': 'zwave_js',
    'update.file_editor_update': 'hassio',
    'update.no_install': 'hacs',
    'update.installing': 'zwave_js',
  };

  it('keeps pending non-Supervisor updates that can be installed', () => {
    const out = entityUpdateCandidates(
      [
        st('update.local_tuya_update', 'on', { title: 'Local Tuya', release_url: 'https://github.com/rospogrigio/localtuya/releases' }),
        st('update.mushroom_update', 'off'),
        st('update.bedroom_switch_firmware', 'on', { friendly_name: 'Bedroom switch firmware' }),
        st('update.file_editor_update', 'on'),
        st('update.no_install', 'on', { supported_features: 16 }),
        st('update.installing', 'on', { in_progress: 30 }),
        st('update.unknown_platform', 'on'),
        st('light.kitchen', 'on'),
      ],
      (id) => platforms[id],
    );
    expect(out).toEqual([
      { target: 'update.local_tuya_update', name: 'Local Tuya', installed: '1.0', latest: '1.1', updateAvailable: true, releaseNotesUrl: 'https://github.com/rospogrigio/localtuya/releases' },
      { target: 'update.bedroom_switch_firmware', name: 'Bedroom switch firmware', installed: '1.0', latest: '1.1', updateAvailable: true, releaseNotesUrl: null },
    ]);
  });
});
