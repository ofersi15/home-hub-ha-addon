/**
 * Backup retention: keep the newest N backups this add-on created (names starting 'hub-'), delete
 * older ones. A backup whose name does not start with 'hub-' is NEVER deleted: the name is checked in
 * the list AND again via /backups/<slug>/info right before the DELETE.
 */
import { errMsg, logger } from './log.js';
import type { SupervisorApi } from './supervisor.js';

const log = logger('retention');

export const OUR_PREFIX = 'hub-';
const SLUG = /^[0-9a-f]{8}$/;

interface BackupItem {
  slug: string;
  name: string;
  date: string;
}

export interface RetentionResult {
  deleted: string[];
  kept: number;
}

/**
 * @param keep    how many 'hub-' backups to keep (settings.backupRetention; never fewer than 2)
 * @param protect backup NAMES never to delete (the update in flight, backups named in failed updates)
 */
export async function pruneBackups(sup: SupervisorApi, keep: number, protect: ReadonlySet<string> = new Set()): Promise<RetentionResult> {
  const list = await sup.get<{ backups?: BackupItem[] }>('/backups');
  const ours = (list.backups ?? [])
    .filter((b) => typeof b.name === 'string' && b.name.startsWith(OUR_PREFIX) && typeof b.slug === 'string')
    .sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  const n = Math.max(2, Math.floor(keep));
  const victims = ours.slice(n).filter((b) => !protect.has(b.name));
  const deleted: string[] = [];
  for (const b of victims) {
    if (!SLUG.test(b.slug)) continue;
    try {
      const info = await sup.get<{ name?: string }>(`/backups/${b.slug}/info`);
      if (typeof info.name !== 'string' || !info.name.startsWith(OUR_PREFIX) || info.name !== b.name) {
        log.warn('Backup name changed or is not ours; not deleting', { slug: b.slug });
        continue;
      }
      await sup.del(`/backups/${b.slug}`);
      deleted.push(b.name);
      log.info('Deleted old backup (retention)', { name: b.name, slug: b.slug });
    } catch (e) {
      log.warn('Deleting an old backup failed', { name: b.name, error: errMsg(e) });
    }
  }
  return { deleted, kept: ours.length - deleted.length };
}
