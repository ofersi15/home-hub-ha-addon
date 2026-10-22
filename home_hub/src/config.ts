import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** Must match config.yaml `version` and package.json (tests/version.test.ts checks). */
export const ADDON_VERSION = '0.1.0';

/** The add-on's private persistent volume (mapped by the Supervisor). */
export const DATA_DIR = process.env.HOME_HUB_DATA_DIR ?? '/data';

export class FatalConfigError extends Error {
  override name = 'FatalConfigError';
}

export const Options = z.object({
  hub_url: z
    .url()
    .refine((u) => u.startsWith('https://'), 'hub_url must be https://')
    .transform((u) => u.replace(/\/+$/, '')),
  pairing_code: z
    .string()
    .optional()
    .transform((c) => (c ?? '').trim()),
});
export type Options = z.infer<typeof Options>;

export function parseOptions(raw: unknown): Options {
  const r = Options.safeParse(raw);
  if (!r.success) {
    throw new FatalConfigError(`Invalid add-on options: ${r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  return r.data;
}

export function loadOptions(path = `${DATA_DIR}/options.json`): Options {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new FatalConfigError(`Cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseOptions(raw);
}
