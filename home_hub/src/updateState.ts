/**
 * The global update lock, persisted in /data/update-state.json. Exactly one update runs at a time, and
 * the record survives what an update does to us (Core restart, host reboot, Supervisor restart), so the
 * next start can finish verifying it and complete its command doc.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const UpdatePhase = z.enum(['backup', 'updating', 'verifying']);
export type UpdatePhase = z.infer<typeof UpdatePhase>;

export const UpdateState = z.object({
  target: z.string(),
  fromVersion: z.string(),
  toVersion: z.string(),
  backupName: z.string(),
  phase: UpdatePhase,
  /** When this update started (ms since epoch). */
  startedAt: z.number(),
  /** homeCommands doc that audits this update (null only for legacy records). */
  commandId: z.string().nullable(),
  /** Add-on updates: it was running before, so it must be running after. */
  requireStarted: z.boolean().default(false),
  /** Started by the add-on's auto-update (counts toward the 6 h backoff / 2-strike block). */
  auto: z.boolean().default(false),
});
export type UpdateState = z.infer<typeof UpdateState>;

export interface UpdateStateStore {
  load(): UpdateState | null;
  save(s: UpdateState): void;
  clear(): void;
}

/** 0.1.0 kept a slimmer record in inflight.json (written just before the update call). */
const LegacyInflight = z.object({
  commandId: z.string().nullable(),
  target: z.string(),
  version: z.string(),
  fromVersion: z.string(),
  backupName: z.string(),
  startedAt: z.number(),
  requireStarted: z.boolean(),
});

export function fileUpdateStateStore(dir: string): UpdateStateStore {
  const file = join(dir, 'update-state.json');
  const legacy = join(dir, 'inflight.json');
  const write = (s: UpdateState) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(s), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  };
  return {
    load(): UpdateState | null {
      try {
        if (existsSync(file)) return UpdateState.parse(JSON.parse(readFileSync(file, 'utf8')));
        if (existsSync(legacy)) {
          const l = LegacyInflight.parse(JSON.parse(readFileSync(legacy, 'utf8')));
          const s: UpdateState = { ...l, toVersion: l.version, phase: 'updating', auto: false };
          write(s);
          rmSync(legacy, { force: true });
          return s;
        }
      } catch {
        /* unreadable: treat as no update in flight */
      }
      return null;
    },
    save: write,
    clear(): void {
      rmSync(file, { force: true });
      rmSync(legacy, { force: true });
    },
  };
}

/** In-memory store (tests; also documents the contract of the file store). */
export function memoryUpdateStateStore(initial: UpdateState | null = null): UpdateStateStore & { history: (UpdatePhase | 'cleared')[] } {
  let cur = initial;
  const history: (UpdatePhase | 'cleared')[] = [];
  return {
    history,
    load: () => (cur ? { ...cur } : null),
    save: (s) => {
      cur = { ...s };
      history.push(s.phase);
    },
    clear: () => {
      cur = null;
      history.push('cleared');
    },
  };
}
