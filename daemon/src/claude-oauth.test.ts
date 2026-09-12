// T1.3 oauth/usage fallback — throttle state machine (PLAN §10.3(b)), schema mapping, source priority.
// No real network, no real Keychain: token reader and fetch are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUsagePayload } from '@quotalens/shared';
import { ClaudeSource, mapOauthUsage } from './claude.ts';

const FAKE_TOKEN = 'fake-token';
const MIN = 60_000;
const T0 = new Date('2026-09-07T11:11:23Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

// Shape as probed 2026-09-07 against GET /api/oauth/usage (values only; irrelevant keys trimmed).
// utilization is 0–100, resets_at is an ISO string with microseconds; the per-model weekly keys
// (seven_day_sonnet / seven_day_opus) are present but null on this account — the per-model
// window actually lives in limits[] as kind:"weekly_scoped" with percent + scope.model.display_name.
const WEEKLY_SCOPED = {
  kind: 'weekly_scoped',
  group: 'weekly',
  percent: 46,
  severity: 'normal',
  resets_at: '2026-09-08T08:00:00.093069+00:00',
  scope: { model: { id: null, display_name: 'Fable' }, surface: null },
  is_active: false,
};
const OAUTH_BODY = {
  five_hour: { utilization: 78.0, resets_at: '2026-09-07T15:00:00.092778+00:00', locked_reason: null },
  seven_day: { utilization: 32.0, resets_at: '2026-09-08T08:00:00.092803+00:00', locked_reason: null },
  seven_day_sonnet: null,
  seven_day_opus: null,
  extra_usage: { is_enabled: false, used_credits: null, utilization: null },
  limits: [
    { kind: 'session', group: 'session', percent: 78, resets_at: '2026-09-07T15:00:00.092778+00:00', scope: null },
    { kind: 'weekly_all', group: 'weekly', percent: 32, resets_at: '2026-09-08T08:00:00.092803+00:00', scope: null },
    WEEKLY_SCOPED,
  ],
};

// A second, distinguishable snapshot of the same body: tells which oauth read a value came from.
const LATER_BODY = {
  ...OAUTH_BODY,
  five_hour: { utilization: 88.0, resets_at: '2026-09-07T16:00:00.000000+00:00', locked_reason: null },
  seven_day: { utilization: 42.0, resets_at: '2026-09-08T08:00:00.000000+00:00', locked_reason: null },
};

function wrap(claude: unknown, scopedModel: string | null = null) {
  return parseUsagePayload({
    version: 1,
    generatedAt: T0.toISOString(),
    claude,
    codex: { ok: false, source: 'none', fiveHour: null, weekly: null, weeklySonnet: null, credits: null, fetchedAt: null },
    ext: { claudeScopedModel: scopedModel },
  });
}

type Step = { status: number; body?: unknown } | Error;

/** fetch stub: consumes one scripted response per call and records every call. */
function fakeFetch(steps: Step[]) {
  const calls: { url: string; headers: Record<string, string>; redirect?: RequestRedirect }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
    const step = steps.shift();
    if (step === undefined) throw new Error('fakeFetch: unexpected extra call');
    if (step instanceof Error) throw step;
    return new Response(step.body === undefined ? '' : JSON.stringify(step.body), { status: step.status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function statuslineFile(ageMinutes: number, now: Date = T0): string {
  const dir = mkdtempSync(join(tmpdir(), 'quotalens-oauth-'));
  const p = join(dir, 'claude.json');
  writeFileSync(p, JSON.stringify({ rate_limits: { five_hour: { used_percentage: 12, resets_at: 1788000000 } } }));
  const m = new Date(now.getTime() - ageMinutes * MIN);
  utimesSync(p, m, m);
  return p;
}

/** The source's wall clock follows the `now` of the most recent fetch (the response takes no time). */
function source(steps: Step[], opts: { statuslinePath?: string; token?: string | null } = {}) {
  const f = fakeFetch(steps);
  const clock = { now: T0 };
  const src = new ClaudeSource({
    statuslinePath: opts.statuslinePath ?? join(tmpdir(), 'quotalens-none', 'claude.json'),
    readToken: () => (opts.token === undefined ? FAKE_TOKEN : opts.token),
    fetchImpl: f.fetchImpl,
    clock: () => clock.now,
  });
  const fetch = src.fetch.bind(src);
  src.fetch = (now, o) => {
    clock.now = now;
    return fetch(now, o);
  };
  return { src, calls: f.calls };
}

// ---- schema mapping ------------------------------------------------------------

test('mapOauthUsage maps five_hour/seven_day utilization (0–100) and ISO resets_at; credits null', () => {
  const r = mapOauthUsage(OAUTH_BODY, T0);
  assert.ok(r !== null);
  const u = r.usage;
  assert.equal(u.ok, true);
  assert.equal(u.source, 'oauth_usage');
  assert.deepEqual(u.fiveHour, { usedPct: 78, resetsAt: '2026-09-07T15:00:00.092Z' });
  assert.deepEqual(u.weekly, { usedPct: 32, resetsAt: '2026-09-08T08:00:00.092Z' });
  assert.equal(u.credits, null);
  assert.equal(u.fetchedAt, T0.toISOString());
  assert.doesNotThrow(() => wrap(u, r.scopedModel));
});

// PLAN §3 weeklySonnet rule: seven_day_sonnet null → limits[].weekly_scoped (percent → usedPct,
// resets_at → resetsAt, scope.model.display_name → ext.claudeScopedModel).
test('mapOauthUsage fills weeklySonnet from limits[].weekly_scoped and reports the scoped model name', () => {
  const r = mapOauthUsage(OAUTH_BODY, T0);
  assert.ok(r !== null);
  assert.deepEqual(r.usage.weeklySonnet, { usedPct: 46, resetsAt: '2026-09-08T08:00:00.093Z' });
  assert.equal(r.scopedModel, 'Fable');
  assert.doesNotThrow(() => wrap(r.usage, r.scopedModel));
});

test('mapOauthUsage prefers seven_day_sonnet over weekly_scoped and names the model "Sonnet"', () => {
  const r = mapOauthUsage({ ...OAUTH_BODY, seven_day_sonnet: { utilization: 8.5, resets_at: null } }, T0);
  assert.ok(r !== null);
  assert.deepEqual(r.usage.weeklySonnet, { usedPct: 8.5, resetsAt: null });
  assert.equal(r.scopedModel, 'Sonnet');
  assert.doesNotThrow(() => wrap(r.usage, r.scopedModel));
});

test('mapOauthUsage: neither seven_day_sonnet nor weekly_scoped → weeklySonnet null, scopedModel null', () => {
  const r = mapOauthUsage({ ...OAUTH_BODY, limits: OAUTH_BODY.limits.slice(0, 2) }, T0);
  assert.ok(r !== null);
  assert.equal(r.usage.weeklySonnet, null);
  assert.equal(r.scopedModel, null);
  const noLimits = mapOauthUsage({ five_hour: OAUTH_BODY.five_hour, seven_day: OAUTH_BODY.seven_day }, T0);
  assert.equal(noLimits?.usage.weeklySonnet, null);
  assert.equal(noLimits?.scopedModel, null);
});

test('mapOauthUsage: weekly_scoped with non-string display_name → window kept, scopedModel null', () => {
  const scoped = { ...WEEKLY_SCOPED, scope: { model: { id: null, display_name: null }, surface: null } };
  const r = mapOauthUsage({ ...OAUTH_BODY, limits: [scoped] }, T0);
  assert.ok(r !== null);
  assert.equal(r.usage.weeklySonnet?.usedPct, 46);
  assert.equal(r.scopedModel, null);
});

test('mapOauthUsage: unusable weekly_scoped percent is skipped, first valid entry wins', () => {
  const bad = { ...WEEKLY_SCOPED, percent: 'n/a' };
  const second = { ...WEEKLY_SCOPED, percent: 12, scope: { model: { id: null, display_name: 'Opus' }, surface: null } };
  const r = mapOauthUsage({ ...OAUTH_BODY, limits: [bad, second] }, T0);
  assert.ok(r !== null);
  assert.equal(r.usage.weeklySonnet?.usedPct, 12);
  assert.equal(r.scopedModel, 'Opus');
});

test('mapOauthUsage keeps resetsAt null when the server gives none (never computed)', () => {
  const r = mapOauthUsage({ five_hour: { utilization: 5 } }, T0);
  assert.ok(r !== null);
  assert.deepEqual(r.usage.fiveHour, { usedPct: 5, resetsAt: null });
  assert.equal(r.usage.weekly, null);
});

test('mapOauthUsage returns null for bodies with no usable window', () => {
  assert.equal(mapOauthUsage({ five_hour: null, seven_day: null }, T0), null);
  assert.equal(mapOauthUsage('nope', T0), null);
  assert.equal(mapOauthUsage({ five_hour: { utilization: 'x' } }, T0), null);
});

// ---- happy path + request shape -------------------------------------------------

test('first fetch calls the endpoint with bearer + beta headers and returns oauth_usage + scopedModel', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }]);
  const r = await src.fetch(T0);
  assert.ok(r.usage !== null);
  assert.equal(r.usage.source, 'oauth_usage');
  assert.equal(r.usage.ok, true);
  assert.equal(r.usage.weeklySonnet?.usedPct, 46);
  assert.equal(r.scopedModel, 'Fable');
  assert.equal(src.state, 'FRESH');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(calls[0].headers['Authorization'], `Bearer ${FAKE_TOKEN}`);
  assert.equal(calls[0].headers['anthropic-beta'], 'oauth-2025-04-20');
});

