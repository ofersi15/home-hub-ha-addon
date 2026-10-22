/**
 * Per-key coalescing throttle: at most one flush per key every `intervalMs`. Values pushed while a key
 * is cooling down replace each other; only the latest is flushed when the window ends.
 */
export class CoalescingThrottle<T> {
  private last = new Map<string, number>();
  private pending = new Map<string, T>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly intervalMs: number,
    private readonly flush: (key: string, value: T) => void | Promise<void>,
    private readonly now: () => number = Date.now,
    private readonly onError: (key: string, e: unknown) => void = () => {},
  ) {}

  push(key: string, value: T): void {
    const t = this.now();
    const last = this.last.get(key);
    if (!this.timers.has(key) && (last === undefined || t - last >= this.intervalMs)) {
      this.run(key, value, t);
      return;
    }
    this.pending.set(key, value);
    if (!this.timers.has(key)) {
      const wait = Math.max(0, (last ?? t) + this.intervalMs - t);
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          if (!this.pending.has(key)) return;
          const v = this.pending.get(key) as T;
          this.pending.delete(key);
          this.run(key, v, this.now());
        }, wait),
      );
    }
  }

  /** Drop anything queued for a key (e.g. entity removed from the allowlist). */
  cancel(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.pending.delete(key);
  }

  /** Flush everything pending now (shutdown). */
  async flushAll(): Promise<void> {
    const entries = [...this.pending.entries()];
    for (const key of [...this.timers.keys()]) this.cancel(key);
    await Promise.all(entries.map(([k, v]) => this.runAsync(k, v, this.now())));
  }

  stop(): void {
    for (const key of [...this.timers.keys()]) this.cancel(key);
  }

  private run(key: string, value: T, at: number): void {
    void this.runAsync(key, value, at);
  }

  private async runAsync(key: string, value: T, at: number): Promise<void> {
    this.last.set(key, at);
    try {
      await this.flush(key, value);
    } catch (e) {
      this.onError(key, e);
    }
  }
}
