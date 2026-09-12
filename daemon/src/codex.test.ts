// T1.4 Codex app-server JSON-RPC source — mapping, throttle (5 min / 1 min floor / 429 → 5 min),
// RPC → backend fallback → cache → null, and the child-process restart back-off (PLAN §10.2/§10.3(b)).
// No real `codex`, no real network, no real ~/.codex/auth.json: spawn, fetch and auth are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseUsagePayload, type ToolUsage } from '@quotalens/shared';
import { AppServerClient, CodexSource, mapBackendUsage, mapRateLimits, type ChildLike, type RpcClient } from './codex.ts';
import { CODEX_BACKEND_USAGE_URL } from './config.ts';

const MIN = 60_000;
const T0 = new Date('2026-09-08T10:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

// Shape as probed 2026-09-08 via `codex app-server` → account/rateLimits/read (owner account,
// planType "prolite"): the `codex` bucket carries ONLY a weekly window in `primary`
// (windowDurationMins 10080), `secondary` is null, credits.hasCredits=false, balance "0".
// resetsAt is Unix epoch SECONDS. Ids/accountId trimmed.
const RPC_PROBED = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1789210477 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: '0' },
    individualLimit: null,
    spendControlReached: false,
    planType: 'prolite',
    rateLimitReachedType: null,
  },
  rateLimitsByLimitId: {},
  rateLimitResetCredits: { availableCount: 2, credits: null },
  accountId: 'x',
  rateLimitUpsell: null,
};

// Two-window variant (primary 5 h, secondary 7 d) with a positive credit balance — the shape the
// JSON schema (RateLimitSnapshot / CreditsSnapshot) allows; not observed on the owner account.
const RPC_TWO_WINDOWS = {
  rateLimits: {
    primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: 1788811794 },
    secondary: { usedPercent: 64, windowDurationMins: 10080, resetsAt: 1789398594 },
    credits: { hasCredits: true, unlimited: false, balance: '4.20' },
  },
};

function wrap(codex: unknown) {
  return parseUsagePayload({
    version: 1,
    generatedAt: T0.toISOString(),
    claude: { ok: false, source: 'none', fiveHour: null, weekly: null, weeklySonnet: null, credits: null, fetchedAt: null },
    codex,
    ext: {},
  });
}

// ---- mapping ------------------------------------------------------------------------------

test('mapRateLimits: probed shape → weekly only, epoch seconds → ISO, hasCredits:false → credits null', () => {
  const u = mapRateLimits(RPC_PROBED, T0);
  assert.ok(u);
  assert.equal(u.ok, true);
  assert.equal(u.source, 'app_server');
  assert.equal(u.fiveHour, null);
  assert.deepEqual(u.weekly, { usedPct: 40, resetsAt: new Date(1789210477 * 1000).toISOString() });
  assert.equal(u.weeklySonnet, null);
  assert.equal(u.credits, null);
  assert.equal(u.fetchedAt, T0.toISOString());
  assert.doesNotThrow(() => wrap(u));
});

test('mapRateLimits: two windows classified by windowDurationMins; credits stay null until the balance unit is verified', () => {
  const u = mapRateLimits(RPC_TWO_WINDOWS, T0);
  assert.ok(u);
  assert.equal(u.fiveHour?.usedPct, 18);
  assert.equal(u.weekly?.usedPct, 64);
  // codex review 2026-09-08: hasCredits:true with balance "4.20" must NOT be published as USD yet.
  assert.equal(u.credits, null);
  assert.doesNotThrow(() => wrap(u));
});

test('mapRateLimits: null windowDurationMins falls back to primary=5h, secondary=weekly; null resetsAt kept null', () => {
  const u = mapRateLimits(
    { rateLimits: { primary: { usedPercent: 5, resetsAt: null }, secondary: { usedPercent: 7 } } },
    T0,
  );
  assert.ok(u);
  assert.deepEqual(u.fiveHour, { usedPct: 5, resetsAt: null });
  assert.deepEqual(u.weekly, { usedPct: 7, resetsAt: null });
});

test('mapRateLimits: unlimited credits → null; out-of-range epoch → resetsAt null; no windows → null', () => {
  const u = mapRateLimits(
    { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1e20 }, credits: { hasCredits: true, unlimited: true, balance: '9' } } },
    T0,
  );
  assert.ok(u);
  assert.equal(u.fiveHour?.resetsAt, null);
  assert.equal(u.credits, null);
  assert.equal(mapRateLimits({ rateLimits: { primary: null, secondary: null } }, T0), null);
  assert.equal(mapRateLimits({ rateLimits: 'nope' }, T0), null);
  assert.equal(mapRateLimits(null, T0), null);
});

test('mapBackendUsage: camelCase and snake_case window shapes both map to source:"backend_api"', () => {
  const camel = mapBackendUsage(RPC_TWO_WINDOWS, T0);
  assert.equal(camel?.source, 'backend_api');
  assert.equal(camel?.fiveHour?.usedPct, 18);
  const snake = mapBackendUsage(
    {
      rate_limit: {
        primary_window: { used_percent: 30, limit_window_seconds: 18000, reset_at: 1788811794 },
        secondary_window: { used_percent: 55, limit_window_seconds: 604800, reset_at: 1789398594 },
      },
      credits: { has_credits: true, unlimited: false, balance: '1.5' },
    },
    T0,
  );
  assert.equal(snake?.fiveHour?.usedPct, 30);
  assert.equal(snake?.weekly?.usedPct, 55);
  assert.equal(snake?.credits, null, 'credits stay null until the balance unit is verified');
  assert.equal(mapBackendUsage({ error: 'x' }, T0), null);
});

