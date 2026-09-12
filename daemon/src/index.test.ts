// HttpServer (PLAN §10.2, T1.5, M9): the only route is GET /usage.json; CORS + no-store on every
// response; OPTIONS pre-flight → 204. Sources are fakes: no Keychain, child process, or network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { EXT_CLAUDE_SCOPED_MODEL, parseUsagePayload, type ToolUsage } from '@quotalens/shared';
import { Aggregator } from './aggregator.ts';
import { HttpServer, LISTEN_RETRY_INITIAL_MS, listenWithRetry } from './server.ts';
import { USAGE_PATH } from './config.ts';

let server: Server;
let port: number;

// Fake sources record the refresh flag they receive; null → "none" until a value is set.
const claudeCalls: boolean[] = [];
let claudeValue: ToolUsage | null = null;
let claudeScopedModel: string | null = null;
const codexCalls: boolean[] = [];
let codexValue: ToolUsage | null = null;
// Fake clock so the Aggregator's 60 s refresh throttle is deterministic across tests.
let now = new Date('2026-09-08T00:00:00.000Z');
const advance = (sec: number) => (now = new Date(now.getTime() + sec * 1000));

const aggregator = new Aggregator({
  claude: async (_now, opts) => {
    claudeCalls.push(opts.refresh === true);
    return { usage: claudeValue, scopedModel: claudeScopedModel };
  },
  codex: async (_now, opts) => {
    codexCalls.push(opts.refresh === true);
    return codexValue;
  },
});
const http = new HttpServer({ aggregator, clock: () => now });

