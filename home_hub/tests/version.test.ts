import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ADDON_VERSION } from '../src/config.js';

const root = join(import.meta.dirname, '..');

describe('version', () => {
  it('config.yaml, package.json, CHANGELOG and ADDON_VERSION agree', () => {
    const yaml = readFileSync(join(root, 'config.yaml'), 'utf8').match(/^version:\s*"?([^"\s]+)"?\s*$/m)?.[1];
    const pkg = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8').match(/^## (\S+)/m)?.[1];
    expect(yaml).toBe(ADDON_VERSION);
    expect(pkg).toBe(ADDON_VERSION);
    expect(changelog).toBe(ADDON_VERSION);
  });
});