// ---- CodexSource: throttle + fallback chain ---------------------------------------------------

type RpcStep = { result: unknown } | Error;
function fakeRpc(steps: RpcStep[]) {
  const calls: string[] = [];
  const client: RpcClient = {
    async call(method) {
      calls.push(method);
      const s = steps.shift();
      if (s === undefined) throw new Error('fakeRpc: unexpected extra call');
      if (s instanceof Error) throw s;
      return s.result;
    },
    close() {},
  };
  return { client, calls };
}

type FetchStep = { status: number; body?: unknown } | Error;
function fakeFetch(steps: FetchStep[]) {
  const calls: { url: string; headers: Record<string, string>; redirect?: RequestRedirect }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
    const s = steps.shift();
    if (s === undefined) throw new Error('fakeFetch: unexpected extra call');
    if (s instanceof Error) throw s;
    return new Response(s.body === undefined ? '' : JSON.stringify(s.body), {
      status: s.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const AUTH = { token: 'fake-token', accountId: 'fake-account' };

/** The source's wall clock follows the `now` of the most recent fetch (the response takes no time). */
function source(rpc: RpcStep[], http: FetchStep[] = [], readAuth: () => typeof AUTH | null = () => AUTH) {
  const r = fakeRpc(rpc);
  const f = fakeFetch(http);
  const clock = { now: T0 };
  const src = new CodexSource({ client: r.client, fetchImpl: f.fetchImpl, readAuth, clock: () => clock.now });
  const fetch = src.fetch.bind(src);
  src.fetch = (now, opts) => {
    clock.now = now;
    return fetch(now, opts);
  };
  return { src, rpcCalls: r.calls, httpCalls: f.calls, client: r.client };
}

test('cold start: RPC ok → app_server; within 5 min → same value without a new call; after 5 min → new call', async () => {
  const s = source([{ result: RPC_PROBED }, { result: RPC_TWO_WINDOWS }]);
  const a = await s.src.fetch(T0);
  assert.equal(a?.source, 'app_server');
  assert.equal(a?.weekly?.usedPct, 40);
  const b = await s.src.fetch(at(4));
  assert.equal(b?.source, 'app_server', 'throttled: previous good value stays labelled app_server');
  assert.equal(b?.ok, true);
  assert.equal(b?.fetchedAt, T0.toISOString());
  assert.equal(s.rpcCalls.length, 1);
  const c = await s.src.fetch(at(5));
  assert.equal(c?.weekly?.usedPct, 64);
  assert.equal(s.rpcCalls.length, 2);
  assert.equal(s.httpCalls.length, 0, 'fallback never touched');
});

test('?refresh=1 bypasses the 5 min wait but not the 1 min floor', async () => {
  const s = source([{ result: RPC_PROBED }, { result: RPC_TWO_WINDOWS }]);
  await s.src.fetch(T0);
  await s.src.fetch(at(0.5), { refresh: true });
  assert.equal(s.rpcCalls.length, 1, 'floor holds');
  await s.src.fetch(at(1), { refresh: true });
  assert.equal(s.rpcCalls.length, 2);
});

test('never succeeded → null; RPC and fallback both fail → null (cold) then cache (after a success)', async () => {
  const s = source([new Error('spawn failed'), { result: RPC_PROBED }, new Error('dead')], [
    { status: 500 },
    new Error('offline'),
  ]);
  assert.equal(await s.src.fetch(T0), null);
  assert.equal(s.src.state, 'DEGRADED');
  assert.equal(s.httpCalls.length, 1, 'fallback attempted once');
  const good = await s.src.fetch(at(1));
  assert.equal(good?.source, 'app_server');
  assert.equal(s.src.state, 'FRESH');
  const cached = await s.src.fetch(at(6));
  assert.equal(cached?.source, 'cache');
  assert.equal(cached?.ok, false);
  assert.equal(cached?.weekly?.usedPct, 40);
  assert.equal(cached?.fetchedAt, at(1).toISOString());
  assert.doesNotThrow(() => wrap(cached));
});

test('RPC failure → backend fallback with Bearer + ChatGPT-Account-ID → source:"backend_api"', async () => {
  const s = source([new Error('rpc down')], [{ status: 200, body: RPC_TWO_WINDOWS }]);
  const u = await s.src.fetch(T0);
  assert.equal(u?.source, 'backend_api');
  assert.equal(u?.fiveHour?.usedPct, 18);
  assert.equal(s.httpCalls[0]?.url, CODEX_BACKEND_USAGE_URL);
  assert.equal(s.httpCalls[0]?.headers.Authorization, 'Bearer fake-token');
  assert.equal(s.httpCalls[0]?.headers['ChatGPT-Account-ID'], 'fake-account');
  // §6 rule 1: no redirect may carry the token past the canonical-URL check (codex QA 2026-09-08).
  assert.equal(s.httpCalls[0]?.redirect, 'error');
  assert.equal(s.src.state, 'FRESH');
});

test('fallback without readable auth → DEGRADED, no HTTP call', async () => {
  const s = source([new Error('rpc down')], [], () => null);
  assert.equal(await s.src.fetch(T0), null);
  assert.equal(s.httpCalls.length, 0);
  assert.equal(s.src.state, 'DEGRADED');
});

test('429 from the fallback → BACKOFF 5 min: no requests leave, cache returned; then a fresh read', async () => {
  const s = source([{ result: RPC_PROBED }, new Error('x'), { result: RPC_TWO_WINDOWS }], [{ status: 429 }]);
  await s.src.fetch(T0);
  const b = await s.src.fetch(at(5), { refresh: true });
  assert.equal(b?.source, 'cache');
  assert.equal(s.src.state, 'BACKOFF');
  const during = await s.src.fetch(at(9), { refresh: true });
  assert.equal(during?.source, 'cache');
  assert.equal(s.rpcCalls.length, 2, 'no RPC during back-off');
  assert.equal(s.httpCalls.length, 1, 'no HTTP during back-off');
  const after = await s.src.fetch(at(10));
  assert.equal(after?.source, 'app_server');
  assert.equal(s.src.state, 'FRESH');
});

test('429 surfaced by the RPC error → BACKOFF without touching the fallback', async () => {
  const s = source([{ result: RPC_PROBED }, new Error('rpc: HTTP 429 Too Many Requests')], [{ status: 200, body: RPC_TWO_WINDOWS }]);
  await s.src.fetch(T0);
  const b = await s.src.fetch(at(5));
  assert.equal(b?.source, 'cache');
  assert.equal(s.src.state, 'BACKOFF');
  assert.equal(s.httpCalls.length, 0);
});

// codex review 2026-09-08: the back-off used to start at the request's `now`; a slow 429 (9 s in
// flight) then ended 9 s early. The quiet period must start when the 429 actually arrives.
const SEC = 1_000;
const plus = (seconds: number) => new Date(T0.getTime() + seconds * SEC);

test('HTTP 429 arriving 9 s after the request → back-off counts from arrival: T0+300 s blocked, T0+309 s open', async () => {
  const clock = { now: T0 };
  const r = fakeRpc([new Error('rpc down'), { result: RPC_PROBED }]);
  let http = 0;
  const fetchImpl = (async () => {
    http++;
    clock.now = plus(9); // the response lands 9 s after the request left
    return new Response('', { status: 429 });
  }) as typeof fetch;
  const src = new CodexSource({ client: r.client, fetchImpl, readAuth: () => AUTH, clock: () => clock.now });
  assert.equal(await src.fetch(T0), null);
  assert.equal(src.state, 'BACKOFF');
  clock.now = plus(300);
  assert.equal(await src.fetch(plus(300), { refresh: true }), null);
  assert.equal(r.calls.length, 1, 'T0+300 s: still inside the 5 min counted from the 429 arrival');
  assert.equal(http, 1);
  clock.now = plus(309);
  const open = await src.fetch(plus(309));
  assert.equal(open?.source, 'app_server');
  assert.equal(src.state, 'FRESH');
});

test('RPC error text carrying 429, arriving 9 s after the request → same arrival-based back-off', async () => {
  const clock = { now: T0 };
  const steps: RpcStep[] = [new Error('rpc: HTTP 429 Too Many Requests'), { result: RPC_PROBED }];
  const client: RpcClient = {
    async call() {
      const s = steps.shift();
      if (s === undefined) throw new Error('unexpected extra call');
      if (s instanceof Error) {
        clock.now = plus(9); // the error surfaces 9 s after the request left
        throw s;
      }
      return s.result;
    },
    close() {},
  };
  const f = fakeFetch([]);
  const src = new CodexSource({ client, fetchImpl: f.fetchImpl, readAuth: () => AUTH, clock: () => clock.now });
  assert.equal(await src.fetch(T0), null);
  assert.equal(src.state, 'BACKOFF');
  assert.equal(f.calls.length, 0, 'fallback untouched');
  clock.now = plus(300);
  assert.equal(await src.fetch(plus(300), { refresh: true }), null);
  assert.equal(steps.length, 1, 'T0+300 s: no RPC');
  clock.now = plus(309);
  assert.equal((await src.fetch(plus(309)))?.source, 'app_server');
});

test('401 from the fallback → AUTH_LOST + cache; unmappable 200 body → DEGRADED', async () => {
  const s = source([{ result: RPC_PROBED }, new Error('x'), new Error('y')], [{ status: 401 }, { status: 200, body: { nope: 1 } }]);
  await s.src.fetch(T0);
  const a = await s.src.fetch(at(5));
  assert.equal(a?.source, 'cache');
  assert.equal(s.src.state, 'AUTH_LOST');
  const d = await s.src.fetch(at(10));
  assert.equal(d?.source, 'cache');
  assert.equal(s.src.state, 'DEGRADED');
});

test('unmappable RPC result → fallback (not a crash)', async () => {
  const s = source([{ result: { rateLimits: { primary: null } } }], [{ status: 200, body: RPC_TWO_WINDOWS }]);
  const u = await s.src.fetch(T0);
  assert.equal(u?.source, 'backend_api');
});

test('error messages never carry the token', async () => {
  const s = source([new Error('rpc down')], [new Error('boom fake-token boom')]);
  assert.equal(await s.src.fetch(T0), null);
  assert.equal(s.src.state, 'DEGRADED');
});

test('RPC failure after a success → ok:false, source:"cache", values kept; never ok:true', async () => {
  const s = source([{ result: RPC_PROBED }, new Error('app-server not running')], [{ status: 500 }]);
  const a = await s.src.fetch(T0);
  assert.equal(a?.ok, true);
  const b = await s.src.fetch(at(5));
  assert.equal(b?.ok, false);
  assert.equal(b?.source, 'cache');
  assert.equal(b?.weekly?.usedPct, 40);
  assert.equal(b?.fetchedAt, T0.toISOString());
  assert.equal(s.src.state, 'DEGRADED');
  // Throttled in between: still the cache label (nothing new happened, last read failed).
  const c = await s.src.fetch(at(5.5));
  assert.equal(c?.source, 'cache');
  assert.equal(s.rpcCalls.length, 2);
});

// ---- AppServerClient: framing, handshake, autonomous restart back-off ----------------------------

const settle = () => new Promise<void>((r) => setImmediate(r));

/** Deterministic timer queue injected as setTimeoutImpl/clearTimeoutImpl; `now` is the fake clock (ms). */
class FakeTimers {
  now = T0.getTime();
  private seq = 0;
  private readonly queue = new Map<number, { at: number; fn: () => void }>();
  readonly setTimeoutImpl = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.queue.set(id, { at: this.now + ms, fn });
    return id;
  };
  readonly clearTimeoutImpl = (h: unknown): void => {
    this.queue.delete(h as number);
  };
  get pending(): number {
    return this.queue.size;
  }
  /** Advance the clock, firing due timers in order and letting microtasks/handshakes settle after each. */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.queue) if (e[1].at <= target && (next === null || e[1].at < next[1].at)) next = e;
      if (next === null) break;
      this.queue.delete(next[0]);
      this.now = next[1].at;
      next[1].fn();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

/** Scriptable stand-in for the `codex app-server` child: answers requests by method. */
class FakeChild extends EventEmitter implements ChildLike {
  readonly writes: string[] = [];
  killed = false;
  /** Every signal received via kill(), in order. */
  readonly signals: string[] = [];
  /** false: a kill() is recorded but the process never reports `exit` (still running / wedged). */
  exitOnKill = true;
  readonly stdout = new EventEmitter();
  /** stdin's own event channel: a real Writable emits `error` (EPIPE) asynchronously after the child dies. */
  readonly stdinEvents = new EventEmitter();
  readonly stdin: ChildLike['stdin'];
  constructor(private readonly answers: Record<string, (id: number) => string | null>) {
    super();
    this.stdin = {
      write: (chunk: string) => {
        this.writes.push(chunk);
        const req = JSON.parse(chunk) as { id: number; method: string };
        const line = this.answers[req.method]?.(req.id);
        if (line !== null && line !== undefined) queueMicrotask(() => this.stdout.emit('data', Buffer.from(line)));
        return true;
      },
      on: (event, cb) => this.stdinEvents.on(event, cb),
    };
  }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signals.push(signal);
    if (this.exitOnKill) queueMicrotask(() => this.emit('exit', null, signal));
    return true;
  }
  /** Simulate a crash. */
  die(): void {
    this.emit('exit', 1, null);
  }
  /** Number of `account/rateLimits/read` requests this child received. */
  get reads(): number {
    return this.writes.filter((w) => (JSON.parse(w) as { method: string }).method === 'account/rateLimits/read').length;
  }
}

const initOk = (id: number) => JSON.stringify({ id, result: { userAgent: 'x' } }) + '\n';
const rlOk = (id: number) => JSON.stringify({ id, result: RPC_PROBED }) + '\n';
const HEALTHY = { initialize: initOk, 'account/rateLimits/read': rlOk };

function fakeSpawn(timers: FakeTimers, factory: () => FakeChild = () => new FakeChild(HEALTHY)) {
  const spawnedAt: number[] = [];
  const children: FakeChild[] = [];
  const spawnImpl = () => {
    spawnedAt.push(timers.now);
    const c = factory();
    children.push(c);
    return c;
  };
  return { spawnImpl, spawnedAt, children };
}

/** A child that crashes as soon as it receives `initialize` (never completes the handshake). */
function crashOnInit(): FakeChild {
  const c = new FakeChild({ initialize: () => null, 'account/rateLimits/read': rlOk });
  const orig = c.stdin.write;
  c.stdin.write = (chunk: string) => {
    const ok = orig(chunk);
    queueMicrotask(() => c.die());
    return ok;
  };
  return c;
}

function client(timers: FakeTimers, sp: ReturnType<typeof fakeSpawn>, timeoutMs?: number) {
  return new AppServerClient({
    spawnImpl: sp.spawnImpl,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

test('client: JSON-lines framing, initialize handshake before the first request, ids correlate', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers);
  const c = client(timers, sp);
  const r = (await c.call('account/rateLimits/read')) as typeof RPC_PROBED;
  assert.equal(r.rateLimits.primary.usedPercent, 40);
  const child = sp.children[0]!;
  assert.equal(child.writes.length, 2);
  for (const w of child.writes) assert.ok(w.endsWith('\n') && !w.slice(0, -1).includes('\n'), 'one JSON object per line');
  const [init, rl] = child.writes.map((w) => JSON.parse(w) as { id: number; method: string; params?: unknown });
  assert.equal(init!.method, 'initialize');
  assert.ok((init!.params as { clientInfo: { name: string } }).clientInfo.name);
  assert.equal(rl!.method, 'account/rateLimits/read');
  assert.notEqual(init!.id, rl!.id);
  // Second call reuses the live child: no new spawn, no second initialize.
  await c.call('account/rateLimits/read');
  assert.equal(sp.spawnedAt.length, 1);
  assert.equal(child.writes.length, 3);
  c.close();
  assert.equal(child.killed, true);
  await settle();
  assert.equal(timers.pending, 0, 'close(): no restart scheduled for the child we killed');
});

test('client: notifications and stray server requests are ignored; error responses reject', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers, () => new FakeChild({
    initialize: (id) => '{"method":"remoteControl/status/changed","params":{}}\n{"id":999,"method":"item/commandExecution/requestApproval","params":{}}\n' + initOk(id),
    'account/rateLimits/read': (id) => JSON.stringify({ id, error: { code: -32600, message: 'Not initialized' } }) + '\n',
  }));
  const c = client(timers, sp);
  // Upstream text is deliberately not forwarded (it may quote the request); only the classification is.
  await assert.rejects(c.call('account/rateLimits/read'), /^Error: app-server rpc error$/);
  c.close();
});

