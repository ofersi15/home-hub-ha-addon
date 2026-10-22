import { describe, expect, it } from 'vitest';
import { pruneBackups } from '../src/retention.js';
import { FakeSupervisor } from './fakes.js';

const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}T03:00:00+00:00`;

function sup(backups: { slug: string; name: string; date: string }[]) {
  const s = new FakeSupervisor();
  s.gets.set('/backups', { backups });
  for (const b of backups) {
    s.gets.set(`/backups/${b.slug}/info`, { slug: b.slug, name: b.name, date: b.date });
    s.dels.set(`/backups/${b.slug}`, {});
  }
  return s;
}

describe('pruneBackups', () => {
  const list = [
    { slug: '0000000a', name: 'hub-pre-update-core-2026.10.1-20261001-0300', date: day(1) },
    { slug: '0000000b', name: 'Automatic backup 2026.10.1', date: day(2) },
    { slug: '0000000c', name: 'hub-2026-10-03-manual', date: day(3) },
    { slug: '0000000d', name: 'core_2026.10.2', date: day(4) },
    { slug: '0000000e', name: 'hub-pre-update-os-16.3-20261005-0300', date: day(5) },
    { slug: '0000000f', name: 'My hub- backup (by hand)', date: day(6) },
    { slug: '00000010', name: 'hub-pre-update-core_mosquitto-6.5.0-20261007-0300', date: day(7) },
    { slug: '00000011', name: 'hub-pre-update-core-2026.11.0-20261008-0300', date: day(8) },
  ];

  it('keeps the newest N hub- backups and deletes older ones', async () => {
    const s = sup(list);
    const r = await pruneBackups(s, 2);
    expect(r.deleted).toEqual(['hub-pre-update-os-16.3-20261005-0300', 'hub-2026-10-03-manual', 'hub-pre-update-core-2026.10.1-20261001-0300']);
    expect(s.deleted()).toEqual(['/backups/0000000e', '/backups/0000000c', '/backups/0000000a']);
  });

  it('never touches a backup whose name does not start with hub-', async () => {
    const s = sup(list);
    await pruneBackups(s, 2);
    for (const slug of ['0000000b', '0000000d', '0000000f']) expect(s.deleted()).not.toContain(`/backups/${slug}`);
  });

  it('nothing to do when there are N or fewer', async () => {
    const s = sup(list);
    expect((await pruneBackups(s, 5)).deleted).toEqual([]);
    expect(s.deleted()).toEqual([]);
  });

  it('never keeps fewer than 2, and protected names survive', async () => {
    const s = sup(list);
    const r = await pruneBackups(s, 0, new Set(['hub-2026-10-03-manual']));
    expect(r.deleted).not.toContain('hub-2026-10-03-manual');
    expect(s.deleted()).not.toContain('/backups/00000011');
    expect(s.deleted()).not.toContain('/backups/00000010');
  });

  it('re-checks the name via /backups/<slug>/info before deleting', async () => {
    const s = sup(list);
    // The list says hub-, but the backup behind that slug is someone else's now.
    s.gets.set('/backups/0000000a/info', { slug: '0000000a', name: 'Important manual backup' });
    const r = await pruneBackups(s, 2);
    expect(r.deleted).not.toContain('hub-pre-update-core-2026.10.1-20261001-0300');
    expect(s.deleted()).not.toContain('/backups/0000000a');
  });

  it('skips slugs that are not Supervisor backup slugs', async () => {
    const s = sup([...list, { slug: '../core', name: 'hub-evil', date: day(0) }]);
    await pruneBackups(s, 2);
    expect(s.calls.some((c) => c.path.includes('..'))).toBe(false);
  });
});