test('never succeeded and fetch fails → usage null, scopedModel null (caller emits source:"none")', async () => {
  const { src } = source([{ status: 500 }]);
  assert.deepEqual(await src.fetch(T0), { usage: null, scopedModel: null });
  assert.equal(src.state, 'DEGRADED');
});

// ---- throttle ---------------------------------------------------------------------

// PLAN §3: `cache` means "fetch failed but succeeded before" — a throttled read is not a failure,
// so in FRESH state the last good value keeps `ok:true` and its real source label.
test('normal interval: second call within 15 min does not hit the network; FRESH → ok:true, source stays oauth_usage', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }]);
  const first = (await src.fetch(T0)).usage;
  const second = await src.fetch(at(14));
  assert.equal(calls.length, 1);
  assert.ok(first !== null && second.usage !== null);
  assert.equal(src.state, 'FRESH');
  assert.equal(second.usage.source, 'oauth_usage');
  assert.equal(second.usage.ok, true);
  assert.equal(second.usage.fetchedAt, first.fetchedAt);
  assert.deepEqual(second.usage.fiveHour, first.fiveHour);
  assert.equal(second.scopedModel, 'Fable', 'carries the last known scoped model');
  assert.doesNotThrow(() => wrap(second.usage, second.scopedModel));
});