// codex review 2026-09-08: a child that answers initialize but then goes silent must be killed and respawned.
test('client: a post-handshake RPC timeout kills the wedged child and schedules a respawn', async () => {
  const timers = new FakeTimers();
  let n = 0;
  const sp = fakeSpawn(timers, () =>
    new FakeChild(n++ === 0 ? { initialize: initOk, 'account/rateLimits/read': () => null } : HEALTHY),
  );
  const c = client(timers, sp, 50);
  await assert.rejects(c.call('account/rateLimits/read'), /timeout/);
  const wedged = sp.children[0]!;
  assert.equal(wedged.killed, true, 'the silent child is killed');
  assert.equal(c.alive, false);
  await timers.advance(1_000);
  assert.equal(sp.spawnedAt.length, 2, 'respawned on the back-off timer');
  const r = await c.call('account/rateLimits/read');
  assert.ok(r !== null && typeof r === 'object', 'the replacement answers');
  c.close();
});

test('client: request timeout rejects and does not hang', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers, () => new FakeChild({ initialize: initOk, 'account/rateLimits/read': () => null }));
  const c = client(timers, sp, 20);
  await assert.rejects(c.call('account/rateLimits/read'), /timeout/);
  c.close();
});

test('client (a): a dead child is respawned and initialized by the client itself, without any call', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers);
  const c = client(timers, sp);
  await c.call('account/rateLimits/read');
  assert.equal(c.restarts, 0);

  sp.children[0]!.die();
  assert.equal(c.alive, false);
  assert.equal(timers.pending, 1, 'a restart is scheduled at the moment of death');
  assert.equal(sp.spawnedAt.length, 1, 'not respawned synchronously');
  await timers.advance(999);
  assert.equal(sp.spawnedAt.length, 1, 'not before 1 s');
  await timers.advance(1);
  assert.equal(sp.spawnedAt.length, 2, 'respawned at 1 s with no call in between');
  assert.equal(c.restarts, 1);
  const child2 = sp.children[1]!;
  assert.equal(child2.writes.length, 1, 'initialize sent by the client itself');
  assert.equal((JSON.parse(child2.writes[0]!) as { method: string }).method, 'initialize');
  assert.equal(c.alive, true);
  // The next call rides on the already-initialized child: one read, no extra initialize.
  const r = (await c.call('account/rateLimits/read')) as typeof RPC_PROBED;
  assert.equal(r.rateLimits.primary.usedPercent, 40);
  assert.equal(child2.writes.length, 2);
  assert.equal(sp.spawnedAt.length, 2);
  c.close();
});