before(async () => {
  server = createServer(http.handle);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no port');
  port = addr.port;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Raw request so malformed request-targets are sent verbatim (no client-side URL normalisation). */
function raw(method: string, path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}
const rawGet = (path: string) => raw('GET', path);

/** T1.5: every JSON reply carries the three contract headers. */
function assertJsonHeaders(r: Reply): void {
  assert.equal(r.headers['content-type'], 'application/json');
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.equal(r.headers['cache-control'], 'no-store');
}

test('GET usage path returns 200, the three headers, and a valid UsagePayload', async () => {
  const r = await rawGet(USAGE_PATH);
  assert.equal(r.status, 200);
  assertJsonHeaders(r);
  assert.doesNotThrow(() => parseUsagePayload(JSON.parse(r.body)));
});

test('the pre-M9 secret path and every near miss → 404 with the same body', async () => {
  const old = await rawGet(`/u/${'A'.repeat(32)}/usage.json`);
  assert.equal(old.status, 404, 'M9: the /u/<secret>/ route is gone');
  assertJsonHeaders(old);
  assert.deepEqual(JSON.parse(old.body), { error: 'not found' });
  const dev = await rawGet('/u/dev/usage.json');
  assert.equal(dev.status, 404, 'the T1.1 placeholder is gone');
  const nested = await rawGet(`${USAGE_PATH}/`);
  assert.equal(nested.status, 404);
  const root = await rawGet('/');
  assert.equal(root.status, 404);
});

test('OPTIONS pre-flight → 204 with CORS headers and no body', async () => {
  const r = await raw('OPTIONS', USAGE_PATH);
  assert.equal(r.status, 204);
  assert.equal(r.headers['access-control-allow-origin'], '*');
  assert.equal(r.headers['access-control-allow-methods'], 'GET');
  assert.equal(r.headers['access-control-allow-headers'], '*');
  assert.equal(r.body, '');
});

test('claude source null → source:"none"; a value is passed through; ?refresh=1 reaches the source', async () => {
  claudeCalls.length = 0;
  claudeValue = null;
  const none = parseUsagePayload(JSON.parse((await rawGet(USAGE_PATH)).body));
  assert.equal(none.claude.source, 'none');
  assert.equal(none.claude.ok, false);

  claudeValue = {
    ok: false,
    source: 'cache',
    fiveHour: { usedPct: 78, resetsAt: '2026-09-07T15:00:00.092Z' },
    weekly: { usedPct: 32, resetsAt: null },
    weeklySonnet: null,
    credits: null,
    fetchedAt: '2026-09-07T11:11:23.000Z',
  };
  const cached = parseUsagePayload(JSON.parse((await rawGet(`${USAGE_PATH}?refresh=1`)).body));
  assert.equal(cached.claude.source, 'cache');
  assert.deepEqual(cached.claude.fiveHour, { usedPct: 78, resetsAt: '2026-09-07T15:00:00.092Z' });
  assert.deepEqual(claudeCalls, [false, true]);
  claudeValue = null;
});

test('?refresh=1 within 60 s of the last real refresh is downgraded to a plain read; after 60 s it passes again', async () => {
  claudeCalls.length = 0;
  advance(30);
  await rawGet(`${USAGE_PATH}?refresh=1`);
  advance(30);
  await rawGet(`${USAGE_PATH}?refresh=1`);
  assert.deepEqual(claudeCalls, [false, true]);
});

// PLAN §3: ext.claudeScopedModel carries the per-model weekly window's display name (string|null).
test('ext.claudeScopedModel is emitted from the claude source and validates', async () => {
  claudeValue = {
    ok: true,
    source: 'oauth_usage',
    fiveHour: { usedPct: 78, resetsAt: '2026-09-07T15:00:00.092Z' },
    weekly: { usedPct: 32, resetsAt: '2026-09-08T08:00:00.092Z' },
    weeklySonnet: { usedPct: 46, resetsAt: '2026-09-08T08:00:00.093Z' },
    credits: null,
    fetchedAt: '2026-09-07T11:16:27.000Z',
  };
  claudeScopedModel = 'Fable';
  const raw = JSON.parse((await rawGet(USAGE_PATH)).body);
  assert.equal(raw.ext[EXT_CLAUDE_SCOPED_MODEL], 'Fable');
  const p = parseUsagePayload(raw);
  assert.equal(p.ext[EXT_CLAUDE_SCOPED_MODEL], 'Fable');
  assert.equal(p.claude.weeklySonnet?.usedPct, 46);

  claudeScopedModel = null;
  const none = JSON.parse((await rawGet(USAGE_PATH)).body);
  assert.equal(EXT_CLAUDE_SCOPED_MODEL in none.ext, true, 'key is present (null), not omitted');
  assert.equal(none.ext[EXT_CLAUDE_SCOPED_MODEL], null);
  assert.doesNotThrow(() => parseUsagePayload(none));
  claudeValue = null;
});

test('codex source null → source:"none"; a value is passed through; ?refresh=1 reaches the source', async () => {
  codexCalls.length = 0;
  codexValue = null;
  const none = parseUsagePayload(JSON.parse((await rawGet(USAGE_PATH)).body));
  assert.equal(none.codex.source, 'none');
  assert.equal(none.codex.ok, false);
  assert.equal(none.codex.credits, null);

  codexValue = {
    ok: true,
    source: 'app_server',
    fiveHour: null,
    weekly: { usedPct: 40, resetsAt: '2026-09-11T22:14:37.000Z' },
    weeklySonnet: null,
    credits: { remainingUsd: 4.2 },
    fetchedAt: '2026-09-08T10:00:00.000Z',
  };
  advance(60);
  const live = parseUsagePayload(JSON.parse((await rawGet(`${USAGE_PATH}?refresh=1`)).body));
  assert.equal(live.codex.source, 'app_server');
  assert.deepEqual(live.codex.weekly, { usedPct: 40, resetsAt: '2026-09-11T22:14:37.000Z' });
  assert.deepEqual(live.codex.credits, { remainingUsd: 4.2 });
  assert.deepEqual(codexCalls, [false, true]);
  codexValue = null;
});

test('malformed request-target returns 400 with the headers, and the server keeps serving', async () => {
  const bad = await rawGet('//[');
  assert.equal(bad.status, 400);
  assertJsonHeaders(bad);
  assert.deepEqual(JSON.parse(bad.body), { error: 'bad request' });
  const ok = await rawGet(USAGE_PATH);
  assert.equal(ok.status, 200);
});

test('unknown path returns 404 with the headers', async () => {
  const r = await rawGet('/nope');
  assert.equal(r.status, 404);
  assertJsonHeaders(r);
  assert.deepEqual(JSON.parse(r.body), { error: 'not found' });
});

// codex review 2026-09-09: an unhandled bind error on the tailnet listener would have been an uncaught
// exception and taken the loopback listener down with it (EADDRNOTAVAIL before tailscaled is up).
test('listenWithRetry: a bind error is logged with its code and retried with back-off; success resets; stop cancels', () => {
  const events: string[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  let mode: 'fail' | 'ok' = 'fail';
  // Holder object rather than a `let`: TS narrows a closure-assigned `let` to its initial null.
  const last: { onError: ((e: NodeJS.ErrnoException) => void) | null } = { onError: null };
  const make = () => {
    let onError: ((e: NodeJS.ErrnoException) => void) | null = null;
    return {
      on: (_e: 'error', h: (e: NodeJS.ErrnoException) => void) => (onError = last.onError = h),
      listen: (_p: number, _h: string, onListening: () => void) => {
        if (mode === 'fail') onError?.(Object.assign(new Error('bind'), { code: 'EADDRNOTAVAIL' }));
        else onListening();
      },
      close: () => events.push('close'),
    };
  };
  const stop = listenWithRetry(make, '100.64.0.9', 1, {
    log: (l) => events.push(l),
    setTimer: (fn, ms) => (timers.push({ fn, ms }), timers.length),
    clearTimer: (t) => events.push(`clear:${String(t)}`),
  });
  assert.deepEqual(timers.map((t) => t.ms), [LISTEN_RETRY_INITIAL_MS]);
  assert.match(events[events.length - 1] ?? '', /EADDRNOTAVAIL.*5s/);
  assert.equal(events.some((e) => e.includes('bind')), false, 'the error object is never logged');
  timers[0]!.fn();
  timers[1]!.fn();
  assert.deepEqual(timers.map((t) => t.ms), [5_000, 10_000, 20_000], 'back-off doubles');
  timers[2]!.fn();
  timers[3]!.fn();
  timers[4]!.fn();
  assert.deepEqual(timers.slice(3).map((t) => t.ms), [40_000, 60_000, 60_000], 'capped at LISTEN_RETRY_MAX_MS');
  mode = 'ok';
  timers[5]!.fn();
  assert.equal(timers.length, 6, 'no retry after a successful bind');
  // Success resets the back-off: when the live server later errors (the address went away), the
  // next wait is the initial delay again, not the 60 s the previous run had climbed to.
  mode = 'fail';
  const closesBefore = events.filter((e) => e === 'close').length;
  last.onError?.(Object.assign(new Error('bind'), { code: 'EADDRNOTAVAIL' }));
  assert.equal(events.filter((e) => e === 'close').length, closesBefore + 1, 'the failed live server is closed');
  assert.equal(timers[6]!.ms, LISTEN_RETRY_INITIAL_MS, 'back-off reset by the successful bind');
  stop();
  assert.equal(events[events.length - 1], 'clear:7', 'stop cancels the retry that was pending');
  // A failure after stop schedules nothing.
  mode = 'fail';
  const stop2 = listenWithRetry(make, '100.64.0.9', 1, { log: () => undefined, setTimer: (fn, ms) => (timers.push({ fn, ms }), 99), clearTimer: (t) => events.push(`clear:${String(t)}`) });
  stop2();
  assert.equal(events[events.length - 1], 'clear:99', 'stop cancels the pending retry');
  const n = timers.length;
  timers[n - 1]!.fn();
  assert.equal(timers.length, n, 'a cancelled retry does not reschedule');
});

test('non-GET on the usage path returns 404', async () => {
  for (const method of ['POST', 'PUT', 'DELETE', 'HEAD']) {
    const r = await raw(method, USAGE_PATH);
    assert.equal(r.status, 404, method);
  }
});
