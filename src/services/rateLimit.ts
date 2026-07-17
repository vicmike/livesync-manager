/** Fixed-window request limiter keyed by an arbitrary string (usually IP). */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit; returns false when the key is over its limit. */
  hit(key: string): boolean {
    const now = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      if (this.hits.size > 10_000) {
        // Drop stale windows so a scan can't grow the map unboundedly.
        for (const [k, v] of this.hits) {
          if (v.resetAt <= now) {
            this.hits.delete(k);
          }
        }
      }
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count += 1;
    return entry.count <= this.limit;
  }
}
