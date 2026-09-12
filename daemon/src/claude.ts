// Claude usage source (PLAN.md T1.2 + T1.3, §10.2 ClaudeSource, §10.3(b) state machine).
//
// Source priority (PLAN T1.3): statusline file ≤30 min old → use it for the 5 h / weekly windows;
// otherwise the throttled GET /api/oauth/usage fallback. Every failure degrades to the last good
// snapshot (`ok:false, source:"cache"`) or, when nothing ever succeeded, to null (caller emits
// "none"). The two upstreams keep separate last-good snapshots (`lastStatusline` / `lastOauth`) and
// the newer `fetchedAt` is what gets served — see newestGood() (codex review 2026-09-10).
//
// weeklySonnet is the exception (PLAN T6b.3, §3 ruling 2026-09-10): the statusline stdin carries no
// per-model weekly window, so the oauth endpoint is polled under the SAME throttle whether or not the
// statusline is fresh, and only its weeklySonnet (+ scoped model name) is merged into the statusline
// result. `source` stays "statusline" and `fetchedAt` stays the file's mtime.
//
// Credentials (§6 rule 1): the OAuth token is READ ONLY — macOS Keychain via `security`,
// Linux ~/.claude/.credentials.json — and travels only to the Anthropic endpoint. It is never
// logged, stored, or put in an error message. No token refresh is ever attempted (§6 rule 2).
//
// statusline shape per https://code.claude.com/docs/en/statusline (2026-09-07):
//   rate_limits.{five_hour,seven_day}.used_percentage  number 0–100 (may be fractional)
//   rate_limits.{five_hour,seven_day}.resets_at        Unix epoch seconds
// oauth/usage shape as probed 2026-09-07 (undocumented endpoint, may change):
//   {five_hour,seven_day,seven_day_sonnet,seven_day_opus}.utilization  number 0–100
//   ….resets_at   ISO 8601 string with µs + offset, or null
//   extra_usage   {is_enabled, used_credits, …}  (credits: not mapped in v1 → null)
//   limits[]      {kind:"session"|"weekly_all"|"weekly_scoped", percent 0–100, resets_at, scope}
//   limits[].scope  {model:{id, display_name}, surface} — display_name = "Fable" on the owner account
// weeklySonnet (PLAN §3 rule): seven_day_sonnet when non-null (model "Sonnet"), else the first usable
// limits[] entry with kind:"weekly_scoped" (model = scope.model.display_name), else null.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { UPSTREAM_INTERVAL_MIN, type ToolUsage, type UsageWindow } from '@quotalens/shared';
import {
  CLAUDE_CREDENTIALS_PATH,
  CLAUDE_KEYCHAIN_SERVICE,
  CLAUDE_OAUTH_BACKOFF_MS,
  CLAUDE_OAUTH_BETA_HEADER,
  CLAUDE_OAUTH_CANONICAL_URL,
  sendsCredentials,
  CLAUDE_OAUTH_MIN_INTERVAL_MS,
  CLAUDE_OAUTH_TIMEOUT_MS,
  CLAUDE_OAUTH_USAGE_URL,
  CLAUDE_STATUSLINE_FRESH_MS,
  CLAUDE_STATUSLINE_PATH,
} from './config.ts';
import { Throttle } from './throttle.ts';

