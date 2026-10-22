/**
 * Guardrail: the add-on never runs processes or shells, and never calls Supervisor host power or
 * uninstall endpoints. Greps the shipped source (src/) and fails on any occurrence.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAllowed } from '../src/supervisor.js';

const SRC = join(import.meta.dirname, '..', 'src');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const FORBIDDEN: [string, RegExp][] = [
  ['child_process', /child_process/],
  ['exec', /\bexec(Sync|File|FileSync)?\b/],
  ['spawn', /\bspawn(Sync)?\b/],
  ['/host/shutdown', /\/host\/shutdown/],
  ['/host/reboot', /\/host\/reboot/],
  ['/addons/*/uninstall', /\/addons\/[^\s'"`]*\/uninstall|\/uninstall\b/],
];

describe('no shell, no dangerous Supervisor calls', () => {
  const sources = files(SRC).filter((f) => f.endsWith('.ts'));
  it('finds the sources', () => {
    expect(sources.length).toBeGreaterThan(10);
  });
  for (const [label, re] of FORBIDDEN) {
    it(`src/ never mentions ${label}`, () => {
      const hits = sources.filter((f) => re.test(readFileSync(f, 'utf8')));
      expect(hits).toEqual([]);
    });
  }

  it('the runtime Supervisor allowlist refuses host power, uninstall and anything unlisted', () => {
    for (const p of ['/host/reboot', '/host/shutdown', '/addons/core_ssh/uninstall', '/os/datadisk/wipe', '/addons/x/stop', '/backups/abc/restore/full', '/addons/x/options', '/supervisor/options', '/host/options']) {
      expect(isAllowed('POST', p), p).toBe(false);
    }
    for (const p of ['/addons/x/logs', '/host/logs', '/backups/abc/download', '/auth/list', '/resolution/check/x']) {
      expect(isAllowed('GET', p), p).toBe(false);
    }
    for (const p of ['/backups/new/full', '/backups/new/partial', '/core/update', '/os/update', '/supervisor/update', '/store/addons/a0d7b954_vscode/update', '/addons/local_threadfin/restart']) {
      expect(isAllowed('POST', p), p).toBe(true);
    }
  });
});
