// Codex usage source (PLAN.md T1.4, §10.2 CodexSource / AppServerClient, §10.3(b) state machine).
//
// Primary path: a long-lived `codex app-server` child (JSON-RPC over stdio) answering
// `account/rateLimits/read`. Fallback: GET backend-api/codex/usage with the CLI's own tokens.
// Every failure degrades to lastGood (`ok:false, source:"cache"`) or, when nothing ever
// succeeded, to null (caller emits "none"). Nothing here ever throws to the HTTP handler.
//
// Credentials (§6 rule 1): ~/.codex/auth.json is READ ONLY (tokens.access_token,
// tokens.account_id) and its values travel only to the OpenAI backend. They are never logged,
// stored, or put in an error message. No token refresh is ever attempted (§6 rule 2).
//
// app-server protocol as probed 2026-09-08 (codex-cli 0.153.4, `codex app-server generate-json-schema`):
//   framing   newline-delimited JSON objects on stdin/stdout ({id, method, params?} / {id, result|error});
//             notifications and server→client requests carry `method` and are ignored here.
//   handshake `initialize` {clientInfo:{name,version}} is mandatory — before it every request
//             answers {error:{code:-32600,message:"Not initialized"}}.
//   method    account/rateLimits/read (params: null) → GetAccountRateLimitsResponse:
//     rateLimits.{primary,secondary}   RateLimitWindow|null {usedPercent int 0–100,
//                                      windowDurationMins int|null, resetsAt Unix epoch SECONDS|null}
//     rateLimits.credits               CreditsSnapshot|null {hasCredits, unlimited, balance string|null}
//     rateLimitsByLimitId              same snapshot per metered limit_id (e.g. "codex")
//   Owner account (planType "prolite"): `codex` bucket has ONLY a weekly window in `primary`
//   (10080 min), secondary null, credits {hasCredits:false, balance:"0"}. Windows are therefore
//   classified by windowDurationMins, not by position.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { UPSTREAM_INTERVAL_MIN, type Credits, type ToolUsage, type UsageWindow } from '@quotalens/shared';
import {
  CODEX_APP_SERVER_ARGS,
  CODEX_AUTH_PATH,
  CODEX_BACKEND_CANONICAL_URL,
  CODEX_BACKEND_TIMEOUT_MS,
  sendsCredentials,
  CODEX_BACKEND_USAGE_URL,
  CODEX_BACKOFF_MS,
  CODEX_BIN,
  CODEX_MIN_INTERVAL_MS,
  CODEX_RESTART_BACKOFF_INITIAL_MS,
  CODEX_RESTART_BACKOFF_MAX_MS,
  CODEX_KILL_GRACE_MS,
  CODEX_RPC_TIMEOUT_MS,
} from './config.ts';
import { Throttle } from './throttle.ts';

/** Normal RPC cadence; shared with the plugin's staleness threshold (§3). */
const CODEX_NORMAL_INTERVAL_MS = UPSTREAM_INTERVAL_MIN.codex * 60_000;
const RPC_METHOD_RATE_LIMITS = 'account/rateLimits/read';
const RPC_METHOD_INITIALIZE = 'initialize';
const CLIENT_INFO = { name: 'quotalens', version: '0.0.0' };
/** Windows no longer than this are the 5 h bucket; longer ones are weekly. */
const FIVE_HOUR_MAX_MINS = 6 * 60;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

// ---- mapping ----------------------------------------------------------------------------

/** Unix epoch seconds → ISO; null when absent or out of range (server value only, §6 rule 6). */
function epochToIso(x: unknown): string | null {
  const ms = typeof x === 'number' ? x * 1000 : Number.NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}

interface RawWindow {
  window: UsageWindow;
  durationMins: number | null;
}

function toRawWindow(x: unknown): RawWindow | null {
  if (!isRecord(x)) return null;
  const pct = x.usedPercent;
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return null;
  const d = x.windowDurationMins;
  return {
    window: { usedPct: pct, resetsAt: epochToIso(x.resetsAt) },
    durationMins: typeof d === 'number' && Number.isFinite(d) ? d : null,
  };
}

/**
 * CreditsSnapshot → Credits. null when absent, unlimited, hasCredits:false, or the balance
 * does not parse. ponytail: `balance` is an untyped string; the owner account shows "0" with
 * hasCredits:false, so its unit is UNVERIFIED — `remainingUsd` ASSUMES USD.
 */
