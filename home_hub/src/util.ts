/** Small shared helpers: clock, sleep, backoff, New York time. */

export type Clock = () => number;
export const realClock: Clock = () => Date.now();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export type Sleep = typeof sleep;

export const iso = (ms: number): string => new Date(ms).toISOString();

/** Exponential backoff with jitter: 1s, 2s, 4s ... capped (default 5 min). */
export function backoffMs(attempt: number, baseMs = 1000, capMs = 5 * 60 * 1000, rand: () => number = Math.random): number {
  const exp = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + (rand() * exp) / 2);
}

/** Retry `fn` forever (or until `isFatal`) with backoff. */
export async function retryForever<T>(
  fn:() => Promise<T>,
  opts: { onError?: (e: unknown, attempt: number, waitMs: number) => void; isFatal?: (e: unknown) => boolean; sleepFn?: Sleep; capMs?: number } = {},
): Promise<T> {
  const sleepFn = opts.sleepFn ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (opts.isFatal?.(e)) throw e;
      const wait = backoffMs(attempt, 1000, opts.capMs);
      opts.onError?.(e, attempt, wait);
      await sleepFn(wait);
    }
  }
}

export const NY_TZ = 'America/New_York';

/** Wall-clock parts in New York for a UTC instant. */
export function nyParts(ms: number): { date: string; hhmm: string; minutes: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const hh = p.hour === '24' ? '00' : (p.hour ?? '00');
  const mm = p.minute ?? '00';
  return { date: `${p.year}-${p.month}-${p.day}`, hhmm: `${hh}:${mm}`, minutes: Number(hh) * 60 + Number(mm) };
}

/** Lowercase slug-ish text safe for backup names. */
export function safeName(s: string, max = 40): string {
  const out = s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return out || 'x';
}