test('DEGRADED and throttled → cache (ok:false) until the next successful read', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }, { status: 500 }, { status: 200, body: OAUTH_BODY }]);
  await src.fetch(T0);
  const failed = await src.fetch(at(15));
  assert.equal(src.state, 'DEGRADED');
  assert.equal(failed.usage?.source, 'cache');
  const throttled = await src.fetch(at(17), { refresh: true });
  assert.equal(calls.length, 2, 'inside the 5 min floor: no request');
  assert.equal(throttled.usage?.source, 'cache');
  assert.equal(throttled.usage?.ok, false);
  const back = await src.fetch(at(20));
  assert.equal(back.usage?.source, 'oauth_usage');
  assert.equal(src.state, 'FRESH');
});

test('normal interval: at 15 min the endpoint is polled again', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }, { status: 200, body: OAUTH_BODY }]);
  await src.fetch(T0);
  const r = await src.fetch(at(15));
  assert.equal(calls.length, 2);
  assert.equal(r.usage?.source, 'oauth_usage');
});

test('refresh=1 bypasses the 15 min interval but not the 5 min floor', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }, { status: 200, body: OAUTH_BODY }]);
  await src.fetch(T0);
  const early = await src.fetch(at(4), { refresh: true });
  assert.equal(calls.length, 1, 'refresh inside the 5 min floor must not call');
  assert.equal(early.usage?.source, 'oauth_usage', 'FRESH: throttled read keeps the real label');
  assert.equal(early.usage?.ok, true);
  const ok = await src.fetch(at(5), { refresh: true });
  assert.equal(calls.length, 2);
  assert.equal(ok.usage?.source, 'oauth_usage');
});

