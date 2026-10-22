import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADDON_VERSION, FatalConfigError, parseOptions } from '../src/config.js';

const ROOT = join(import.meta.dirname, '..');
const configYaml = readFileSync(join(ROOT, 'config.yaml'), 'utf8');

describe('config.yaml', () => {
  it('versions agree (config.yaml, package.json, ADDON_VERSION)', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
    const m = configYaml.match(/^version:\s*"?([^"\s]+)"?/m);
    expect(m?.[1]).toBe(ADDON_VERSION);
    expect(pkg.version).toBe(ADDON_VERSION);
  });
  it('is outbound only: no ports, no host network, not privileged, no full access', () => {
    for (const key of ['ports', 'host_network', 'privileged', 'full_access', 'docker_api', 'host_pid', 'devices', 'uart', 'gpio', 'ingress']) {
      expect(configYaml, key).not.toMatch(new RegExp(`^${key}:`, 'm'));
    }
    expect(configYaml).toMatch(/^hassio_role: manager$/m);
    expect(configYaml).toMatch(/^slug: home_hub$/m);
    expect(configYaml).toMatch(/^init: false$/m);
  });
});

describe('options', () => {
  it('accepts the defaults and trims', () => {
    expect(parseOptions({ hub_url: 'https://oferel-hub.web.app/', pairing_code: ' 1234 ' })).toEqual({ hub_url: 'https://oferel-hub.web.app', pairing_code: '1234' });
    expect(parseOptions({ hub_url: 'https://oferel-hub.web.app' }).pairing_code).toBe('');
  });
  it('rejects non-https hub urls as a fatal config error', () => {
    expect(() => parseOptions({ hub_url: 'http://oferel-hub.web.app' })).toThrow(FatalConfigError);
    expect(() => parseOptions({ hub_url: 'not a url' })).toThrow(FatalConfigError);
  });
});