function toCredits(_x: unknown): Credits | null {
  // ponytail: always null until the unit of `balance` is verified against a real account with
  // hasCredits:true (codex review 2026-09-08: an unknown unit must not be published as USD).
  // Upgrade path: parse `balance` here once the unit and conversion are confirmed; PLAN C5 tracks it.
  return null;
}

/**
 * Map a RateLimitSnapshot ({primary, secondary, credits}) to ToolUsage. Windows are classified
 * by windowDurationMins (≤6 h → fiveHour, else weekly); when the duration is missing the
 * historical convention applies (primary = 5 h, secondary = weekly). null when no window maps.
 */
function mapSnapshot(snap: unknown, source: 'app_server' | 'backend_api', now: Date): ToolUsage | null {
  if (!isRecord(snap)) return null;
  const slots: { raw: RawWindow | null; fallback: 'fiveHour' | 'weekly' }[] = [
    { raw: toRawWindow(snap.primary), fallback: 'fiveHour' },
    { raw: toRawWindow(snap.secondary), fallback: 'weekly' },
  ];
  let fiveHour: UsageWindow | null = null;
  let weekly: UsageWindow | null = null;
  for (const { raw, fallback } of slots) {
    if (raw === null) continue;
    const kind = raw.durationMins === null ? fallback : raw.durationMins <= FIVE_HOUR_MAX_MINS ? 'fiveHour' : 'weekly';
    if (kind === 'fiveHour') fiveHour ??= raw.window;
    else weekly ??= raw.window;
  }
  if (fiveHour === null && weekly === null) return null;
  return {
    ok: true,
    source,
    fiveHour,
    weekly,
    weeklySonnet: null, // Codex has no per-model weekly window (PLAN §3)
    credits: toCredits(snap.credits),
    fetchedAt: now.toISOString(),
  };
}

/** Map a GetAccountRateLimitsResponse (`{rateLimits: RateLimitSnapshot, …}`) to ToolUsage. */
export function mapRateLimits(result: unknown, now: Date): ToolUsage | null {
  if (!isRecord(result)) return null;
  return mapSnapshot(result.rateLimits, 'app_server', now);
}

const snakeToCamel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** Recursively rename snake_case keys to camelCase (values untouched). */
function camelKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(camelKeys);
  if (!isRecord(x)) return x;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x)) out[snakeToCamel(k)] = camelKeys(v);
  return out;
}

/** Accept the RPC window names or the backend's `*_window` / `used_percent` / `limit_window_seconds` / `reset_at` names. */
function normaliseWindow(w: unknown): unknown {
  if (!isRecord(w)) return w;
  const seconds = w.limitWindowSeconds;
  return {
    usedPercent: w.usedPercent,
    windowDurationMins: w.windowDurationMins ?? (typeof seconds === 'number' ? seconds / 60 : undefined),
    resetsAt: w.resetsAt ?? w.resetAt,
  };
}

/**
 * Map a backend-api/codex/usage body to ToolUsage (`source:"backend_api"`).
 * ponytail: the live shape is UNVERIFIED — both probes on 2026-09-08 answered HTTP 403 with an
 * HTML challenge page (plain curl, and again with `User-Agent: codex_cli_rs/0.153.4 (…)` +
 * `Accept: application/json`), so no User-Agent is sent here — UNVERIFIED whether any UA helps.
 * This accepts the app-server's camelCase snapshot (the RPC proxies this endpoint) and the
 * snake_case `rate_limit.{primary,secondary}_window` spelling; anything else → null.
 */
export function mapBackendUsage(body: unknown, now: Date): ToolUsage | null {
  const b = camelKeys(body);
  if (!isRecord(b)) return null;
  const snap = isRecord(b.rateLimits) ? b.rateLimits : isRecord(b.rateLimit) ? b.rateLimit : null;
  if (snap === null) return null;
  return mapSnapshot(
    {
      primary: normaliseWindow(snap.primary ?? snap.primaryWindow),
      secondary: normaliseWindow(snap.secondary ?? snap.secondaryWindow),
      credits: snap.credits ?? b.credits,
    },
    'backend_api',
    now,
  );
}

// ---- credentials (read-only) --------------------------------------------------------------

