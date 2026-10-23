/**
 * Hapoel Ramat Gan basketball schedule relay. ibasketball.co.il (the Israel Basketball Association)
 * sits behind Cloudflare rules that refuse Google Cloud IPs, so Home Hub's functions can't read it;
 * the Pi (a home connection) fetches this ONE fixed public URL every 2 h and writes the trimmed JSON
 * (plus the league table and team logos) to hub/main/home/sportsIba, which the Hub's sports sync parses. Not a generic proxy: the URL is a
 * constant here, nothing from the Hub decides what is fetched.
 */
import { PATHS } from './contract.js';
import { errMsg, logger } from './log.js';
import type { HubStore } from './store.js';

const log = logger('sports');

export const SPORTS_FEED_MS = 2 * 60 * 60_000;
const IBA = 'https://ibasketball.co.il/wp-json/sportspress/v2';
/** Hapoel Ramat Gan/Givatayim (men), Liga Artzit. */
const TEAM_ID = 595722;
const PAST_DAYS = 10;
const AHEAD_DAYS = 75;
const MAX_EVENTS = 100;

type Fetch = (url: string) => Promise<unknown>;

const str = (v: unknown, max = 300) => (typeof v === 'string' ? v.slice(0, max) : null);
const nums = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number').slice(0, 3) : []);
const strip = (v: unknown, max = 20) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim().slice(0, max) : null);

/** League tables (SportsPress `data`: { [teamId]: { pos, w, l, strk, ... } }) -> just pos/w/l/streak. */
export function trimTable(raw: unknown): Record<string, { pos: unknown; w: unknown; l: unknown; strk: string | null }> {
  const out: Record<string, { pos: unknown; w: unknown; l: unknown; strk: string | null }> = {};
  const data = (Array.isArray(raw) ? (raw[0] as { data?: unknown } | undefined)?.data : null) as Record<string, Record<string, unknown>> | null;
  for (const [id, r] of Object.entries(data ?? {})) {
    if (!/^\d+$/.test(id) || !r || typeof r !== 'object' || typeof r.pos !== 'number') continue; // '0' = header row
    out[id] = { pos: typeof r.pos === 'number' ? r.pos : null, w: typeof r.w === 'number' ? r.w : null, l: typeof r.l === 'number' ? r.l : null, strk: strip(r.strk) };
  }
  return out;
}

/** Team id -> logo thumbnail URL from `/teams?include=...&_embed=wp:featuredmedia`. */
export function trimLogos(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []) {
    const media = ((t._embedded as Record<string, unknown> | undefined)?.['wp:featuredmedia'] as Record<string, unknown>[] | undefined)?.[0];
    const sizes = (media?.media_details as { sizes?: Record<string, { source_url?: unknown }> } | undefined)?.sizes;
    const url = str(sizes?.thumbnail?.source_url ?? media?.source_url, 500);
    if (typeof t.id === 'number' && url?.startsWith('https://ibasketball.co.il/')) out[String(t.id)] = url;
  }
  return out;
}

/** Just the fields the Hub's parser reads (see Home Hub functions/src/sports/parse.ts parseIba). */
export function trimEvents(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, MAX_EVENTS).flatMap((e: Record<string, unknown>) => {
    if (typeof e?.id !== 'number' || typeof e.date !== 'string') return [];
    const side = (s: unknown) => {
      const o = (s ?? {}) as { team?: unknown; points?: unknown };
      return { team: str(o.team, 160), points: typeof o.points === 'number' || typeof o.points === 'string' ? o.points : null };
    };
    return [
      {
        id: e.id,
        date: e.date.slice(0, 25),
        status: str(e.status, 20),
        link: str(e.link, 500),
        venues: Array.isArray(e.venues) ? e.venues.filter((v) => typeof v === 'number').slice(0, 3) : [],
        stream: JSON.stringify(e.stream ?? null).slice(0, 1000),
        teams: Array.isArray(e.teams) ? e.teams.filter((v) => typeof v === 'number').slice(0, 2) : [],
        home: side(e.home),
        away: side(e.away),
        league: { name: str((e.league as { name?: unknown } | undefined)?.name, 120) },
        leagues: nums(e.leagues),
        seasons: nums(e.seasons),
      },
    ];
  });
}

export async function collectSportsFeed(get: Fetch, now = Date.now()) {
  const day = 86_400_000;
  const after = new Date(now - PAST_DAYS * day).toISOString().slice(0, 19);
  const before = new Date(now + AHEAD_DAYS * day).toISOString().slice(0, 19);
  const events = trimEvents(await get(`${IBA}/events?teams=${TEAM_ID}&after=${after}&before=${before}&per_page=${MAX_EVENTS}`));
  const venues: Record<string, string> = {};
  const ids = [...new Set(events.flatMap((e) => (e.venues as number[]).slice(0, 1)))].slice(0, 30);
  for (const id of ids) {
    try {
      const name = str(((await get(`${IBA}/venues/${id}?_fields=name`)) as { name?: unknown }).name, 160);
      if (name) venues[String(id)] = name.trim();
    } catch {
      /* venue names are optional */
    }
  }
  // The table of the team's league (the first league/season its games list) + every team's logo.
  let table: ReturnType<typeof trimTable> = {};
  const league = events.flatMap((e) => (e.leagues as number[]).map((l) => [l, (e.seasons as number[])[0]] as const))[0];
  if (league) {
    try {
      table = trimTable(await get(`${IBA}/tables?leagues=${league[0]}${league[1] ? `&seasons=${league[1]}` : ''}&per_page=1`));
    } catch {
      /* table is optional */
    }
  }
  let logos: Record<string, string> = {};
  const teamIds = [...new Set(events.flatMap((e) => e.teams as number[]))].slice(0, 40);
  if (teamIds.length) {
    try {
      logos = trimLogos(await get(`${IBA}/teams?include=${teamIds.join(',')}&per_page=50&_embed=wp:featuredmedia`));
    } catch {
      /* logos are optional */
    }
  }
  return { teamId: TEAM_ID, fetchedAt: new Date(now).toISOString(), events, venues, table, logos };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function relaySportsFeed(store: HubStore): Promise<void> {
  try {
    const feed = await collectSportsFeed(getJson);
    await store.set(PATHS.homeSportsIba, feed);
    log.info('Sports feed written', { events: feed.events.length });
  } catch (e) {
    log.warn('Sports feed failed', { error: errMsg(e) });
  }
}
