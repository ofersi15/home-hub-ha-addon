/**
 * Per-add-on scheduled auto-update (settings.autoUpdate[slug] === true), only inside
 * settings.autoUpdateWindow (New York wall clock). Core, OS and Supervisor are NEVER auto-updated.
 */
import { PLATFORM_TARGETS, type HomeSettings } from './contract.js';
import { nyParts } from './util.js';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(s: string): number | null {
  const m = s.match(HHMM);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** True when `nowMs` (NY local time) is in [start, end). Handles windows that wrap midnight. start == end -> never. */
export function inWindow(nowMs: number, window: { start: string; end: string }): boolean {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null || start === end) return false;
  const cur = nyParts(nowMs).minutes;
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

export interface AddonUpdateCandidate {
  slug: string;
  updateAvailable: boolean;
  latest: string;
}

/**
 * Add-ons to auto-update now. `attempted` holds `${slug}@${version}` already tried (success or not), so a
 * failing update isn't retried in a loop; a newer version gets a fresh attempt.
 */
export function pickAutoUpdates(
  settings: Pick<HomeSettings, 'autoUpdate' | 'autoUpdateWindow'>,
  addons: AddonUpdateCandidate[],
  nowMs: number,
  attempted: ReadonlySet<string>,
  selfSlug: string | null,
): AddonUpdateCandidate[] {
  if (!inWindow(nowMs, settings.autoUpdateWindow)) return [];
  return addons.filter(
    (a) =>
      a.updateAvailable &&
      settings.autoUpdate[a.slug] === true &&
      !(PLATFORM_TARGETS as readonly string[]).includes(a.slug) &&
      a.slug !== selfSlug &&
      !attempted.has(`${a.slug}@${a.latest}`),
  );
}