export interface CodexAuth {
  token: string;
  accountId: string;
}

/**
 * Read tokens.access_token + tokens.account_id from ~/.codex/auth.json (PLAN T1.4). Read-only.
 * Returns null on any failure; nothing about the failure (and never the secret) is surfaced.
 */
export function readCodexAuth(path: string = CODEX_AUTH_PATH): CodexAuth | null {
  try {
    const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isRecord(data) || !isRecord(data.tokens)) return null;
    const { access_token: token, account_id: accountId } = data.tokens;
    if (typeof token !== 'string' || token.length === 0) return null;
    if (typeof accountId !== 'string' || accountId.length === 0) return null;
    return { token, accountId };
  } catch {
    return null;
  }
}

// ---- AppServerClient ----------------------------------------------------------------------

/** The subset of ChildProcess the client uses; tests inject a fake. stderr is not read (§6 rule 1). */
export interface ChildLike {
  /** `error` (e.g. EPIPE after the peer died) is emitted asynchronously; unhandled it would kill the daemon. */
  stdin: { write(chunk: string): unknown; on(event: 'error', cb: (err: Error) => void): unknown };
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown };
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface RpcClient {
  call(method: string, params?: unknown): Promise<unknown>;
  close(): void;
  /** SIGKILL whatever ignored close(); called right before the daemon exits. */
  killAll?(): void;
}

/** Opaque timer handle; the real implementation returns a NodeJS.Timeout, tests return whatever they like. */
export type TimerHandle = unknown;

export interface AppServerClientOptions {
  /** Injected in tests; defaults to `spawn("codex", ["app-server"])` with stderr discarded. */
  spawnImpl?: () => ChildLike;
  /** Restart timer; injected in tests (default: `setTimeout` + `unref`). */
  setTimeoutImpl?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeoutImpl?: (handle: TimerHandle) => void;
  timeoutMs?: number;
}

function spawnCodexAppServer(): ChildLike {
  // stderr is discarded on purpose: it may echo config or auth details and must never land in our logs.
  return spawn(CODEX_BIN, CODEX_APP_SERVER_ARGS, { stdio: ['pipe', 'pipe', 'ignore'] });
}

