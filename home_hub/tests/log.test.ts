import { afterEach, describe, expect, it } from 'vitest';
import { clearSecrets, logger, redact, registerSecret, setLogSink } from '../src/log.js';

afterEach(() => {
  clearSecrets();
  setLogSink(() => {});
});

describe('structured logs never carry secrets', () => {
  it('masks secret-looking keys', () => {
    expect(redact({ deviceKey: 'abc', customToken: 'xyz', signature: 's', pairing_code: '1234', entityId: 'light.x', ok: true })).toEqual({
      deviceKey: '[redacted]',
      customToken: '[redacted]',
      signature: '[redacted]',
      pairing_code: '[redacted]',
      entityId: 'light.x',
      ok: true,
    });
  });
  it('scrubs registered secret values anywhere, including messages and errors', () => {
    const lines: string[] = [];
    setLogSink((l) => lines.push(l));
    registerSecret('SUPERVISORTOKEN123456');
    logger('t').warn('failed with SUPERVISORTOKEN123456 in url', { error: new Error('Bearer SUPERVISORTOKEN123456'), nested: { x: ['SUPERVISORTOKEN123456'] } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('SUPERVISORTOKEN123456');
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: 'warn', component: 't' });
  });
});
