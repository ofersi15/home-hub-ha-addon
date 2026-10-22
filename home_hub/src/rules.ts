/**
 * Event rules from settings/home: "entity enters state X (and stays there N minutes)" -> fire once.
 * Firing writes homeEvents/{autoId}; the Hub turns it into a push or a task.
 */
import type { HomeEventRule } from './contract.js';

export type FireFn = (rule: HomeEventRule, entityId: string, state: string, atMs: number) => void;

export class RuleEngine {
  private rules: HomeEventRule[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly fire: FireFn,
    private readonly now: () => number = Date.now,
  ) {}

  setRules(rules: HomeEventRule[]): void {
    const next = rules.filter((r) => r.enabled);
    const sig = (r: HomeEventRule) => JSON.stringify([r.entityId, r.toState, r.forMinutes]);
    const keep = new Map(next.map((r) => [r.id, sig(r)]));
    for (const old of this.rules) {
      if (keep.get(old.id) !== sig(old)) this.clear(old.id);
    }
    this.rules = next;
  }

  /** On start / reconnect: arm timers for entities already in the target state (remaining time only). */
  seed(states: { entityId: string; state: string; lastChangedMs: number }[]): void {
    for (const s of states) {
      for (const rule of this.rulesFor(s.entityId)) {
        if (s.state !== rule.toState || rule.forMinutes === 0 || this.timers.has(rule.id)) continue;
        const remaining = s.lastChangedMs + rule.forMinutes * 60_000 - this.now();
        // Already past the threshold before we started: it may have fired before; don't double-fire.
        if (remaining > 0) this.arm(rule, s.entityId, s.state, remaining);
      }
    }
  }

  onStateChange(entityId: string, oldState: string | null, newState: string | null): void {
    for (const rule of this.rulesFor(entityId)) {
      if (newState !== rule.toState) {
        this.clear(rule.id);
        continue;
      }
      if (oldState === rule.toState) continue; // attribute-only change, already handled
      if (rule.forMinutes === 0) this.fire(rule, entityId, newState, this.now());
      else this.arm(rule, entityId, newState, rule.forMinutes * 60_000);
    }
  }

  stop(): void {
    for (const id of [...this.timers.keys()]) this.clear(id);
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  private rulesFor(entityId: string): HomeEventRule[] {
    return this.rules.filter((r) => r.entityId === entityId);
  }

  private arm(rule: HomeEventRule, entityId: string, state: string, ms: number): void {
    this.clear(rule.id);
    this.timers.set(
      rule.id,
      setTimeout(() => {
        this.timers.delete(rule.id);
        this.fire(rule, entityId, state, this.now());
      }, ms),
    );
  }

  private clear(ruleId: string): void {
    const t = this.timers.get(ruleId);
    if (t) clearTimeout(t);
    this.timers.delete(ruleId);
  }
}