test('5 min floor applies after a failed attempt too', async () => {
  const { src, calls } = source([{ status: 500 }, { status: 200, body: OAUTH_BODY }]);
  await src.fetch(T0);
  await src.fetch(at(4));
  assert.equal(calls.length, 1);
  const r = await src.fetch(at(5));
  assert.equal(calls.length, 2);
  assert.equal(r.usage?.source, 'oauth_usage');
});

// ---- 429 ----------------------------------------------------------------------------

test('429 → BACKOFF for 15 min: zero requests (even with refresh), cache returned', async () => {
  const { src, calls } = source([
    { status: 200, body: OAUTH_BODY },
    { status: 429 },
    { status: 200, body: OAUTH_BODY },
  ]);
  const good = await src.fetch(T0);
  const hit = await src.fetch(at(15));
  assert.equal(src.state, 'BACKOFF');
  assert.equal(hit.usage?.source, 'cache');
  assert.equal(hit.usage?.fetchedAt, good.usage?.fetchedAt);
  await src.fetch(at(20), { refresh: true });
  await src.fetch(at(29));
  assert.equal(calls.length, 2, 'no requests during backoff');
  const back = await src.fetch(at(30));
  assert.equal(calls.length, 3);
  assert.equal(back.usage?.source, 'oauth_usage');
  assert.equal(src.state, 'FRESH');
});

// codex review 2026-09-08: the back-off used to start at the request's `now`; a slow 429 (9 s in
// flight) then ended 9 s early. The 15 min quiet period must start when the 429 actually arrives.
test('429 arriving 9 s after the request → back-off counts from arrival: T0+900 s blocked, T0+909 s open', async () => {
  const SEC = 1_000;
  const plus = (seconds: number) => new Date(T0.getTime() + seconds * SEC);
  const clock = { now: T0 };
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) {
      clock.now = plus(9); // the response lands 9 s after the request left
      return new Response('', { status: 429 });
    }
    return new Response(JSON.stringify(OAUTH_BODY), { status: 200 });
  }) as typeof fetch;
  const src = new ClaudeSource({
    statuslinePath: join(tmpdir(), 'quotalens-none', 'claude.json'),
    readToken: () => FAKE_TOKEN,
    fetchImpl,
    clock: () => clock.now,
  });
  assert.equal((await src.fetch(T0)).usage, null);
  assert.equal(src.state, 'BACKOFF');
  clock.now = plus(900);
  assert.equal((await src.fetch(plus(900), { refresh: true })).usage, null);
  assert.equal(calls, 1, 'T0+900 s: still inside the 15 min counted from the 429 arrival');
  clock.now = plus(909);
  assert.equal((await src.fetch(plus(909))).usage?.source, 'oauth_usage');
  assert.equal(src.state, 'FRESH');
});

test('429 with no lastGood → null', async () => {
  const { src } = source([{ status: 429 }]);
  assert.equal((await src.fetch(T0)).usage, null);
  assert.equal(src.state, 'BACKOFF');
});

// ---- 401 ----------------------------------------------------------------------------

test('401 → AUTH_LOST, ok:false with cache when lastGood exists, no refresh attempted', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }, { status: 401 }]);
  await src.fetch(T0);
  const r = await src.fetch(at(15));
  assert.equal(src.state, 'AUTH_LOST');
  assert.equal(r.usage?.ok, false);
  assert.equal(r.usage?.source, 'cache');
  assert.equal(calls.length, 2);
  for (const c of calls) assert.equal(c.url, 'https://api.anthropic.com/api/oauth/usage');
});

test('401 with no lastGood → null', async () => {
  const { src } = source([{ status: 401 }]);
  assert.equal((await src.fetch(T0)).usage, null);
  assert.equal(src.state, 'AUTH_LOST');
});

// §6 rule 1: a redirect must not carry the token past the canonical-URL check (codex QA 2026-09-08).
// Cross-origin redirects already drop Authorization; this closes the same-origin path hop too.
test('the token request refuses to follow redirects', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }]);
  await src.fetch(T0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].redirect, 'error');
});

test('missing token → AUTH_LOST without any network call', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }], { token: null });
  assert.equal((await src.fetch(T0)).usage, null);
  assert.equal(calls.length, 0);
  assert.equal(src.state, 'AUTH_LOST');
});

// ---- network / bad body ----------------------------------------------------------