/** Normal poll cadence of the oauth fallback; shared with the plugin's staleness threshold (§3). */
const CLAUDE_OAUTH_NORMAL_INTERVAL_MS = UPSTREAM_INTERVAL_MIN.claude * 60_000;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** `fetchedAt` as epoch ms for comparing two snapshots; unusable/absent sorts oldest. */
function fetchedAtMs(u: ToolUsage): number {
  const t = u.fetchedAt === null ? Number.NaN : Date.parse(u.fetchedAt);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

// ---- statusline (T1.2) --------------------------------------------------------------

/** Map one statusline window to a UsageWindow; null when used_percentage is unusable. */
function toStatuslineWindow(x: unknown): UsageWindow | null {
  if (!isRecord(x)) return null;
  const pct = x.used_percentage;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const r = x.resets_at;
  // resetsAt is the server value only (PLAN §6 rule 6); absent → null, never computed.
  // Out-of-range epochs (e.g. 1e20) make toISOString() throw RangeError and would bypass every
  // degradation path (codex review 2026-09-08) — treat them as "no reset time", keep the window.
  const ms = typeof r === 'number' ? r * 1000 : Number.NaN;
  const resetsAt = Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
  return { usedPct: pct, resetsAt };
}

/**
 * Read the captured statusline file. Returns null when the file is missing,
 * unparsable, or carries no usable rate_limits window. No freshness check here —
 * the ≤30 min rule lives in ClaudeSource.fetch(). `weeklySonnet` is always null here:
 * the statusline has no per-model window, and ClaudeSource.fetch() is what merges the
 * last successful oauth value on top (PLAN T6b.3).
 */
export function readStatuslineUsage(path: string = CLAUDE_STATUSLINE_PATH): ToolUsage | null {
  let raw: string;
  let mtime: Date;
  try {
    raw = readFileSync(path, 'utf8');
    mtime = statSync(path).mtime;
  } catch {
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || !isRecord(data.rate_limits)) return null;
  const fiveHour = toStatuslineWindow(data.rate_limits.five_hour);
  const weekly = toStatuslineWindow(data.rate_limits.seven_day);
  if (fiveHour === null && weekly === null) return null;
  return {
    ok: true,
    source: 'statusline',
    fiveHour,
    weekly,
    // The statusline stdin has no per-model (Sonnet) weekly window; only the oauth endpoint has it,
    // and ClaudeSource.fetch() merges the last successful value in (T6b.3).
    weeklySonnet: null,
    credits: null,
    fetchedAt: mtime.toISOString(),
  };
}

// ---- credentials (read-only) ----------------------------------------------------------

/** Extract claudeAiOauth.accessToken from the credentials JSON; null when absent. */
function tokenFromCredentialsJson(raw: string): string | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(data) || !isRecord(data.claudeAiOauth)) return null;
  const token = data.claudeAiOauth.accessToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * Read the Claude Code OAuth access token (PLAN T1.3). macOS: Keychain item
 * `Claude Code-credentials` via `security find-generic-password -w`; Linux: the
 * credentials file. Read-only. Returns null on any failure; nothing about the
 * failure (and never the secret) is surfaced beyond that null.
 */
export function readToken(): string | null {
  try {
    const raw =
      process.platform === 'darwin'
        ? execFileSync('security', ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: CLAUDE_OAUTH_TIMEOUT_MS,
          })
        : readFileSync(CLAUDE_CREDENTIALS_PATH, 'utf8');
    return tokenFromCredentialsJson(raw);
  } catch {
    return null;
  }
}

// ---- oauth/usage mapping ----------------------------------------------------------------

/** Build a UsageWindow from a 0–100 percentage and the server's resets_at; null when pct is unusable. */
function toWindow(pct: unknown, resetsAtRaw: unknown): UsageWindow | null {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  // Server value only (§6 rule 6): re-serialised to ISO for the §3 contract, never computed.
  const t = typeof resetsAtRaw === 'string' ? Date.parse(resetsAtRaw) : Number.NaN;
  return { usedPct: pct, resetsAt: Number.isNaN(t) ? null : new Date(t).toISOString() };
}

/** Map one oauth/usage window ({utilization 0–100, resets_at ISO|null}); null when unusable. */
function toOauthWindow(x: unknown): UsageWindow | null {
  return isRecord(x) ? toWindow(x.utilization, x.resets_at) : null;
}

/** Per-model weekly window + the server's display name for the model it applies to (PLAN §3). */
interface ScopedWeekly {
  window: UsageWindow;
  model: string | null;
}