test('client (b): consecutive deaths back off 1s, 2s, 4s … 60s, 60s; a successful initialize resets to 1s', async () => {
  const timers = new FakeTimers();
  let crashes = 8;
  const sp = fakeSpawn(timers, () => (crashes-- > 0 ? crashOnInit() : new FakeChild(HEALTHY)));
  const c = client(timers, sp);
  await assert.rejects(c.call('account/rateLimits/read')); // spawn #1 crashes during initialize
  await settle();
  const expected = [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000];
  for (const delay of expected) {
    const before = sp.spawnedAt.length;
    await timers.advance(delay - 1);
    assert.equal(sp.spawnedAt.length, before, `no spawn before ${delay} ms`);
    await timers.advance(1);
    assert.equal(sp.spawnedAt.length, before + 1, `spawn at ${delay} ms`);
  }
  const gaps = sp.spawnedAt.slice(1).map((t, i) => t - sp.spawnedAt[i]!);
  assert.deepEqual(gaps, expected);
  // Spawn #9 is healthy and has initialized: the sequence is reset — its death waits 1 s again.
  assert.equal(c.alive, true);
  sp.children[8]!.die();
  await timers.advance(1_000);
  assert.equal(sp.spawnedAt.length, 10, 'delay back to 1 s after a successful initialize');
  assert.equal(c.alive, true);
  c.close();
  await settle();
  assert.equal(timers.pending, 0);
});

