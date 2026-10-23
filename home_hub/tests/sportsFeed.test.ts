import { describe, expect, it } from 'vitest';
import { collectSportsFeed, trimEvents } from '../src/sportsFeed.js';

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
  content: { rendered: '<p>big</p>' },
  _links: { self: [] },
};

describe('sports feed', () => {
  it('keeps only the fields the Hub parses', () => {
    const [e] = trimEvents([EVENT, { nope: true }]);
    expect(Object.keys(e!).sort()).toEqual(['away', 'date', 'home', 'id', 'league', 'link', 'status', 'stream', 'teams', 'venues']);
    expect(e!.league).toEqual({ name: 'ארצית דרום' });
    expect(trimEvents('not a list')).toEqual([]);
  });

  it('fetches only the fixed ibasketball URLs and names venues', async () => {
    const urls: string[] = [];
    const feed = await collectSportsFeed(async (u) => {
      urls.push(u);
      return u.includes('/venues/') ? { name: ' Shoham ' } : [EVENT];
    }, Date.parse('2026-10-23T00:00:00Z'));
    expect(urls.every((u) => u.startsWith('https://ibasketball.co.il/wp-json/sportspress/v2/'))).toBe(true);
    expect(urls[0]).toContain('teams=595722');
    expect(feed.venues).toEqual({ '18933': 'Shoham' });
    expect(feed.events).toHaveLength(1);
  });
});
