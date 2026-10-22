import { describe, expect, it } from 'vitest';
import { EntityMirror } from '../src/mirror.js';
import { PATHS } from '../src/contract.js';
import { FakeStore } from './fakes.js';

const state = (entity_id: string, s = 'on') => ({ entity_id, state: s, attributes: {}, last_changed: '2026-10-22T12:00:00Z', last_updated: '2026-10-22T12:00:00Z' });

describe('EntityMirror', () => {
  it('deletes the Hub copy of an allowlisted entity removed from HA, ignores others', async () => {
    const store = new FakeStore();
    const m = new EntityMirror(store, () => 0, 0);
    m.setAllowlist(['light.a']);
    m.loadStates([state('light.a'), state('light.b')] as never);
    await m.flush();
    m.onStateChanged('light.b', null);
    m.onStateChanged('light.a', null);
    await m.flush();
    await Promise.resolve();
    expect(store.writes.filter((w) => w.op === 'remove').map((w) => w.path)).toEqual([PATHS.homeEntity('light.a')]);
    m.stop();
  });
});
