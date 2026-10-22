/**
 * Contract pins. The source of truth is Home Hub `shared/schemas/home.ts`. When a Home Hub checkout
 * sits next to this repo (../home-hub, as on the dev PC), the shapes are compared field by field;
 * in CI (no checkout) only the local invariants run.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as local from '../src/contract.js';

const HUB_HOME = join(import.meta.dirname, '..', '..', '..', 'home-hub', 'shared', 'schemas', 'home.ts');

const OBJECTS = ['HomeEntity', 'HomeCatalog', 'HomeState', 'UpdateInfo', 'AddonInfo', 'PiStatus', 'HomeCommand', 'HomeEventRule', 'HomeEvent', 'HomeSettings'] as const;
const ENUMS = ['HomeCommandKind', 'HomeCommandStatus'] as const;

type Shaped = { shape: Record<string, unknown> };
type Enumed = { options: readonly string[] };

describe('contract invariants', () => {
  it('sensitive domains and classes', () => {
    expect(local.SENSITIVE_DOMAINS).toEqual(['lock', 'alarm_control_panel', 'cover', 'garage_door', 'siren', 'valve']);
    expect(local.SENSITIVE_COVER_CLASSES).toEqual(['garage', 'gate', 'door']);
    expect(local.isSensitive('lock.front', null)).toBe(true);
    expect(local.isSensitive('cover.garage', 'garage')).toBe(true);
    expect(local.isSensitive('cover.blinds', 'blind')).toBe(false);
    expect(local.isSensitive('light.x', null)).toBe(false);
  });
  it('only four command kinds exist', () => {
    expect(local.HomeCommandKind.options).toEqual(['call_service', 'backup', 'update', 'restart_addon']);
  });
  it('settings defaults', () => {
    const s = local.HomeSettings.parse({});
    expect(s.services).toEqual(['light.turn_on', 'light.turn_off', 'switch.turn_on', 'switch.turn_off']);
    expect(s.autoUpdateWindow).toEqual({ start: '03:00', end: '05:00' });
    expect(s.autoUpdateMode).toBe('window');
    expect(s.backupRetention).toBe(5);
    expect(s.groups).toEqual([]);
    expect(s.confirm).toEqual([]);
  });
  it('event rules need exactly one of toState / below', () => {
    const base = { id: 'r1', name: 'x', entityId: 'sensor.blinds_battery', action: 'notify', message: 'm' };
    expect(local.HomeEventRule.safeParse({ ...base, below: 20 }).success).toBe(true);
    expect(local.HomeEventRule.safeParse({ ...base, toState: 'on' }).success).toBe(true);
    expect(local.HomeEventRule.safeParse({ ...base }).success).toBe(false);
    expect(local.HomeEventRule.safeParse({ ...base, toState: 'on', below: 20 }).success).toBe(false);
    expect(local.HomeEventRule.parse({ ...base, below: 20 }).repeatHours).toBe(0);
  });
  it('autoUpdateEnabled: platform needs its own flag; add-ons fall back to *', () => {
    expect(local.autoUpdateEnabled({ '*': true }, 'core')).toBe(false);
    expect(local.autoUpdateEnabled({ core: true }, 'core')).toBe(true);
    expect(local.autoUpdateEnabled({ '*': true }, 'core_mosquitto')).toBe(true);
    expect(local.autoUpdateEnabled({ '*': true, core_mosquitto: false }, 'core_mosquitto')).toBe(false);
  });
  it('update entries default to not blocked', () => {
    expect(local.UpdateInfo.parse({ target: 'core', name: 'Core', installed: '1', latest: '2', updateAvailable: true }).blocked).toBe(false);
  });
  it('paths live under hub/main', () => {
    expect(local.PATHS.homeState).toBe('hub/main/home/state');
    expect(local.PATHS.homePi).toBe('hub/main/home/pi');
    expect(local.PATHS.settingsHome).toBe('hub/main/settings/home');
    expect(local.PATHS.homeEntity('light.kitchen')).toBe('hub/main/homeEntities/light.kitchen');
  });
});

describe.skipIf(!existsSync(HUB_HOME))('matches Home Hub shared/schemas/home.ts', () => {
  it('same object fields and enum values', async () => {
    const hub = (await import(pathToFileURL(HUB_HOME).href)) as Record<string, unknown>;
    for (const name of OBJECTS) {
      expect(Object.keys((local[name] as unknown as Shaped).shape).sort(), name).toEqual(Object.keys((hub[name] as Shaped).shape).sort());
    }
    expect([...local.AUTO_UPDATE_PLATFORM_TARGETS]).toEqual([...(hub.AUTO_UPDATE_PLATFORM_TARGETS as string[])]);
    expect(local.HomeSettings.parse({})).toEqual((hub.HomeSettings as typeof local.HomeSettings).parse({}));
    const hubEnabled = hub.autoUpdateEnabled as typeof local.autoUpdateEnabled;
    const cases: [Record<string, boolean>, string][] = [
      [{ '*': true }, 'core'],
      [{ '*': true }, 'a0d7b954_vscode'],
      [{ '*': true, a0d7b954_vscode: false }, 'a0d7b954_vscode'],
      [{ core: true }, 'core'],
      [{}, 'os'],
    ];
    for (const [au, t] of cases) expect(local.autoUpdateEnabled(au, t), `${JSON.stringify(au)} ${t}`).toBe(hubEnabled(au, t));
    for (const name of ENUMS) {
      expect([...(local[name] as unknown as Enumed).options], name).toEqual([...(hub[name] as Enumed).options]);
    }
    expect(local.SENSITIVE_DOMAINS).toEqual(hub.SENSITIVE_DOMAINS);
    expect(local.SENSITIVE_COVER_CLASSES).toEqual(hub.SENSITIVE_COVER_CLASSES);
  });
});
