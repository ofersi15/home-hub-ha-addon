/** Supervisor backups: start in the background, wait for the job, return the backup slug. */
import type { SupervisorApi } from './supervisor.js';
import type { Clock, Sleep } from './util.js';

export type BackupSpec =
  | { name: string; kind: 'full' }
  | { name: string; kind: 'partial'; addons?: string[]; homeassistant?: boolean; folders?: string[] };

export interface BackupDeps {
  sup: SupervisorApi;
  sleep: Sleep;
  now: Clock;
  /** Give up waiting after this long (full backups on a Pi with a big media folder are slow). */
  timeoutMs?: number;
  pollMs?: number;
}

interface BackupListItem {
  slug: string;
  name: string;
  date: string;
}

async function findByName(sup: SupervisorApi, name: string): Promise<BackupListItem | null> {
  const list = await sup.get<{ backups?: BackupListItem[] }>('/backups');
  const matches = (list.backups ?? []).filter((b) => b.name === name).sort((a, b) => (a.date < b.date ? 1 : -1));
  return matches[0] ?? null;
}

export async function createBackup(deps: BackupDeps, spec: BackupSpec): Promise<{ slug: string; name: string }> {
  const { sup, sleep, now } = deps;
  const timeoutMs = deps.timeoutMs ?? 90 * 60 * 1000;
  const pollMs = deps.pollMs ?? 10_000;
  const body =
    spec.kind === 'full'
      ? { name: spec.name, background: true }
      : {
          name: spec.name,
          background: true,
          ...(spec.addons ? { addons: spec.addons } : {}),
          ...(spec.homeassistant !== undefined ? { homeassistant: spec.homeassistant } : {}),
          ...(spec.folders ? { folders: spec.folders } : {}),
        };
  const started = await sup.post<{ slug?: string; job_id?: string }>(`/backups/new/${spec.kind}`, body, { timeoutMs: timeoutMs });
  if (started.slug) return { slug: started.slug, name: spec.name };

  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    if (started.job_id) {
      try {
        const job = await sup.get<{ done?: boolean; reference?: string | null; errors?: { message?: string }[] }>(`/jobs/${started.job_id}`);
        if (job.done) {
          const errs = (job.errors ?? []).map((e) => e.message ?? 'unknown error');
          if (errs.length) throw new Error(`backup '${spec.name}' failed: ${errs.join('; ')}`);
          if (job.reference) return { slug: job.reference, name: spec.name };
        } else {
          continue;
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith(`backup '${spec.name}' failed`)) throw e;
        // Job endpoint unavailable on this Supervisor: fall back to looking for the backup by name.
      }
    }
    const found = await findByName(sup, spec.name);
    if (found) return { slug: found.slug, name: found.name };
  }
  throw new Error(`backup '${spec.name}' did not finish within ${Math.round(timeoutMs / 60000)} min`);
}
