import { describe, expect, it } from 'vitest';
import { collectSportsFeed, gameOn, trimEvents } from '../src/sportsFeed.js';

const EVENT = {
  id: 1505482,
  date: '2026-10-25T19:00:00',
  status: 'future',
  link: 'https://ibasketball.co.il/match/780137/',
  venues: [18933],
  stream: [],
  teams: [166316, 595722],
  home: { team: 'מכבי תל אביב/שוהם', points: null, link: 'x' },
  away: { team: 'הפועל רמת גן/גבעתיים', points: null },
  league: { name: 'ארצית דרום', link: 'x' },
  leagues: [119896],
  seasons: [119888],
  content: { rendered: '<p>big</p>' },
  _links: { self: [] },
};

describe('sports feed', () => {
  it('keeps only the fields the Hub parses', () => {
    const [e] = trimEvents([EVENT, { nope: true }]);
    expect(Object.keys(e!).sort()).toEqual(['away', 'date', 'home', 'id', 'league', 'leagues', 'link', 'quarter_current', 'quarter_current_time', 'seasons', 'state', 'status', 'stream', 'teams', 'venues']);
    expect(e!.league).toEqual({ name: 'ארצית דרום' });
    expect(trimEvents('not a list')).toEqual([]);
  });

  it('fetches only the fixed ibasketball URLs and names venues', async () => {
    const urls: string[] = [];
    const feed = await collectSportsFeed(async (u) => {
      urls.push(u);
      if (u.includes('/venues/')) return { name: ' Shoham ' };
      if (u.includes('/tables')) return [{ data: { '595722': { pos: 3, w: 2, l: 1, strk: '<span>W2</span>', name: 'x' }, '0': { pos: 'Pos' } } }];
      if (u.includes('/teams?')) return [{ id: 595722, _embedded: { 'wp:featuredmedia': [{ media_details: { sizes: { thumbnail: { source_url: 'https://ibasketball.co.il/wp-content/uploads/x-150x150.png' } } } }] } }];
      return [EVENT];
    }, Date.parse('2026-10-23T00:00:00Z'));
    expect(urls.every((u) => u.startsWith('https://ibasketball.co.il/wp-json/sportspress/v2/'))).toBe(true);
    expect(urls[0]).toContain('teams=595722');
    expect(feed.venues).toEqual({ '18933': 'Shoham' });
    expect(feed.events).toHaveLength(1);
    expect(urls.some((u) => u.includes('/tables?leagues=119896&seasons=119888'))).toBe(true);
    expect(feed.table).toEqual({ '595722': { pos: 3, w: 2, l: 1, strk: 'W2' } });
    expect(feed.logos).toEqual({ '595722': 'https://ibasketball.co.il/wp-content/uploads/x-150x150.png' });
  });

  it('polls live only while a game is on (Israel wall-clock dates)', () => {
    const [e] = trimEvents([{ ...EVENT, state: '', quarter_current: '3', quarter_current_time: '10:00' }]);
    expect(e).toMatchObject({ state: '', quarter_current: '3', quarter_current_time: '10:00' });
    // 19:00 Israel (UTC+2) = 17:00 UTC.
    expect(gameOn([e!], Date.parse('2026-10-25T18:00:00Z'))).toBe(true);
    expect(gameOn([e!], Date.parse('2026-10-25T16:50:00Z'))).toBe(true);
    expect(gameOn([e!], Date.parse('2026-10-25T15:00:00Z'))).toBe(false);
    expect(gameOn([e!], Date.parse('2026-10-25T21:00:00Z'))).toBe(false);
    expect(gameOn([{ ...e!, state: 'finished' }], Date.parse('2026-10-25T18:00:00Z'))).toBe(false);
  });
});
