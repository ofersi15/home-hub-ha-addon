import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FatalConfigError } from '../src/config.js';
import { clearSecrets, setLogSink } from '../src/log.js';
import { codeHash, ensurePaired, loadDevice, type FetchFn } from '../src/pairing.js';

const KEY = 'SECRETdeviceKEY_0123456789-abcdefghijklmnop'; // 43 chars, base64url
const KEY2 = 'ANOTHERdeviceKEY_0123456789-abcdefghijklmno';
const ID1 = 'Dev1aaaaaaaaaaaaaaaa'; // 20 alnum
const ID2 = 'Dev2bbbbbbbbbbbbbbbb';
let dir: string;
let lines: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hub-pair-'));
  lines = [];
  setLogSink((l) => lines.push(l));
  clearSecrets();
});
afterEach(() => setLogSink(() => {}));

function fakeFetch(status: number, body: unknown, seen: { url?: string; body?: string }[] = []): FetchFn {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: String(init?.body ?? '') });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as FetchFn;
}

const base = { hubUrl: 'https://oferel-hub.web.app', haInstance: 'machine-123', addonVersion: '0.1.0' };

describe('pairing', () => {
  it('pairs with the code, stores device.json privately, never logs the key or id', async () => {
    const seen: { url?: string; body?: string }[] = [];
    const rec = await ensurePaired({ ...base, dir, pairingCode: ' ABCD-1234 ', fetchFn: fakeFetch(200, { deviceId: ID1, deviceKey: KEY }, seen) });
    expect(rec).toMatchObject({ deviceId: ID1, deviceKey: KEY, hubUrl: base.hubUrl, codeHash: codeHash('ABCD-1234') });
    expect(seen[0]?.url).toBe('https://oferel-hub.web.app/api/home/pair');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ code: 'ABCD-1234', haInstance: 'machine-123', addonVersion: '0.1.0' });

    const stored = JSON.parse(readFileSync(join(dir, 'device.json'), 'utf8'));
    expect(stored.deviceKey).toBe(KEY);
    expect(stored).not.toHaveProperty('code');
    if (process.platform !== 'win32') expect(statSync(join(dir, 'device.json')).mode & 0o777).toBe(0o600);

    const all = lines.join('\n');
    expect(all).not.toContain(KEY);
    expect(all).not.toContain(ID1);
    expect(all).not.toContain('ABCD-1234');
    expect(all).toMatch(/clear .{0,2}pairing_code/);
  });

  it('reuses the stored device; the same (used) code does not re-pair', async () => {
    await ensurePaired({ ...base, dir, pairingCode: 'ABCD', fetchFn: fakeFetch(200, { deviceId: ID1, deviceKey: KEY }) });
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return new Response('{}', { status: 500 });
    }) as unknown as FetchFn;
    const again = await ensurePaired({ ...base, dir, pairingCode: 'ABCD', fetchFn });
    const noCode = await ensurePaired({ ...base, dir, pairingCode: '', fetchFn });
    expect(called).toBe(false);
    expect(again.deviceId).toBe(ID1);
    expect(noCode.deviceId).toBe(ID1);
  });

  it('a NEW code re-pairs; a rejected new code keeps the old pairing', async () => {
    await ensurePaired({ ...base, dir, pairingCode: 'ONE', fetchFn: fakeFetch(200, { deviceId: ID1, deviceKey: KEY }) });
    const kept = await ensurePaired({ ...base, dir, pairingCode: 'BAD', fetchFn: fakeFetch(403, { error: 'invalid code' }) });
    expect(kept.deviceId).toBe(ID1);
    const re = await ensurePaired({ ...base, dir, pairingCode: 'TWO', fetchFn: fakeFetch(200, { deviceId: ID2, deviceKey: KEY2 }) });
    expect(re.deviceId).toBe(ID2);
    expect(loadDevice(dir)?.deviceId).toBe(ID2);
  });

  it('no device and no code is a fatal config error; a rejected first code too', async () => {
    await expect(ensurePaired({ ...base, dir, pairingCode: '' })).rejects.toBeInstanceOf(FatalConfigError);
    await expect(ensurePaired({ ...base, dir, pairingCode: 'X', fetchFn: fakeFetch(400, { error: 'expired' }) })).rejects.toBeInstanceOf(FatalConfigError);
  });

  it('an off-contract pairing response is not accepted', async () => {
    const err = await ensurePaired({ ...base, dir, pairingCode: 'X', fetchFn: fakeFetch(200, { deviceId: 'x', deviceKey: 'short' }) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(loadDevice(dir)).toBeNull();
  });

  it('5xx is retryable (not fatal)', async () => {
    const err = await ensurePaired({ ...base, dir, pairingCode: 'X', fetchFn: fakeFetch(503, {}) }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(FatalConfigError);
  });

  it('a corrupt device.json counts as unpaired', () => {
    writeFileSync(join(dir, 'device.json'), '{not json');
    expect(loadDevice(dir)).toBeNull();
  });
});