test('client: call() while no child is alive rejects ("not running") and does not spawn eagerly', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers);
  const c = client(timers, sp);
  await c.call('account/rateLimits/read');
  sp.children[0]!.die();
  await assert.rejects(c.call('account/rateLimits/read'), /not running/);
  assert.equal(sp.spawnedAt.length, 1, 'the restart timer, not the call, does the respawn');
  c.close();
});

test('client: call() during an in-flight initialize waits for it instead of rejecting', async () => {
  const timers = new FakeTimers();
  // Child #2 answers initialize only when the test releases it; call() must wait on that handshake.
  let n = 0;
  const gate: { release: (() => void) | null } = { release: null };
  const sp = fakeSpawn(timers, () => {
    n++;
    if (n === 1) return new FakeChild(HEALTHY);
    const c = new FakeChild({ initialize: () => null, 'account/rateLimits/read': rlOk });
    const orig = c.stdin.write;
    c.stdin.write = (chunk: string) => {
      const ok = orig(chunk);
      const req = JSON.parse(chunk) as { id: number; method: string };
      if (req.method === 'initialize') gate.release = () => c.stdout.emit('data', Buffer.from(initOk(req.id)));
      return ok;
    };
    return c;
  });
  const c = client(timers, sp);
  await c.call('account/rateLimits/read');
  sp.children[0]!.die();
  await timers.advance(1_000); // child #2 spawned; initialize in flight (unanswered)
  assert.equal(sp.spawnedAt.length, 2);
  const release = gate.release;
  assert.ok(release, 'initialize was sent');
  const pending = c.call('account/rateLimits/read');
  let settled = false;
  void pending.then(() => (settled = true), () => (settled = true));
  await settle();
  assert.equal(settled, false, 'call waits for the handshake instead of rejecting');
  release();
  const r = (await pending) as typeof RPC_PROBED;
  assert.equal(r.rateLimits.primary.usedPercent, 40);
  assert.equal(sp.children[1]!.reads, 1);
  c.close();
});