test('network error → DEGRADED + cache', async () => {
  const { src } = source([{ status: 200, body: OAUTH_BODY }, new Error('ECONNRESET')]);
  const good = await src.fetch(T0);
  const r = await src.fetch(at(15));
  assert.equal(src.state, 'DEGRADED');
  assert.equal(r.usage?.source, 'cache');
  assert.deepEqual(r.usage?.weekly, good.usage?.weekly);
});

test('200 with unusable body → DEGRADED + cache', async () => {
  const { src } = source([{ status: 200, body: OAUTH_BODY }, { status: 200, body: { hello: 1 } }]);
  await src.fetch(T0);
  const r = await src.fetch(at(15));
  assert.equal(src.state, 'DEGRADED');
  assert.equal(r.usage?.source, 'cache');
});

// ---- source priority --------------------------------------------------------------

// A ≤30 min statusline owns source/fetchedAt and the 5 h + weekly windows: the oauth body is read in
// the same call (T6b.3) but only contributes weeklySonnet — its own 78 % / 32 % must not leak in.
test('statusline file ≤30 min old wins for the 5 h + weekly windows over the oauth body', async () => {
  const p = statuslineFile(29);
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }], { statuslinePath: p });
  const r = await src.fetch(T0);
  assert.equal(calls.length, 1);
  assert.equal(r.usage?.source, 'statusline');
  assert.equal(r.usage?.fetchedAt, statSync(p).mtime.toISOString());
  assert.equal(r.usage?.fiveHour?.usedPct, 12, 'statusline value, not the oauth 78');
  assert.equal(r.usage?.weekly, null, 'the statusline fixture has no seven_day; oauth 32 must not leak in');
  assert.deepEqual(r.usage?.weeklySonnet, { usedPct: 46, resetsAt: '2026-09-08T08:00:00.093Z' });
  assert.equal(r.scopedModel, 'Fable');
});

test('statusline file >30 min old falls back to oauth_usage', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }], { statuslinePath: statuslineFile(31) });
  const r = await src.fetch(T0);
  assert.equal(r.usage?.source, 'oauth_usage');
  assert.equal(calls.length, 1);
});

test('statusline source after an oauth success keeps the scoped row and its label (no flicker)', async () => {
  const p = statuslineFile(31);
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }], { statuslinePath: p });
  const oauth = await src.fetch(T0);
  assert.equal(oauth.usage?.source, 'oauth_usage');
  assert.equal(oauth.scopedModel, 'Fable');
  // statusline file becomes fresh again → statusline wins, and the scoped window + label both stick.
  const now = at(1);
  utimesSync(p, now, now);
  const sl = await src.fetch(now);
  assert.equal(calls.length, 1, 'inside the 5 min floor: the merge reuses the last oauth value');
  assert.equal(sl.usage?.source, 'statusline');
  assert.equal(sl.usage?.fetchedAt, now.toISOString());
  assert.deepEqual(sl.usage?.weeklySonnet, { usedPct: 46, resetsAt: '2026-09-08T08:00:00.093Z' });
  assert.equal(sl.scopedModel, 'Fable');
  assert.doesNotThrow(() => wrap(sl.usage, sl.scopedModel));
});

test('stale statusline + fallback failing → cache of the last fresh statusline read', async () => {
  const p = statuslineFile(0);
  // Two failing steps: T6b.3 also polls oauth while the statusline is fresh, so the fresh read at T0
  // spends one attempt before the stale read at at(31) spends the second.
  const { src, calls } = source([{ status: 500 }, { status: 500 }], { statuslinePath: p });
  const fresh = await src.fetch(T0);
  assert.equal(fresh.usage?.source, 'statusline');
  const later = await src.fetch(at(31));
  assert.equal(calls.length, 2);
  assert.equal(later.usage?.source, 'cache');
  assert.equal(later.usage?.fetchedAt, fresh.usage?.fetchedAt);
  assert.doesNotThrow(() => wrap(later.usage, later.scopedModel));
});

// ---- T6b.3: weeklySonnet is oauth-only, so a fresh statusline keeps polling for it -----------
// PLAN §3 (2026-09-10 owner ruling) + T1.3 note: the statusline carries no per-model weekly window.
// The daemon therefore polls oauth under the *same* throttle whether or not the statusline is fresh
// and merges only weeklySonnet (+ ext.claudeScopedModel) into the statusline result; `source` stays
// "statusline" and `fetchedAt` stays the statusline file's mtime.