/** First usable `limits[]` entry with kind:"weekly_scoped" ({percent 0–100, resets_at, scope.model.display_name}). */
function findWeeklyScoped(limits: unknown): ScopedWeekly | null {
  if (!Array.isArray(limits)) return null;
  for (const item of limits) {
    if (!isRecord(item) || item.kind !== 'weekly_scoped') continue;
    const window = toWindow(item.percent, item.resets_at);
    if (window === null) continue;
    const model = isRecord(item.scope) && isRecord(item.scope.model) ? item.scope.model.display_name : null;
    return { window, model: typeof model === 'string' && model.length > 0 ? model : null };
  }
  return null;
}

/** PLAN §3 weeklySonnet rule: seven_day_sonnet (model "Sonnet") → limits[].weekly_scoped → none. */
function scopedWeekly(body: Record<string, unknown>): ScopedWeekly | null {
  const sonnet = toOauthWindow(body.seven_day_sonnet);
  if (sonnet !== null) return { window: sonnet, model: 'Sonnet' };
  return findWeeklyScoped(body.limits);
}

export interface OauthMapping {
  usage: ToolUsage;
  /** Display name behind `usage.weeklySonnet` → `ext.claudeScopedModel`; null when no scoped window. */
  scopedModel: string | null;
}

/**
 * Map a GET /api/oauth/usage body to ToolUsage (`source:"oauth_usage"`, fetchedAt = now) plus the
 * scoped model name. Returns null when neither five_hour nor seven_day is usable.
 * ponytail: `credits` stays null in v1 (extra_usage is disabled on the owner's plan).
 */
export function mapOauthUsage(body: unknown, now: Date): OauthMapping | null {
  if (!isRecord(body)) return null;
  const fiveHour = toOauthWindow(body.five_hour);
  const weekly = toOauthWindow(body.seven_day);
  if (fiveHour === null && weekly === null) return null;
  const scoped = scopedWeekly(body);
  return {
    usage: {
      ok: true,
      source: 'oauth_usage',
      fiveHour,
      weekly,
      weeklySonnet: scoped?.window ?? null,
      credits: null,
      fetchedAt: now.toISOString(),
    },
    scopedModel: scoped?.model ?? null,
  };
}

// ---- ClaudeSource -------------------------------------------------------------------------

/** §10.3(b) states of the oauth fallback. */
export type SourceState = 'FRESH' | 'DEGRADED' | 'BACKOFF' | 'AUTH_LOST';

export interface ClaudeSourceOptions {
  statuslinePath?: string;
  /** Injected in tests so no real Keychain/file is touched. */
  readToken?: () => string | null;
  /** Injected in tests so no real network is touched. */
  fetchImpl?: typeof fetch;
  /** Wall clock for the 429 back-off start (default `() => new Date()`); injected in tests. */
  clock?: () => Date;
}

export interface FetchOptions {
  /** `?refresh=1`: skip the normal 15 min wait; the 5 min floor and back-off still apply. */
  refresh?: boolean;
}

export interface ClaudeResult {
  /** null → never succeeded; the caller emits `source:"none"` (PLAN §3). */
  usage: ToolUsage | null;
  /** Last known display name behind `weeklySonnet` (→ `ext.claudeScopedModel`); null when never known. */
  scopedModel: string | null;
}