test('client: spawn throwing (binary missing) rejects the call, then retries on the back-off timer', async () => {
  const timers = new FakeTimers();
  let n = 0;
  const c = new AppServerClient({
    spawnImpl: () => {
      n++;
      throw new Error('ENOENT');
    },
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
  });
  await assert.rejects(c.call('account/rateLimits/read'), /ENOENT/);
  await assert.rejects(c.call('account/rateLimits/read'), /not running/);
  assert.equal(n, 1);
  await timers.advance(1_000);
  assert.equal(n, 2, 'retried after 1 s');
  await timers.advance(2_000);
  assert.equal(n, 3, 'retried after 2 s');
  c.close();
  await settle();
  assert.equal(timers.pending, 0);
});

test('client: asynchronous stdin error (EPIPE) rejects the call, crashes nothing, and the child is respawned', async () => {
  const timers = new FakeTimers();
  // Child #1 answers initialize, then on the first request its stdin "breaks" asynchronously (EPIPE)
  // instead of answering — exactly what a Writable does once the peer has gone away.
  let n = 0;
  const sp = fakeSpawn(timers, () => {
    const c = new FakeChild(n++ === 0 ? { initialize: initOk, 'account/rateLimits/read': () => null } : HEALTHY);
    if (n === 1) {
      const orig = c.stdin.write;
      c.stdin.write = (chunk: string) => {
        const ok = orig(chunk);
        if ((JSON.parse(chunk) as { method: string }).method === 'account/rateLimits/read') {
          queueMicrotask(() => c.stdinEvents.emit('error', new Error('write EPIPE')));
        }
        return ok;
      };
    }
    return c;
  });
  let uncaught = 0;
  const onUncaught = () => {
    uncaught++;
  };
  process.on('uncaughtException', onUncaught);
  const c = client(timers, sp, 50);
  await assert.rejects(c.call('account/rateLimits/read'), /exited/);
  await assert.rejects(c.call('account/rateLimits/read'), /not running/);
  await timers.advance(1_000);
  const r = (await c.call('account/rateLimits/read')) as typeof RPC_PROBED;
  assert.equal(r.rateLimits.primary.usedPercent, 40);
  assert.equal(sp.spawnedAt.length, 2);
  await new Promise((r) => setTimeout(r, 10));
  process.off('uncaughtException', onUncaught);
  assert.equal(uncaught, 0);
  c.close();
});

