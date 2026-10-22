import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { singleFlight, exchangeToken, tokenRequestHeaders, TOKEN_PATH, isAuthError } from '../src/hubAuth.js';
import { homeTokenSigningString } from '../src/contract.js';
import { HttpError, type FetchFn } from '../src/pairing.js';

const device = { deviceId: 'dev_42', deviceKey: 'super-secret-device-key-0123456789' };

describe('token exchange signing', () => {
  it('signs `${ts}.POST./api/home/token.` with the device key (same scheme as functions/src/common/hmac.ts)', () => {
    const h = tokenRequestHeaders(device, 1_761_134_400_000);
    const expected = createHmac('sha256', device.deviceKey).update('1761134400000.POST./api/home/token.').digest('hex');
    expect(h).toEqual({ 'X-Home-Device': 'dev_42', 'X-Home-Timestamp': '1761134400000', 'X-Home-Signature': expected });
    expect(TOKEN_PATH).toBe('/api/home/token');
    expect(homeTokenSigningString('1761134400000')).toBe('1761134400000.POST./api/home/token.');
  });

  it('POSTs an empty body to {hub}/api/home/token and validates the response', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const fetchFn = (async (url: string | URL, init?: RequestInit) => {
      seen.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({ customToken: 'eyJhbGciOi.custom.token', firebaseConfig: { apiKey: 'AIza', authDomain: 'oferel-hub.web.app', projectId: 'home-hub-os26', appId: '1:2:web:3' } }),
        { status: 200 },
      );
    }) as FetchFn;
    const tok = await exchangeToken('https://oferel-hub.web.app', device, fetchFn, () => 1000);
    expect(seen[0]?.url).toBe('https://oferel-hub.web.app/api/home/token');
    expect(seen[0]?.init?.method).toBe('POST');
    expect(seen[0]?.init?.body).toBe('');
    expect(tok.firebaseConfig.projectId).toBe('home-hub-os26');
  });

  it('maps HTTP failures to HttpError', async () => {
    const fetchFn = (async () => new Response('{}', { status: 401 })) as unknown as FetchFn;
    await expect(exchangeToken('https://oferel-hub.web.app', device, fetchFn)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('auth helpers', () => {
  it('detects Firestore/Auth auth errors', () => {
    expect(isAuthError({ code: 'permission-denied' })).toBe(true);
    expect(isAuthError({ code: 'unauthenticated' })).toBe(true);
    expect(isAuthError({ code: 'auth/user-token-expired' })).toBe(true);
    expect(isAuthError({ code: 'unavailable' })).toBe(false);
    expect(isAuthError(null)).toBe(false);
  });
  it('single-flight shares one re-auth between concurrent callers', async () => {
    let n = 0;
    const f = singleFlight(async () => {
      n++;
      await new Promise((r) => setTimeout(r, 5));
      return n;
    });
    const [a, b] = await Promise.all([f(), f()]);
    expect([a, b, n]).toEqual([1, 1, 1]);
    await f();
    expect(n).toBe(2);
  });
});