export class ClaudeSource {
  readonly name = 'claude';
  state: SourceState = 'FRESH';
  private readonly statuslinePath: string;
  /** §6 rule 3: normal 15 min, hard floor 5 min (binding for refresh too), 429 back-off 15 min. */
  private readonly throttle: Throttle;
  private readonly tokenReader: () => string | null;
  private readonly fetchImpl: typeof fetch;
  /**
   * Two last-good snapshots, kept apart on purpose (codex review 2026-09-10). The statusline and
   * the oauth endpoint advance on independent clocks — the statusline can freeze at minute 0 while
   * oauth keeps succeeding at minute 30 — so a single slot let the (older) merged statusline
   * overwrite the newer oauth read and serve minute-0 numbers until the next poll was due.
   * `newestGood()` picks by `fetchedAt`; §3 labelling is unchanged.
   * In-memory only; never written to disk (PLAN T1.3).
   */
  private lastStatusline: ToolUsage | null = null;
  private lastOauth: ToolUsage | null = null;
  /**
   * Scoped model name from the most recent oauth success. Only the oauth endpoint carries it,
   * so it is kept alongside lastOauth and reused for cache AND statusline results — the frame A
   * label then never flickers between "Fable" and the "Sonnet" fallback when the source flips.
   */
  private lastScopedModel: string | null = null;
  /**
   * Per-model weekly window from the most recent oauth success, updated together with
   * lastScopedModel. T6b.3: this is what the statusline path merges in, so the row stays on
   * screen while the statusline is fresh; null until oauth has succeeded once (row hidden, S9).
   * Later oauth failures keep the old value — the row's staleness is judged by the tool's
   * `fetchedAt`, so no separate cache marking is needed (PLAN §3).
   */
  private lastScopedWeekly: UsageWindow | null = null;

  constructor(opts: ClaudeSourceOptions = {}) {
    this.statuslinePath = opts.statuslinePath ?? CLAUDE_STATUSLINE_PATH;
    this.tokenReader = opts.readToken ?? readToken;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.throttle = new Throttle({
      normalIntervalMs: CLAUDE_OAUTH_NORMAL_INTERVAL_MS,
      minIntervalMs: CLAUDE_OAUTH_MIN_INTERVAL_MS,
      backoffMs: CLAUDE_OAUTH_BACKOFF_MS,
      clock: opts.clock,
    });
  }

  /**
   * Source priority: fresh statusline (+ merged oauth weeklySonnet) → oauth fallback (throttled)
   * → cache → null.
   */
  async fetch(now: Date, opts: FetchOptions = {}): Promise<ClaudeResult> {
    // Any unexpected throw while reading the file must degrade to the fallback, never surface as 500.
    let sl: ToolUsage | null;
    try {
      sl = this.readStatusline();
    } catch {
      sl = null;
    }
    if (sl !== null && sl.fetchedAt !== null) {
      const age = now.getTime() - Date.parse(sl.fetchedAt);
      if (age <= CLAUDE_STATUSLINE_FRESH_MS) {
        // T6b.3: weeklySonnet lives only in the oauth body, so poll it here too — under the same
        // throttle (normal 15 min, 5 min floor binding for refresh, 15 min 429 back-off), which is
        // what decides whether a request actually leaves. The returned usage is deliberately
        // discarded: only lastScopedWeekly / lastScopedModel are taken, so this read stays
        // `source:"statusline"`, `ok:true`, `fetchedAt` = the file's mtime. An oauth failure
        // therefore cannot degrade a successful statusline read; the row keeps its last value.
        await this.fetchOauthUsage(now, opts.refresh === true);
        const merged: ToolUsage = { ...sl, weeklySonnet: this.lastScopedWeekly };
        // Only the statusline slot: the oauth snapshot this call may just have taken stays intact,
        // so a statusline that later freezes cannot hide newer oauth numbers (codex review 2026-09-10).
        this.lastStatusline = merged;
        return this.result(merged);
      }
    }
    return this.fetchOauthUsage(now, opts.refresh === true);
  }

  private readStatusline(): ToolUsage | null {
    return readStatuslineUsage(this.statuslinePath);
  }

  private result(usage: ToolUsage | null): ClaudeResult {
    return { usage, scopedModel: this.lastScopedModel };
  }

