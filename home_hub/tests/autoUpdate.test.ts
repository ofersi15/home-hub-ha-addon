import { describe, expect, it } from 'vitest';
import { inWindow, pickAutoUpdates } from '../src/autoUpdate.js';

// 2026-10-22 is EDT (UTC-4): 07:30Z = 03:30 NY.
const at = (utc: string) => Date.parse(utc);

describe('inWindow (America/New_York)', () => {
  const w = { start: '03:00', end: '05:00' };
  it('is inclusive at start, exclusive at end', () => {
    expect(inWindow(at('2026-10-22T06:59:00Z'), w)).toBe(false); // 02:59
    expect(inWindow(at('2026-10-22T07:00:00Z'), w)).toBe(true); // 03:00
    expect(inWindow(at('2026-10-22T08:59:00Z'), w)).toBe(true); // 04:59
    expect(inWindow(at('2026-10-22T09:00:00Z'), w)).toBe(false); // 05:00
  });
  it('uses NY time across DST (EST in December: UTC-5)', () => {
    expect(inWindow(at('2026-12-10T08:30:00Z'), w)).toBe(true); // 03:30 EST
    expect(inWindow(at('2026-12-10T07:30:00Z'), w)).toBe(false); // 02:30 EST
  });
  it('handles windows that wrap midnight', () => {
    const night = { start: '23:00', end: '02:00' };
    expect(inWindow(at('2026-10-23T03:30:00Z'), night)).toBe(true); // 23:30
    expect(inWindow(at('2026-10-23T05:00:00Z'), night)).toBe(true); // 01:00
    expect(inWindow(at('2026-10-23T06:30:00Z'), night)).toBe(false); // 02:30
  });
  it('empty or malformed windows never match', () => {
    expect(inWindow(at('2026-10-22T07:30:00Z'), { start: '03:00', end: '03:00' })).toBe(false);
    expect(inWindow(at('2026-10-22T07:30:00Z'), { start: '3am', end: '05:00' })).toBe(false);
  });
});

describe('pickAutoUpdates', () => {
  const settings = {
    autoUpdate: { a0d7b954_vscode: true, core_mosquitto: false, local_threadfin: true, core: true, os: true, supervisor: true, self_hub: true },
    autoUpdateWindow: { start: '03:00', end: '05:00' },
  };
  const addons = [
    { slug: 'a0d7b954_vscode', updateAvailable: true, latest: '5.1.0' },
    { slug: 'core_mosquitto', updateAvailable: true, latest: '6.5.0' },
    { slug: 'local_threadfin', updateAvailable: false, latest: '1.0.0' },
    { slug: 'core', updateAvailable: true, latest: '2026.11.0' },
    { slug: 'os', updateAvailable: true, latest: '16.3' },
    { slug: 'supervisor', updateAvailable: true, latest: '2026.11.0' },
    { slug: 'self_hub', updateAvailable: true, latest: '0.2.0' },
  ];
  const inside = at('2026-10-22T07:30:00Z');
  const outside = at('2026-10-22T16:00:00Z');

  it('only opted-in add-ons with an update, inside the window; never core/os/supervisor or itself', () => {
    expect(pickAutoUpdates(settings, addons, inside, new Set(), 'self_hub').map((a) => a.slug)).toEqual(['a0d7b954_vscode']);
  });
  it('nothing outside the window', () => {
    expect(pickAutoUpdates(settings, addons, outside, new Set(), 'self_hub')).toEqual([]);
  });
  it('does not retry the same version, but a newer version gets a fresh attempt', () => {
    expect(pickAutoUpdates(settings, addons, inside, new Set(['a0d7b954_vscode@5.1.0']), 'self_hub')).toEqual([]);
    expect(pickAutoUpdates(settings, addons, inside, new Set(['a0d7b954_vscode@5.0.9']), 'self_hub')).toHaveLength(1);
  });
});