// codex review 2026-09-08: a stdin `error` (EPIPE) only detached the child; when the process was in
// fact still alive it leaked, and close() later killed only its replacement.
test('client: stdin error without an exit → the child is SIGTERMed; close() SIGKILLs it and SIGTERMs the replacement', async () => {
  const timers = new FakeTimers();
  let n = 0;
  const sp = fakeSpawn(timers, () => {
    const c = new FakeChild(n++ === 0 ? { initialize: initOk, 'account/rateLimits/read': () => null } : HEALTHY);
    if (n === 1) {
      c.exitOnKill = false; // wedged: takes the signal, never reports exit
      const orig = c.stdin.write;
      c.stdin.write = (chunk: string) => {
        const ok = orig(chunk);
        if ((JSON.parse(chunk) as { method: string }).method === 'account/rateLimits/read') {
          queueMicrotask(() => c.stdinEvents.emit('error', new Error('write EPIPE')));
        }
        return ok;
      };
    }
    return c;
  });
  const c = client(timers, sp, 50);
  await assert.rejects(c.call('account/rateLimits/read'), /exited/);
  const old = sp.children[0]!;
  assert.equal(old.killed, true, 'the detached child is killed, not merely forgotten');
  assert.deepEqual(old.signals, ['SIGTERM']);
  await timers.advance(1_000);
  assert.equal(sp.spawnedAt.length, 2);
  const fresh = sp.children[1]!;
  c.close();
  assert.deepEqual(old.signals, ['SIGTERM', 'SIGKILL'], 'close(): the child that never confirmed its exit gets SIGKILL');
  assert.deepEqual(fresh.signals, ['SIGTERM']);
  // codex review 2026-09-08: the current child only got SIGTERM; before process exit it must be SIGKILLed too.
  fresh.exitOnKill = false;
  c.killAll();
  assert.deepEqual(fresh.signals, ['SIGTERM', 'SIGKILL'], 'killAll(): the wedged current child gets SIGKILL');
  await settle();
  assert.equal(timers.pending, 0);
});

// codex review 2026-09-08: the upstream error message may quote the request (tokens); only a
// classification may leave the client.
test('client: an RPC error message is never forwarded, only classified (rate_limited or generic)', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers, () =>
    new FakeChild({
      initialize: initOk,
      'account/rateLimits/read': (id) =>
        JSON.stringify({ id, error: { code: -32000, message: 'HTTP 429 for Bearer sk-fake-SECRET-token' } }) + '\n',
    }),
  );
  const c = client(timers, sp, 50);
  await assert.rejects(c.call('account/rateLimits/read'), (e: Error) => {
    assert.equal(e.message, 'app-server rpc error: rate_limited');
    assert.equal(e.message.includes('SECRET'), false);
    return true;
  });
  c.close();
});

// codex review 2026-09-08: wedged children that ignore SIGTERM used to pile up until daemon shutdown.
test('client: a child that ignores SIGTERM is SIGKILLed after the grace period; repeated failures keep live children bounded', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers, () => {
    const c = new FakeChild({ initialize: () => null, 'account/rateLimits/read': rlOk }); // never answers initialize
    c.exitOnKill = false; // and never exits on any signal
    return c;
  });
  const c = client(timers, sp, 20);
  await assert.rejects(c.call('account/rateLimits/read'), /timeout: initialize/);
  assert.deepEqual(sp.children[0]!.signals, ['SIGTERM']);
  await timers.advance(4_999);
  assert.deepEqual(sp.children[0]!.signals, ['SIGTERM'], 'still inside the grace period');
  await timers.advance(1);
  assert.deepEqual(sp.children[0]!.signals, ['SIGTERM', 'SIGKILL'], 'grace period over: SIGKILL');
  // Let several restart cycles fail the same way (the 20 ms RPC timeout is a real timer, so let it
  // fire between fake-clock jumps); every child must end up SIGKILLed, none accumulates.
  for (let i = 0; i < 4; i++) {
    await timers.advance(70_000);
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.ok(sp.children.length >= 3, `several respawns happened (${sp.children.length})`);
  for (const child of sp.children.slice(0, -1)) {
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL'], 'every earlier wedged child was force-killed');
  }
  c.close();
  await settle();
  assert.equal(timers.pending, 0, 'no grace timers leak after close()');
});

test('client: a child that did exit after its SIGTERM is not SIGKILLed on close()', async () => {
  const timers = new FakeTimers();
  let n = 0;
  const sp = fakeSpawn(timers, () => new FakeChild(n++ === 0 ? { initialize: () => null, 'account/rateLimits/read': rlOk } : HEALTHY));
  const c = client(timers, sp, 20);
  await assert.rejects(c.call('account/rateLimits/read'), /timeout: initialize/);
  const old = sp.children[0]!;
  await settle(); // its exit is reported
  await timers.advance(1_000);
  c.close();
  assert.deepEqual(old.signals, ['SIGTERM']);
  assert.deepEqual(sp.children[1]!.signals, ['SIGTERM']);
});

