/**
 * Device auth: signed POST {hub}/api/home/token -> Firebase custom token (+ web config), then
 * signInWithCustomToken. The SDK refreshes the ID token itself; on an auth failure we re-exchange
 * with backoff (single flight).
 */
import { createHmac } from 'node:crypto';
import { HOME_API, HomeTokenResponse, homeTokenSigningString } from './contract.js';
import { errMsg, logger, registerSecret } from './log.js';
import { HttpError, type DeviceRecord, type FetchFn } from './pairing.js';

const log = logger('auth');

export const TOKEN_PATH = HOME_API.token;
export type TokenResponse = HomeTokenResponse;

export function tokenRequestHeaders(device: Pick<DeviceRecord, 'deviceId' | 'deviceKey'>, nowMs: number): Record<string, string> {
  const ts = String(nowMs);
  return {
    'X-Home-Device': device.deviceId,
    'X-Home-Timestamp': ts,
    'X-Home-Signature': createHmac('sha256', device.deviceKey).update(homeTokenSigningString(ts)).digest('hex'),
  };
}

export async function exchangeToken(
  hubUrl: string,
  device: Pick<DeviceRecord, 'deviceId' | 'deviceKey'>,
  fetchFn: FetchFn = fetch,
  now: () => number = Date.now,
): Promise<TokenResponse> {
  const res = await fetchFn(new URL(TOKEN_PATH, hubUrl), {
    method: 'POST',
    headers: tokenRequestHeaders(device, now()),
    body: '',
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new HttpError(res.status, `token exchange failed (HTTP ${res.status})`);
  const parsed = HomeTokenResponse.safeParse(await res.json());
  if (!parsed.success || !parsed.data.customToken) throw new HttpError(502, 'token response has an unexpected shape');
  registerSecret(parsed.data.customToken);
  return parsed.data;
}

/** Single-flight wrapper: concurrent callers share one in-progress re-auth. */
export function singleFlight<T>(fn: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (!inFlight) {
      inFlight = fn().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

export function isAuthError(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === 'permission-denied' || code === 'unauthenticated' || (typeof code === 'string' && code.startsWith('auth/'));
}

export function logAuthError(what: string, e: unknown): void {
  log.warn(`${what} failed`, { errCode: (e as { code?: string } | null)?.code ?? null, error: errMsg(e) });
}
