/**
 * One-time pairing with Home Hub. The single-use code from Hub Settings -> Home -> Pair is exchanged
 * for { deviceId, deviceKey }, stored in /data/device.json (the add-on's private volume, mode 0600).
 * Neither value is ever logged.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { FatalConfigError } from './config.js';
import { HOME_API, HomePairRequest, HomePairResponse } from './contract.js';
import { logger, registerSecret } from './log.js';

const log = logger('pairing');

export const DeviceRecord = z.object({
  deviceId: z.string().min(1).max(200),
  deviceKey: z.string().min(16).max(512),
  hubUrl: z.string(),
  pairedAt: z.string(),
  /** sha256 of the pairing code that produced this record, so a NEW code in the options re-pairs. */
  codeHash: z.string(),
});
export type DeviceRecord = z.infer<typeof DeviceRecord>;


export class HttpError extends Error {
  override name = 'HttpError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 408;
  }
}

export type FetchFn = typeof fetch;

export const codeHash = (code: string): string => createHash('sha256').update(code.trim()).digest('hex');

const deviceFile = (dir: string) => join(dir, 'device.json');

export function loadDevice(dir: string): DeviceRecord | null {
  const file = deviceFile(dir);
  if (!existsSync(file)) return null;
  try {
    const rec = DeviceRecord.parse(JSON.parse(readFileSync(file, 'utf8')));
    registerSecret(rec.deviceKey);
    return rec;
  } catch {
    log.warn('device.json is unreadable; treating the add-on as unpaired');
    return null;
  }
}

export function saveDevice(dir: string, rec: DeviceRecord): void {
  mkdirSync(dir, { recursive: true });
  const file = deviceFile(dir);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec), { mode: 0o600 });
  renameSync(tmp, file);
}

export async function pairDevice(args: {
  hubUrl: string;
  code: string;
  haInstance: string;
  addonVersion: string;
  fetchFn?: FetchFn;
}): Promise<{ deviceId: string; deviceKey: string }> {
  const fetchFn = args.fetchFn ?? fetch;
  const body: HomePairRequest = HomePairRequest.parse({ code: args.code, haInstance: args.haInstance.slice(0, 200) || 'Home Assistant', addonVersion: args.addonVersion });
  const res = await fetchFn(new URL(HOME_API.pair, args.hubUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    let reason = '';
    try {
      const body = (await res.json()) as { error?: unknown };
      if (typeof body.error === 'string') reason = `: ${body.error.slice(0, 200)}`;
    } catch {
      /* no body */
    }
    throw new HttpError(res.status, `pairing failed (HTTP ${res.status})${reason}`);
  }
  const parsed = HomePairResponse.safeParse(await res.json());
  if (!parsed.success) throw new HttpError(502, 'pairing response has an unexpected shape');
  registerSecret(parsed.data.deviceKey);
  return parsed.data;
}

/**
 * Returns the stored device, pairing first when needed:
 *  - stored device + no code / same code as before -> stored device (code already used; harmless to keep);
 *  - new code -> pair (re-pair if a device exists; on a 4xx keep the old device);
 *  - no device and no code -> fatal config error with instructions.
 */
export async function ensurePaired(args: {
  dir: string;
  hubUrl: string;
  pairingCode: string;
  haInstance: string;
  addonVersion: string;
  fetchFn?: FetchFn;
  now?: () => number;
}): Promise<DeviceRecord> {
  const existing = loadDevice(args.dir);
  const code = args.pairingCode.trim();
  if (existing && (!code || codeHash(code) === existing.codeHash)) {
    if (code) log.info('Already paired with this code. You can clear pairing_code from the add-on options.');
    if (existing.hubUrl !== args.hubUrl) log.warn('hub_url differs from the Hub this add-on was paired with; using the configured hub_url');
    return existing;
  }
  if (!code) {
    throw new FatalConfigError('Not paired yet. In Home Hub open Settings -> Home -> Pair, copy the code into this add-on\'s "pairing_code" option, save, and start the add-on again.');
  }
  try {
    const paired = await pairDevice({ hubUrl: args.hubUrl, code, haInstance: args.haInstance, addonVersion: args.addonVersion, fetchFn: args.fetchFn });
    const rec: DeviceRecord = {
      ...paired,
      hubUrl: args.hubUrl,
      pairedAt: new Date((args.now ?? Date.now)()).toISOString(),
      codeHash: codeHash(code),
    };
    saveDevice(args.dir, rec);
    log.info(existing ? 'Re-paired with Home Hub.' : 'Paired with Home Hub.', {});
    log.info('Pairing done: you can now clear "pairing_code" in the add-on options (the code is single use, so leaving it is harmless).');
    return rec;
  } catch (e) {
    if (e instanceof HttpError && !e.retryable) {
      if (existing) {
        log.warn('New pairing code was rejected; keeping the existing pairing', { status: e.status });
        return existing;
      }
      throw new FatalConfigError(`${e.message}. Get a fresh code from Home Hub Settings -> Home -> Pair.`);
    }
    throw e; // network / 5xx: caller retries with backoff
  }
}