test('fresh statusline + oauth success → source statusline, mtime fetchedAt, weeklySonnet from oauth', async () => {
  const p = statuslineFile(0);
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }], { statuslinePath: p });
  const r = await src.fetch(T0);
  assert.equal(calls.length, 1, 'the oauth endpoint is polled even though the statusline is fresh');
  assert.equal(r.usage?.source, 'statusline');
  assert.equal(r.usage?.ok, true);
  assert.equal(r.usage?.fetchedAt, statSync(p).mtime.toISOString(), 'fetchedAt = statusline mtime');
  assert.deepEqual(r.usage?.fiveHour, { usedPct: 12, resetsAt: new Date(1788000000 * 1000).toISOString() });
  assert.deepEqual(r.usage?.weeklySonnet, { usedPct: 46, resetsAt: '2026-09-08T08:00:00.093Z' });
  assert.equal(r.scopedModel, 'Fable');
  assert.doesNotThrow(() => wrap(r.usage, r.scopedModel));
});

test('fresh statusline + oauth inside the throttle → no request, weeklySonnet carried over', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }], { statuslinePath: statuslineFile(0) });
  await src.fetch(T0);
  assert.equal(calls.length, 1);
  const again = await src.fetch(at(4));
  assert.equal(calls.length, 1, 'inside the 5 min floor / 15 min cadence: zero further requests');
  assert.equal(again.usage?.source, 'statusline');
  assert.equal(again.usage?.ok, true);
  assert.deepEqual(again.usage?.weeklySonnet, { usedPct: 46, resetsAt: '2026-09-08T08:00:00.093Z' });
  assert.equal(again.scopedModel, 'Fable');
});

test('fresh statusline + oauth 429 → ok:true / statusline / weeklySonnet carried over / 15 min quiet', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }, { status: 429 }], {
    statuslinePath: statuslineFile(0),
  });
  await src.fetch(T0);
  const hit = await src.fetch(at(15));
  assert.equal(calls.length, 2);
  assert.equal(src.state, 'BACKOFF');
  assert.equal(hit.usage?.ok, true, 'the statusline read did not fail, so the tool is still ok');
  assert.equal(hit.usage?.source, 'statusline');
  assert.deepEqual(hit.usage?.weeklySonnet, { usedPct: 46, resetsAt: '2026-09-08T08:00:00.093Z' });
  assert.equal(hit.scopedModel, 'Fable');
  await src.fetch(at(20), { refresh: true });
  await src.fetch(at(29));
  assert.equal(calls.length, 2, 'no request during the 15 min back-off, not even with refresh');
  assert.doesNotThrow(() => wrap(hit.usage, hit.scopedModel));
});

test('fresh statusline + oauth never succeeded → weeklySonnet null (the row stays hidden, S9)', async () => {
  const { src, calls } = source([{ status: 500 }], { statuslinePath: statuslineFile(0) });
  const r = await src.fetch(T0);
  assert.equal(calls.length, 1);
  assert.equal(r.usage?.source, 'statusline');
  assert.equal(r.usage?.ok, true);
  assert.equal(r.usage?.weeklySonnet, null);
  assert.equal(r.scopedModel, null);
  assert.doesNotThrow(() => wrap(r.usage, r.scopedModel));
});

