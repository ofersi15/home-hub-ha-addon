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

  it('0.2.0 additions are exact: job list, backup info/delete by slug, add-on start, one resolution suggestion', () => {
    expect(isAllowed('GET', '/jobs/info')).toBe(true);
    expect(isAllowed('GET', '/backups/1a2b3c4d/info')).toBe(true);
    expect(isAllowed('POST', '/addons/local_threadfin/start')).toBe(true);
    expect(isAllowed('POST', `/resolution/suggestion/${'a'.repeat(32)}`)).toBe(true);
    expect(isAllowed('DELETE', '/backups/1a2b3c4d')).toBe(true);
    // Host power stays refused directly; a reboot only happens via a Supervisor suggestion after our own OS update.
    for (const p of ['/host/reboot', '/host/shutdown', '/os/reboot', '/resolution/suggestion/x', '/resolution/healthcheck', '/resolution/issue/abc/fix', '/addons/x/uninstall', '/store/addons/x/install']) {
      expect(isAllowed('POST', p), p).toBe(false);
    }
    for (const p of ['/backups/1a2b3c4d/restore/full', '/backups', '/backups/../x', '/backups/1A2B3C4D', '/addons/local_x', `/resolution/suggestion/${'a'.repeat(32)}`, '/resolution/issue/x', '/jobs/abcdef12-0000', '/host/reboot']) {
      expect(isAllowed('DELETE', p), p).toBe(false);
    }
    for (const p of ['/backups/1a2b3c4d', '/backups/1a2b3c4d/download']) expect(isAllowed('GET', p), p).toBe(false);
  });
});
