import { describe, expect, it } from 'vitest';
import { filterAttributes } from '../src/attributes.js';
import { HomeCatalog, HomeEntity } from '../src/contract.js';
import { buildCatalog, toHomeEntity } from '../src/mirror.js';

describe('filterAttributes', () => {
  it('keeps only allowlisted primitive attributes', () => {
    const out = filterAttributes({
      friendly_name: 'Kitchen',
      brightness: 200,
      color_temp_kelvin: 3000,
      unit_of_measurement: '°C',
      entity_picture: '/api/camera_proxy/camera.door?token=abc',
      access_token: 'abc',
      latitude: 40.7,
      longitude: -73.9,
      ip_address: '192.168.1.5',
      hvac_modes: ['off', 'heat', { bad: 1 }],
      rgb_color: [255, 0, 0],
      temperature: Number.NaN,
      media_title: 'x'.repeat(500),
      source: { nested: true },
    });
    expect(out).toEqual({
      brightness: 200,
      color_temp_kelvin: 3000,
      unit_of_measurement: '°C',
      hvac_modes: ['off', 'heat'],
      media_title: 'x'.repeat(200),
    });
  });
  it('handles missing attributes', () => {
    expect(filterAttributes(undefined)).toEqual({});
  });
});

describe('entity + catalog shapes match the contract', () => {
  const states = [
    { entity_id: 'light.kitchen', state: 'on', attributes: { friendly_name: 'Kitchen light', brightness: 100 }, last_changed: '2026-10-22T11:00:00.123456+00:00' },
    { entity_id: 'binary_sensor.front_door', state: 'off', attributes: { friendly_name: 'Front door', device_class: 'door' }, last_changed: '2026-10-22T10:00:00+00:00' },
    { entity_id: 'light.hall', state: 'off', attributes: {}, last_changed: 'garbage' },
  ];
  const reg = {
    areas: [{ area_id: 'kitchen', name: 'Kitchen' }, { area_id: 'hall', name: 'Hall' }],
    devices: [{ id: 'dev1', area_id: 'hall' }],
    entities: [
      { entity_id: 'light.kitchen', area_id: 'kitchen', device_id: null, name: null },
      { entity_id: 'light.hall', area_id: null, device_id: 'dev1', name: 'Hall lamp' },
    ],
  };
  it('toHomeEntity validates', () => {
    const e = toHomeEntity(states[0]!, 'Kitchen', Date.parse('2026-10-22T12:00:00Z'));
    expect(HomeEntity.parse(e)).toMatchObject({ entityId: 'light.kitchen', domain: 'light', name: 'Kitchen light', area: 'Kitchen', attributes: { brightness: 100 } });
    expect(HomeEntity.parse(toHomeEntity(states[2]!, null, Date.parse('2026-10-22T12:00:00Z'))).lastChanged).toBe('2026-10-22T12:00:00.000Z');
  });
  it('catalog groups by domain with names, areas (entity or device) and device classes', () => {
    const cat = buildCatalog(states, reg, Date.parse('2026-10-22T12:00:00Z'));
    for (const c of cat) HomeCatalog.parse(c);
    expect(cat.map((c) => c.domain)).toEqual(['binary_sensor', 'light']);
    expect(cat[1]?.entities).toEqual([
      { entityId: 'light.hall', name: 'Hall lamp', area: 'Hall', deviceClass: null },
      { entityId: 'light.kitchen', name: 'Kitchen light', area: 'Kitchen', deviceClass: null },
    ]);
    expect(cat[0]?.entities[0]?.deviceClass).toBe('door');
  });
});