  /**
   * The fresher of the two snapshots by `fetchedAt` (statusline mtime vs oauth read time); null
   * until one of them has succeeded once. Ties keep the statusline — it is the source-priority
   * winner (T1.3) and the value that was actually served when both timestamps coincide.
   */
  private newestGood(): ToolUsage | null {
    const sl = this.lastStatusline;
    const oauth = this.lastOauth;
    if (sl === null) return oauth;
    if (oauth === null) return sl;
    return fetchedAtMs(oauth) > fetchedAtMs(sl) ? oauth : sl;
  }

  /**
   * Between two upstream reads nothing failed, so the last good value keeps its real label
   * (§3: `cache` = "fetch failed but succeeded before"; being throttled is not a failure).
   * Only a non-FRESH state re-labels it as cache. Same rule as CodexSource.current().
   */
  private current(): ClaudeResult {
    const good = this.newestGood();
    if (good === null || this.state !== 'FRESH') return this.cached();
    return this.result(good);
  }

  /** newestGood() re-labelled per §3: `ok:false, source:"cache"`; usage null when nothing ever succeeded. */
  private cached(): ClaudeResult {
    const good = this.newestGood();
    return this.result(good === null ? null : { ...good, ok: false, source: 'cache' });
  }

  private fail(state: SourceState, now: Date): ClaudeResult {
    this.state = state;
    // ponytail: AUTH_LOST retries at the normal cadence instead of watching the credentials
    // mtime (§10.3(b) note) — the Keychain has no cheap mtime; 1 request / 15 min is harmless.
    if (state === 'AUTH_LOST') this.throttle.scheduleNormal(now);
    if (state === 'BACKOFF') this.throttle.backoff(now);
    return this.cached();
  }

  /** Throttled GET /api/oauth/usage; see §10.3(b) for the state transitions. */
  async fetchOauthUsage(now: Date, refresh = false): Promise<ClaudeResult> {
    if (!this.throttle.allows(now, refresh)) return this.current();
    this.throttle.markAttempt(now);

    // The token is read only when the request actually goes to api.anthropic.com; a loopback test
    // override gets no credentials at all (§6 rule 1; codex review 2026-09-08).
    const withCredentials = sendsCredentials(CLAUDE_OAUTH_USAGE_URL, CLAUDE_OAUTH_CANONICAL_URL);
    const token = withCredentials ? this.tokenReader() : null;
    if (withCredentials && token === null) return this.fail('AUTH_LOST', now);

    let res: Response;
    try {
      res = await this.fetchImpl(CLAUDE_OAUTH_USAGE_URL, {
        method: 'GET',
        headers: {
          ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
          'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
        },
        // A redirect must never carry the token anywhere the check above did not authorise
        // (codex review 2026-09-08). Cross-origin redirects already drop Authorization (verified),
        // so this only closes same-origin path hops; the endpoint does not redirect, and a throw
        // here lands in the DEGRADED path below like any other failure.
        redirect: 'error',
        signal: AbortSignal.timeout(CLAUDE_OAUTH_TIMEOUT_MS),
      });
    } catch {
      return this.fail('DEGRADED', now);
    }
    if (res.status === 429) return this.fail('BACKOFF', now);
    if (res.status === 401) return this.fail('AUTH_LOST', now);
    if (!res.ok) return this.fail('DEGRADED', now);

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return this.fail('DEGRADED', now);
    }
    const mapped = mapOauthUsage(body, now);
    if (mapped === null) return this.fail('DEGRADED', now);

    this.lastOauth = mapped.usage;
    this.lastScopedModel = mapped.scopedModel;
    this.lastScopedWeekly = mapped.usage.weeklySonnet;
    this.state = 'FRESH';
    this.throttle.scheduleNormal(now);
    return this.result(mapped.usage);
  }
}

/** Process-wide instance used by the HTTP handler (both snapshots live for the daemon's lifetime). */
const defaultSource = new ClaudeSource();

export function getClaudeUsage(now: Date, opts: FetchOptions = {}): Promise<ClaudeResult> {
  return defaultSource.fetch(now, opts);
}