test('client: initialize timeout kills the child and respawns on the back-off timer instead of hanging forever', async () => {
  const timers = new FakeTimers();
  let n = 0;
  // Child #1 never answers initialize; child #2 is healthy.
  const sp = fakeSpawn(timers, () => new FakeChild(n++ === 0 ? { initialize: () => null, 'account/rateLimits/read': rlOk } : HEALTHY));
  const c = client(timers, sp, 20);
  await assert.rejects(c.call('account/rateLimits/read'), /timeout: initialize/);
  assert.equal(sp.children[0]!.killed, true, 'the unresponsive child is killed');
  assert.equal(c.alive, false);
  await assert.rejects(c.call('account/rateLimits/read'), /not running/);
  await timers.advance(1_000);
  assert.equal(sp.spawnedAt.length, 2);
  assert.equal(c.restarts, 1);
  const r = (await c.call('account/rateLimits/read')) as typeof RPC_PROBED;
  assert.equal(r.rateLimits.primary.usedPercent, 40);
  c.close();
});

// ---- CodexSource over a real AppServerClient: lifecycle and reads are independent -----------------

function sourceOverClient(timers: FakeTimers, sp: ReturnType<typeof fakeSpawn>, http: FetchStep[] = []) {
  const c = client(timers, sp);
  const f = fakeFetch(http);
  const src = new CodexSource({ client: c, fetchImpl: f.fetchImpl, readAuth: () => AUTH, clock: () => new Date(timers.now) });
  const fetchNow = (opts?: { refresh?: boolean }) => src.fetch(new Date(timers.now), opts);
  return { src, client: c, httpCalls: f.calls, fetchNow };
}

test('CodexSource (c): reads after a death follow the throttle only — 0/20/60 s → RPC at 0 s and 60 s', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers);
  const s = sourceOverClient(timers, sp, [{ status: 500 }]);
  const a = await s.fetchNow();
  assert.equal(a?.source, 'app_server');

  await timers.advance(5 * MIN); // next read is due
  sp.children[0]!.die();
  const t = await s.fetchNow(); // 0 s after death: due → attempt → child not back yet → fallback 500 → cache
  assert.equal(t?.ok, false);
  assert.equal(t?.source, 'cache');
  assert.equal(s.httpCalls.length, 1);
  assert.equal(s.src.state, 'DEGRADED');

  await timers.advance(20_000); // child respawned at +1 s and initialized
  assert.equal(sp.spawnedAt.length, 2);
  assert.equal(s.client.alive, true);
  const u = await s.fetchNow(); // 20 s: inside the 1 min floor → no read, last value still cache-labelled
  assert.equal(u?.source, 'cache');
  assert.equal(sp.children[1]!.reads, 0, 'the floor holds even though the child is back');

  await timers.advance(40_000);
  const v = await s.fetchNow(); // 60 s: the floor allows a retry → fresh read
  assert.equal(v?.ok, true);
  assert.equal(v?.source, 'app_server');
  assert.equal(v?.fetchedAt, new Date(timers.now).toISOString(), 'fetchedAt advanced');
  // Attempts: T0, death+0 s (rejected before reaching any child), death+60 s → reads that reached a child: 2.
  assert.equal(sp.children[0]!.reads + sp.children[1]!.reads, 2, 'T0 and death+60 s only; 20 s was throttled');
  assert.equal(s.httpCalls.length, 1, 'no second fallback call');
  assert.equal(s.src.state, 'FRESH');
  s.src.close();
});

test('CodexSource (d): read while the child is still being reborn → ok:false, source:"cache", values kept', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers);
  const s = sourceOverClient(timers, sp, [new Error('offline')]);
  const a = await s.fetchNow();
  assert.equal(a?.weekly?.usedPct, 40);
  await timers.advance(5 * MIN);
  sp.children[0]!.die();
  const b = await s.fetchNow();
  assert.equal(b?.ok, false);
  assert.equal(b?.source, 'cache');
  assert.equal(b?.weekly?.usedPct, 40);
  assert.equal(b?.fetchedAt, a?.fetchedAt);
  assert.doesNotThrow(() => wrap(b));
  s.src.close();
});

test('CodexSource (e): during BACKOFF nothing is read, even when the child has been reborn', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers);
  const s = sourceOverClient(timers, sp, [{ status: 429 }]);
  await s.fetchNow();
  await timers.advance(5 * MIN);
  sp.children[0]!.die();
  const b = await s.fetchNow(); // child gone → fallback → 429 → BACKOFF
  assert.equal(b?.source, 'cache');
  assert.equal(s.src.state, 'BACKOFF');
  await timers.advance(2 * MIN); // child is back
  assert.equal(s.client.alive, true);
  const c = await s.fetchNow({ refresh: true });
  assert.equal(c?.source, 'cache');
  assert.equal(sp.children[1]!.reads, 0, 'no RPC during back-off');
  assert.equal(s.httpCalls.length, 1, 'no HTTP during back-off');
  await timers.advance(3 * MIN); // back-off over
  const d = await s.fetchNow();
  assert.equal(d?.source, 'app_server');
  assert.equal(s.src.state, 'FRESH');
  s.src.close();
});

test('CodexSource with a real AppServerClient over a fake child end-to-end', async () => {
  const timers = new FakeTimers();
  const sp = fakeSpawn(timers);
  const s = sourceOverClient(timers, sp);
  const u: ToolUsage | null = await s.fetchNow();
  assert.equal(u?.source, 'app_server');
  assert.equal(u?.weekly?.usedPct, 40);
  s.src.close();
  assert.equal(sp.children[0]!.killed, true);
});