/** Default restart timer: never keeps the event loop alive on its own. */
function unrefTimeout(fn: () => void, ms: number): TimerHandle {
  const t = setTimeout(fn, ms);
  t.unref();
  return t;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Long-lived `codex app-server` child speaking JSON-lines JSON-RPC over stdio (§10.2).
 *
 * Lifecycle is independent of any call (PLAN T1.4 acceptance): the first `call` spawns the child;
 * from then on a dead child (exit, process/stdin error, failed handshake) is respawned by the
 * client's own timer after an exponential back-off (1 s → 2 s → 4 s … 60 s cap) that returns to
 * 1 s once a child completes `initialize`. `call` never spawns a replacement: while no child is
 * attached it rejects with "app-server not running"; while a handshake is in flight it waits.
 * Never throws synchronously; every failure is a rejected promise.
 */
export class AppServerClient implements RpcClient {
  private proc: ChildLike | null = null;
  private initialized: Promise<void> | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Delay before the next respawn (0 until the first death, doubles per consecutive death). */
  private restartDelayMs = 0;
  private restartTimer: TimerHandle | null = null;
  private spawnedOnce = false;
  private closed = false;
  /**
   * Children that were sent SIGTERM but have not reported `exit` yet (detached after a stdin/process
   * error or a failed handshake, or on close()). A process may survive that signal; close() SIGKILLs
   * whatever is still here so nothing outlives the daemon (codex review 2026-09-08).
   */
  private readonly dying = new Map<ChildLike, TimerHandle>(); // child → its SIGKILL grace timer
  /** Number of respawns so far (diagnostics/tests). */
  restarts = 0;

  private readonly spawnImpl: () => ChildLike;
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearTimeoutImpl: (handle: TimerHandle) => void;
  private readonly timeoutMs: number;

  constructor(opts: AppServerClientOptions = {}) {
    this.spawnImpl = opts.spawnImpl ?? spawnCodexAppServer;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? unrefTimeout;
    this.clearTimeoutImpl = opts.clearTimeoutImpl ?? ((h) => clearTimeout(h as NodeJS.Timeout));
    this.timeoutMs = opts.timeoutMs ?? CODEX_RPC_TIMEOUT_MS;
  }

  /** true while a child process is attached (it may still be initializing); false after death/close. */
  get alive(): boolean {
    return this.proc !== null;
  }

  async call(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) throw new Error('app-server client closed');
    if (!this.spawnedOnce) {
      const spawnError = this.spawnNow();
      if (spawnError !== null) throw spawnError;
    }
    if (this.initialized === null) throw new Error('app-server not running');
    await this.initialized;
    return this.request(method, params);
  }

  close(): void {
    this.closed = true;
    if (this.restartTimer !== null) {
      this.clearTimeoutImpl(this.restartTimer);
      this.restartTimer = null;
    }
    const p = this.proc;
    this.proc = null;
    this.initialized = null;
    this.failPending(new Error('app-server client closed'));
    // Anything that ignored its earlier SIGTERM gets SIGKILL; the current child gets its SIGTERM now.
    this.killAll();
    if (p !== null) this.terminate(p);
  }

  /** Last resort before process exit: SIGKILL every child that has not confirmed its exit yet. */
  killAll(): void {
    for (const [c, timer] of this.dying) {
      this.clearTimeoutImpl(timer);
      c.kill('SIGKILL');
    }
    this.dying.clear();
  }

  /**
   * SIGTERM a child and remember it until its `exit` arrives (a no-op signal if it already died).
   * A child that ignores SIGTERM is SIGKILLed after CODEX_KILL_GRACE_MS, so repeated failures leave a
   * bounded number of live processes (codex review 2026-09-08).
   */
  private terminate(proc: ChildLike): void {
    if (this.dying.has(proc)) return;
    const timer = this.setTimeoutImpl(() => {
      if (!this.dying.has(proc)) return;
      this.dying.delete(proc);
      proc.kill('SIGKILL');
    }, CODEX_KILL_GRACE_MS);
    this.dying.set(proc, timer);
    proc.kill('SIGTERM');
  }

  /** `exit` confirmed: drop the child and its grace timer. */
  private forget(proc: ChildLike): void {
    const timer = this.dying.get(proc);
    if (timer !== undefined) this.clearTimeoutImpl(timer);
    this.dying.delete(proc);
  }

  /**
   * Spawn a child and start its handshake. Returns the spawn error (also scheduling a retry) or null.
   * `initialized` resolves once `initialize` has been answered; a failed handshake discards the child.
   */
  private spawnNow(): Error | null {
    if (this.closed || this.proc !== null) return null;
    if (this.spawnedOnce) this.restarts++;
    this.spawnedOnce = true;
    let proc: ChildLike;
    try {
      proc = this.spawnImpl();
    } catch (e) {
      this.scheduleRestart();
      return e instanceof Error ? e : new Error(String(e));
    }
    this.proc = proc;
    this.buffer = '';
    proc.stdout.on('data', (chunk) => this.onData(proc, chunk));
    proc.on('exit', () => {
      this.forget(proc); // confirmed gone: nothing left to kill
      this.onDeath(proc, new Error('app-server exited'), true);
    });
    proc.on('error', () => this.onDeath(proc, new Error('app-server exited')));
    // A broken pipe surfaces here asynchronously, not from write(); treat it as the child dying —
    // but the process may well still be running, so onDeath kills it rather than just forgetting it.
    proc.stdin.on('error', () => this.onDeath(proc, new Error('app-server exited')));
    this.initialized = this.request(RPC_METHOD_INITIALIZE, { clientInfo: CLIENT_INFO }).then(
      () => {
        if (this.proc === proc) this.restartDelayMs = 0; // handshake done: the back-off sequence starts over
      },
      (e: unknown) => {
        // A child that never completes the handshake (timeout / rpc error) is useless: kill it and
        // let the restart timer try again instead of leaving callers awaiting this rejection forever.
        this.onDeath(proc, e instanceof Error ? e : new Error(String(e)));
        throw e;
      },
    );
    this.initialized.catch(() => {});
    return null;
  }

  /**
   * `exit`, process/stdin `error`, or a failed handshake: detach the child, fail every in-flight
   * request, kill the child unless it has already `exit`ed, and schedule the respawn. No-op for a
   * stale child (already replaced, discarded, or closed).
   */
  private onDeath(proc: ChildLike, reason: Error, exited = false): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.initialized = null;
    this.failPending(reason);
    if (!exited) this.terminate(proc);
    this.scheduleRestart();
  }

  /** Arm the respawn timer with the next back-off step (1 s, 2 s, 4 s … capped). */
  private scheduleRestart(): void {
    if (this.closed || this.restartTimer !== null) return;
    this.restartDelayMs =
      this.restartDelayMs === 0
        ? CODEX_RESTART_BACKOFF_INITIAL_MS
        : Math.min(this.restartDelayMs * 2, CODEX_RESTART_BACKOFF_MAX_MS);
    this.restartTimer = this.setTimeoutImpl(() => {
      this.restartTimer = null;
      this.spawnNow(); // a spawn error re-arms the timer with the next step
    }, this.restartDelayMs);
  }

  private failPending(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private onData(proc: ChildLike, chunk: Buffer | string): void {
    if (this.proc !== proc) return;
    this.buffer += chunk.toString();
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not ours to interpret; never logged (could carry anything)
    }
    // Responses carry `id` and no `method`; notifications and server→client requests carry `method`.
    if (!isRecord(msg) || 'method' in msg || typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (p === undefined) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if ('error' in msg) {
      // Only a classification leaves this point: the upstream message may quote the request
      // (headers, tokens) and must never reach a log or an Error (§6 rule 1; codex review 2026-09-08).
      const e = msg.error;
      const text = isRecord(e) && typeof e.message === 'string' ? e.message : '';
      const code = isRecord(e) && typeof e.code === 'number' ? e.code : null;
      const rateLimited = code === 429 || /\b429\b/.test(text);
      p.reject(new Error(rateLimited ? 'app-server rpc error: rate_limited' : 'app-server rpc error'));
      return;
    }
    p.resolve(msg.result);
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    const proc = this.proc;
    if (proc === null) return Promise.reject(new Error('app-server not running'));
    const id = this.nextId++;
    const line = JSON.stringify(params === undefined ? { id, method } : { id, method, params }) + '\n';
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server rpc timeout: ${method}`));
        // A child that stops answering is treated as dead: kill it and let the back-off timer respawn
        // (codex review 2026-09-08: three timeouts in a row used to leave a wedged child alive forever).
        this.onDeath(proc, new Error('app-server rpc timeout'));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        proc.stdin.write(line);
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }
}

// ---- CodexSource --------------------------------------------------------------------------

/** §10.3(b) states. */
export type CodexState = 'FRESH' | 'DEGRADED' | 'BACKOFF' | 'AUTH_LOST';

export interface CodexSourceOptions {
  /** Injected in tests; defaults to a real AppServerClient. */
  client?: RpcClient;
  /** Injected in tests so no real ~/.codex/auth.json is touched. */
  readAuth?: () => CodexAuth | null;
  /** Injected in tests so no real network is touched. */
  fetchImpl?: typeof fetch;
  /** Wall clock for the 429 back-off start (default `() => new Date()`); injected in tests. */
  clock?: () => Date;
}

export interface CodexFetchOptions {
  /** `?refresh=1`: skip the normal 5 min wait; the 1 min floor and back-off still apply. */
  refresh?: boolean;
}

export class CodexSource {
  readonly name = 'codex';
  state: CodexState = 'FRESH';
  private readonly client: RpcClient;
  private readonly authReader: () => CodexAuth | null;
  private readonly fetchImpl: typeof fetch;
  /** §6 rule 3: normal 5 min, hard floor 1 min (binding for refresh too), 429 back-off 5 min. */
  private readonly throttle: Throttle;
  /** In-memory only; never written to disk. */
  private lastGood: ToolUsage | null = null;

  constructor(opts: CodexSourceOptions = {}) {
    this.client = opts.client ?? new AppServerClient();
    this.authReader = opts.readAuth ?? readCodexAuth;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.throttle = new Throttle({
      normalIntervalMs: CODEX_NORMAL_INTERVAL_MS,
      minIntervalMs: CODEX_MIN_INTERVAL_MS,
      backoffMs: CODEX_BACKOFF_MS,
      clock: opts.clock,
    });
  }

  /**
   * app-server RPC → backend fallback → cache → null; throttled as one upstream read.
   * The child's lifecycle is the client's own business (it respawns itself, see AppServerClient):
   * a read that lands while the child is dead simply fails and degrades like any other failure.
   */
  async fetch(now: Date, opts: CodexFetchOptions = {}): Promise<ToolUsage | null> {
    if (!this.throttle.allows(now, opts.refresh === true)) return this.current();
    this.throttle.markAttempt(now);

    const rpc = await this.readRpc(now);
    if (rpc.usage !== null) return this.succeed(rpc.usage, now);
    // ponytail: the RPC error shape for an upstream 429 is undocumented; the message text is the
    // only signal we have, so a "429" in it is treated as BACKOFF rather than hammering the fallback.
    if (rpc.error !== null && /rate_limited|\b429\b/.test(rpc.error)) return this.fail('BACKOFF', now);
    return this.fallbackBackendApi(now);
  }

  /** Kill the app-server child (daemon shutdown). */
  close(): void {
    this.client.close();
  }

  killAll(): void {
    this.client.killAll?.();
  }

  /** Between reads the last good value keeps its real source label; nothing new happened. */
  private current(): ToolUsage | null {
    if (this.lastGood === null) return null;
    return this.state === 'FRESH' ? this.lastGood : this.cached();
  }

  /** lastGood re-labelled per §3: `ok:false, source:"cache"`; null when nothing ever succeeded. */
  private cached(): ToolUsage | null {
    return this.lastGood === null ? null : { ...this.lastGood, ok: false, source: 'cache' };
  }

  private succeed(usage: ToolUsage, now: Date): ToolUsage {
    this.lastGood = usage;
    this.state = 'FRESH';
    this.throttle.scheduleNormal(now);
    return usage;
  }

  private fail(state: CodexState, now: Date): ToolUsage | null {
    this.state = state;
    if (state === 'BACKOFF') this.throttle.backoff(now);
    // ponytail: AUTH_LOST retries at the floor/normal cadence instead of watching auth.json's
    // mtime (§10.3(b) note); one request per 5 min is harmless and the CLI refreshes the file itself.
    return this.cached();
  }

  private async readRpc(now: Date): Promise<{ usage: ToolUsage | null; error: string | null }> {
    try {
      const result = await this.client.call(RPC_METHOD_RATE_LIMITS);
      return { usage: mapRateLimits(result, now), error: null };
    } catch (e) {
      return { usage: null, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** GET backend-api/codex/usage with the CLI's tokens; see §10.3(b) for the transitions. */
  private async fallbackBackendApi(now: Date): Promise<ToolUsage | null> {
    // Credentials are read only when the request actually goes to chatgpt.com; a loopback test
    // override gets none (§6 rule 1; codex review 2026-09-08).
    const withCredentials = sendsCredentials(CODEX_BACKEND_USAGE_URL, CODEX_BACKEND_CANONICAL_URL);
    const auth = withCredentials ? this.authReader() : null;
    if (withCredentials && auth === null) return this.fail('DEGRADED', now);

    let res: Response;
    try {
      res = await this.fetchImpl(CODEX_BACKEND_USAGE_URL, {
        method: 'GET',
        headers:
          auth === null
            ? {}
            : { Authorization: `Bearer ${auth.token}`, 'ChatGPT-Account-ID': auth.accountId },
        // Same reason as claude.ts: no redirect may carry the token past the canonical-URL check.
        redirect: 'error',
        signal: AbortSignal.timeout(CODEX_BACKEND_TIMEOUT_MS),
      });
    } catch {
      return this.fail('DEGRADED', now); // the error object may quote the request; never surfaced
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
    const mapped = mapBackendUsage(body, now);
    if (mapped === null) return this.fail('DEGRADED', now);
    return this.succeed(mapped, now);
  }
}

/** Process-wide instance used by the HTTP handler (lastGood + the child live for the daemon's lifetime). */
const defaultSource = new CodexSource();

export function getCodexUsage(now: Date, opts: CodexFetchOptions = {}): Promise<ToolUsage | null> {
  return defaultSource.fetch(now, opts);
}

/** Kill the app-server child; called from the daemon's SIGTERM/SIGINT handlers so no orphan survives. */
export function shutdownCodex(): void {
  defaultSource.close();
}

/** SIGKILL any child that ignored its SIGTERM; the daemon calls this right before process.exit. */
export function forceKillCodex(): void {
  defaultSource.killAll();
}
