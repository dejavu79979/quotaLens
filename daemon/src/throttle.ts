// Request gate shared by every network-backed UsageSource (PLAN §6 rule 3, §10.3(b) BACKOFF).
// One class, parameterised per source: Claude oauth (15 min / 5 min floor / 15 min back-off),
// Codex app-server (5 min / 1 min floor / 5 min back-off). Never copy this — configure it.

export interface ThrottleConfig {
  /** Normal cadence between successful fetches. */
  normalIntervalMs: number;
  /** Hard floor between two attempts; binding for `?refresh=1` too. */
  minIntervalMs: number;
  /** Quiet period after a 429 during which no request leaves at all. */
  backoffMs: number;
  /**
   * Wall clock, read when a 429 arrives. The request's `now` was taken before the request left;
   * a slow 429 would otherwise shorten the quiet period by the round-trip. Tests inject a fake.
   */
  clock?: () => Date;
}

export class Throttle {
  private lastAttemptAt: number | null = null;
  private nextDueAt = 0;
  private backoffUntil = 0;
  private readonly clock: () => Date;

  constructor(private readonly cfg: ThrottleConfig) {
    this.clock = cfg.clock ?? (() => new Date());
  }

  allows(now: Date, refresh: boolean): boolean {
    const t = now.getTime();
    if (t < this.backoffUntil) return false; // quiet period after a 429: nothing leaves
    if (this.lastAttemptAt !== null && t < this.lastAttemptAt + this.cfg.minIntervalMs) return false;
    return refresh || t >= this.nextDueAt;
  }

  markAttempt(now: Date): void {
    this.lastAttemptAt = now.getTime();
    // Failed attempts may be retried at the floor; success/back-off push nextDueAt further below.
    this.nextDueAt = this.lastAttemptAt + this.cfg.minIntervalMs;
  }

  scheduleNormal(now: Date): void {
    this.nextDueAt = now.getTime() + this.cfg.normalIntervalMs;
    this.backoffUntil = 0;
  }

  /** Start the quiet period at the 429's arrival: `max(now, clock())` (codex review 2026-09-08). */
  backoff(now: Date): void {
    const start = Math.max(now.getTime(), this.clock().getTime());
    this.backoffUntil = start + this.cfg.backoffMs;
    this.nextDueAt = this.backoffUntil;
  }
}
