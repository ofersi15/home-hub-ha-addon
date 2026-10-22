/** Persisted state of an update that may outlive this process (OS reboot, Supervisor/self restart). */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const Inflight = z.object({
  commandId: z.string().nullable(),
  target: z.string(),
  version: z.string(),
  fromVersion: z.string(),
  backupName: z.string(),
  startedAt: z.number(),
  requireStarted: z.boolean(),
});
export type Inflight = z.infer<typeof Inflight>;

export function inflightStore(dir: string) {
  const file = join(dir, 'inflight.json');
  return {
    load(): Inflight | null {
      if (!existsSync(file)) return null;
      try {
        return Inflight.parse(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        return null;
      }
    },
    save(i: Inflight): void {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(i), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    },
    clear(): void {
      rmSync(file, { force: true });
    },
  };
}