// codex review 2026-09-10: the fresh-statusline branch stored its merged result as the single
// lastGood, overwriting the newer oauth snapshot taken in the very same call. Once the statusline
// went stale while oauth was still throttled, the daemon served the OLD statusline numbers.
// The two snapshots are kept apart now; the newer `fetchedAt` wins (§3 source/ok rules unchanged).
test('statusline stops updating: the newer oauth snapshot is served once the statusline goes stale', async () => {
  const p = statuslineFile(0); // mtime = T0, five_hour 12 %
  const { src, calls } = source(
    [{ status: 200, body: OAUTH_BODY }, { status: 200, body: LATER_BODY }, { status: 200, body: LATER_BODY }],
    { statuslinePath: p },
  );

  // minute 0: the statusline is fresh and owns source/fetchedAt; oauth succeeds behind it.
  const m0 = await src.fetch(T0);
  assert.equal(calls.length, 1);
  assert.equal(m0.usage?.source, 'statusline');
  assert.equal(m0.usage?.fiveHour?.usedPct, 12);

  // minute 30: the file has not moved (age exactly 30 min → still fresh); oauth is due again.
  const m30 = await src.fetch(at(30));
  assert.equal(calls.length, 2);
  assert.equal(m30.usage?.source, 'statusline', 'a fresh statusline still owns source/fetchedAt');
  assert.equal(m30.usage?.fiveHour?.usedPct, 12);

  // minute 31: the statusline is stale (31 min) and oauth is throttled until minute 45.
  const m31 = await src.fetch(at(31));
  assert.equal(calls.length, 2, 'inside the 15 min cadence: no request leaves');
  assert.equal(src.state, 'FRESH');
  assert.equal(m31.usage?.source, 'oauth_usage', 'the minute-30 oauth read is newer than the minute-0 statusline');
  assert.equal(m31.usage?.ok, true, 'throttled ≠ failed (§3)');
  assert.equal(m31.usage?.fiveHour?.usedPct, 88);
  assert.equal(m31.usage?.weekly?.usedPct, 42);
  assert.equal(m31.usage?.fetchedAt, at(30).toISOString());
  assert.equal(m31.scopedModel, 'Fable');
  assert.doesNotThrow(() => wrap(m31.usage, m31.scopedModel));

  // minute 44: still throttled, still the oauth snapshot.
  const m44 = await src.fetch(at(44));
  assert.equal(calls.length, 2);
  assert.equal(m44.usage?.source, 'oauth_usage');
  assert.equal(m44.usage?.fiveHour?.usedPct, 88);

  // minute 45: the normal cadence opens again.
  const m45 = await src.fetch(at(45));
  assert.equal(calls.length, 3);
  assert.equal(m45.usage?.source, 'oauth_usage');
  assert.equal(m45.usage?.fetchedAt, at(45).toISOString());
});

// Same split, non-FRESH state: §3 re-labels the served snapshot as cache — and it must be the
// newer (oauth) one, not the stale statusline the old single lastGood had overwritten it with.
test('stale statusline + oauth 429 → cache label on the newer oauth snapshot', async () => {
  const p = statuslineFile(0); // mtime = T0
  const { src, calls } = source(
    [{ status: 200, body: OAUTH_BODY }, { status: 200, body: LATER_BODY }, { status: 429 }],
    { statuslinePath: p },
  );
  await src.fetch(T0); // fresh statusline + oauth success at minute 0
  const m20 = await src.fetch(at(20)); // statusline age 20 min → still fresh; oauth success at minute 20
  assert.equal(calls.length, 2);
  assert.equal(m20.usage?.source, 'statusline');

  const m36 = await src.fetch(at(36)); // statusline age 36 min → stale; oauth answers 429
  assert.equal(calls.length, 3);
  assert.equal(src.state, 'BACKOFF');
  assert.equal(m36.usage?.source, 'cache');
  assert.equal(m36.usage?.ok, false);
  assert.equal(m36.usage?.fiveHour?.usedPct, 88, 'the minute-20 oauth values, not the minute-0 statusline 12 %');
  assert.equal(m36.usage?.fetchedAt, at(20).toISOString());
  assert.doesNotThrow(() => wrap(m36.usage, m36.scopedModel));
});

test('fresh statusline + refresh=1 twice inside 5 min → only one oauth request (hard floor)', async () => {
  const { src, calls } = source([{ status: 200, body: OAUTH_BODY }, { status: 200, body: OAUTH_BODY }], {
    statuslinePath: statuslineFile(0),
  });
  await src.fetch(T0, { refresh: true });
  assert.equal(calls.length, 1);
  const early = await src.fetch(at(4), { refresh: true });
  assert.equal(calls.length, 1, 'refresh inside the 5 min floor must not call');
  assert.equal(early.usage?.source, 'statusline');
  const later = await src.fetch(at(5), { refresh: true });
  assert.equal(calls.length, 2, 'at the floor refresh gets through');
  assert.equal(later.usage?.source, 'statusline');
  assert.deepEqual(later.usage?.weeklySonnet, { usedPct: 46, resetsAt: '2026-09-08T08:00:00.093Z' });
});
