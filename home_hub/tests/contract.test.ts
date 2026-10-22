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
    for (const name of ENUMS) {
      expect([...(local[name] as unknown as Enumed).options], name).toEqual([...(hub[name] as Enumed).options]);
    }
    expect(local.SENSITIVE_DOMAINS).toEqual(hub.SENSITIVE_DOMAINS);
    expect(local.SENSITIVE_COVER_CLASSES).toEqual(hub.SENSITIVE_COVER_CLASSES);
  });
});
