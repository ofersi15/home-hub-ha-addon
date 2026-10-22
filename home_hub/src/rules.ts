/**
 * Event rules from settings/home. A rule's condition is either
 *  - `toState`: the entity's state equals it (e.g. door 'on'), or
 *  - `below`:   the state parsed as a number is < below (e.g. blinds battery < 20). 'unknown',
 *               'unavailable' and other non-numbers are ignored: they neither start nor end an episode.
 * An episode is a continuous stretch where the condition holds. Per episode the rule fires once, after
 * the condition held `forMinutes`; with `repeatHours > 0` it fires again at most once per that many
 * hours while the episode lasts. Firing writes homeEvents/{autoId}; the Hub turns it into a push/task.
 */
import type { HomeEventRule } from './contract.js';

export type FireFn = (rule: HomeEventRule, entityId: string, state: string, atMs: number) => void;

const IGNORED = new Set(['unknown', 'unavailable', 'none', '']);
const HOUR = 60 * 60 * 1000;

/** true/false = condition holds or not; null = no information (numeric rule on a non-number). */
export function conditionHolds(rule: Pick<HomeEventRule, 'toState' | 'below'>, state: string | null): boolean | null {
  if (rule.toState !== null) return state === rule.toState;
  if (rule.below === null) return false;
  if (state === null || IGNORED.has(state.toLowerCase())) return null;
  const n = Number.parseFloat(state);
  return Number.isFinite(n) ? n < rule.below : null;
}

interface Episode {
  entityId: string;
  /** Latest state seen during the episode (reported on repeat fires). */
  state: string;
  firedAt: number | null;
  timer: ReturnType<typeof setTimeout> | null;
}

export class RuleEngine {
  private rules: HomeEventRule[] = [];
  private episodes = new Map<string, Episode>();

  constructor(
    private readonly fire: FireFn,
    private readonly now: () => number = Date.now,
  ) {}

  setRules(rules: HomeEventRule[]): void {
    const next = rules.filter((r) => r.enabled);
    const sig = (r: HomeEventRule) => JSON.stringify([r.entityId, r.toState, r.below, r.forMinutes, r.repeatHours]);
    const keep = new Map(next.map((r) => [r.id, sig(r)]));
    for (const old of this.rules) {
      if (keep.get(old.id) !== sig(old)) this.end(old.id);
    }
    this.rules = next;
  }

  /**
   * On start / reconnect: adopt states that already match. The remaining `forMinutes` is armed; an
   * episode already past its threshold counts as fired now (it may have fired before we started), so a
   * restart never double-fires; with repeatHours the next repeat is due a full period later.
   */
  seed(states: { entityId: string; state: string; lastChangedMs: number }[]): void {
    for (const s of states) {
      for (const rule of this.rulesFor(s.entityId)) {
        const holds = conditionHolds(rule, s.state);
        if (holds === null) continue;
        if (!holds) {
          this.end(rule.id);
          continue;
        }
        if (this.episodes.has(rule.id)) continue;
        const ep: Episode = { entityId: s.entityId, state: s.state, firedAt: null, timer: null };
        this.episodes.set(rule.id, ep);
        const remaining = s.lastChangedMs + rule.forMinutes * 60_000 - this.now();
        if (rule.forMinutes > 0 && remaining > 0) {
          this.schedule(rule, ep, remaining, () => this.doFire(rule, ep));
        } else {
          ep.firedAt = this.now();
          this.scheduleRepeat(rule, ep);
        }
      }
    }
  }

  onStateChange(entityId: string, oldState: string | null, newState: string | null): void {
    for (const rule of this.rulesFor(entityId)) {
      const holds = conditionHolds(rule, newState);
      if (holds === null) continue; // unknown/unavailable on a numeric rule: no information
      if (!holds) {
        this.end(rule.id);
        continue;
      }
      const cur = this.episodes.get(rule.id);
      if (cur) {
        // Same episode (attribute change, or 15% -> 14%): never a new fire.
        cur.state = newState as string;
        continue;
      }
      const ep: Episode = { entityId, state: newState as string, firedAt: null, timer: null };
      this.episodes.set(rule.id, ep);
      if (conditionHolds(rule, oldState) === true) {
        // Not a transition (the rule appeared mid-episode): adopt it as already fired, like seed().
        ep.firedAt = this.now();
        this.scheduleRepeat(rule, ep);
        continue;
      }
      if (rule.forMinutes === 0) this.doFire(rule, ep);
      else this.schedule(rule, ep, rule.forMinutes * 60_000, () => this.doFire(rule, ep));
    }
  }

  stop(): void {
    for (const id of [...this.episodes.keys()]) this.end(id);
  }

  pendingTimers(): number {
    return [...this.episodes.values()].filter((e) => e.timer !== null).length;
  }

  private rulesFor(entityId: string): HomeEventRule[] {
    return this.rules.filter((r) => r.entityId === entityId);
  }

  private doFire(rule: HomeEventRule, ep: Episode): void {
    if (this.episodes.get(rule.id) !== ep) return; // episode ended meanwhile
    ep.timer = null;
    ep.firedAt = this.now();
    this.fire(rule, ep.entityId, ep.state, ep.firedAt);
    this.scheduleRepeat(rule, ep);
  }

  private scheduleRepeat(rule: HomeEventRule, ep: Episode): void {
    if (rule.repeatHours > 0) this.schedule(rule, ep, rule.repeatHours * HOUR, () => this.doFire(rule, ep));
  }

  private schedule(rule: HomeEventRule, ep: Episode, ms: number, fn: () => void): void {
    if (ep.timer) clearTimeout(ep.timer);
    ep.timer = setTimeout(() => {
      ep.timer = null;
      if (this.episodes.get(rule.id) === ep) fn();
    }, ms);
  }

  private end(ruleId: string): void {
    const ep = this.episodes.get(ruleId);
    if (ep?.timer) clearTimeout(ep.timer);
    this.episodes.delete(ruleId);
  }
}
