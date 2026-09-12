import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXT_CLAUDE_SCOPED_MODEL,
  parseUsagePayload,
  staleThresholdMin,
  UPSTREAM_INTERVAL_MIN,
} from './schema.ts';

// Mirrors PLAN.md §3 example payload.
function validPayload(): Record<string, unknown> {
  return {
    version: 1,
    generatedAt: '2026-09-07T12:04:00+10:00',
    claude: {
      ok: true,
      source: 'statusline',
      fiveHour: { usedPct: 63, resetsAt: '2026-09-07T14:20:00+10:00' },
      weekly: { usedPct: 28, resetsAt: '2026-09-10T09:00:00+10:00' },
      weeklySonnet: { usedPct: 8, resetsAt: '2026-09-10T09:00:00+10:00' },
      credits: null,
      fetchedAt: '2026-09-07T12:03:41+10:00',
    },
    codex: {
      ok: true,
      source: 'app_server',
      fiveHour: { usedPct: 18, resetsAt: '2026-09-07T16:45:00+10:00' },
      weekly: { usedPct: 64, resetsAt: '2026-09-14T08:00:00+10:00' },
      weeklySonnet: null,
      credits: { remainingUsd: 4.2 },
      fetchedAt: '2026-09-07T11:55:12+10:00',
    },
    ext: {},
  };
}

test('valid §3 payload passes', () => {
  const p = parseUsagePayload(validPayload());
  assert.equal(p.version, 1);
  assert.equal(p.claude.fiveHour?.usedPct, 63);
  assert.equal(p.codex.credits?.remainingUsd, 4.2);
});

test('version 2 is rejected', () => {
  const x = validPayload();
  x.version = 2;
  assert.throws(() => parseUsagePayload(x), /version/);
});

test('invalid source literal is rejected with a path', () => {
  const x = validPayload();
  (x.claude as Record<string, unknown>).source = 'magic';
  assert.throws(() => parseUsagePayload(x), /claude\.source/);
});

test('source "none" with all-null windows and fetchedAt passes', () => {
  const x = validPayload();
  x.codex = {
    ok: false,
    source: 'none',
    fiveHour: null,
    weekly: null,
    weeklySonnet: null,
    credits: null,
    fetchedAt: null,
  };
  const p = parseUsagePayload(x);
  assert.equal(p.codex.source, 'none');
  assert.equal(p.codex.fetchedAt, null);
});

test('missing fetchedAt is rejected', () => {
  const x = validPayload();
  delete (x.claude as Record<string, unknown>).fetchedAt;
  assert.throws(() => parseUsagePayload(x), /claude\.fetchedAt/);
});

test('unknown ext keys are accepted', () => {
  const x = validPayload();
  x.ext = { tokenStats: { anything: [1, 2, 3] }, futureFlag: true };
  const p = parseUsagePayload(x);
  assert.equal(p.ext.futureFlag, true);
});

// ---- PLAN §3 ext.claudeScopedModel (the only defined v1 ext key) ---------------

test('EXT_CLAUDE_SCOPED_MODEL names the §3 ext key', () => {
  assert.equal(EXT_CLAUDE_SCOPED_MODEL, 'claudeScopedModel');
});

test('ext.claudeScopedModel string passes and is kept', () => {
  const x = validPayload();
  x.ext = { [EXT_CLAUDE_SCOPED_MODEL]: 'Fable' };
  assert.equal(parseUsagePayload(x).ext[EXT_CLAUDE_SCOPED_MODEL], 'Fable');
});

test('ext.claudeScopedModel null passes', () => {
  const x = validPayload();
  x.ext = { [EXT_CLAUDE_SCOPED_MODEL]: null };
  assert.equal(parseUsagePayload(x).ext[EXT_CLAUDE_SCOPED_MODEL], null);
});

test('ext.claudeScopedModel absent passes (other ext keys untouched)', () => {
  const x = validPayload();
  x.ext = { futureFlag: true };
  const p = parseUsagePayload(x);
  assert.equal(EXT_CLAUDE_SCOPED_MODEL in p.ext, false);
  assert.equal(p.ext.futureFlag, true);
});

test('ext.claudeScopedModel non-string is rejected with a path', () => {
  for (const bad of [42, true, {}, '']) {
    const x = validPayload();
    x.ext = { [EXT_CLAUDE_SCOPED_MODEL]: bad };
    assert.throws(() => parseUsagePayload(x), /\$\.ext\.claudeScopedModel/);
  }
});

test('non-object input is rejected', () => {
  assert.throws(() => parseUsagePayload(null), /\$/);
  assert.throws(() => parseUsagePayload('{}'), /\$/);
});

// ---- PLAN §3 source/ok consistency rules -----------------------------------

function withClaude(patch: Record<string, unknown>): Record<string, unknown> {
  const x = validPayload();
  x.claude = { ...(x.claude as Record<string, unknown>), ...patch };
  return x;
}

function withCodex(patch: Record<string, unknown>): Record<string, unknown> {
  const x = validPayload();
  x.codex = { ...(x.codex as Record<string, unknown>), ...patch };
  return x;
}

const NONE_USAGE = {
  ok: false,
  source: 'none',
  fiveHour: null,
  weekly: null,
  weeklySonnet: null,
  credits: null,
  fetchedAt: null,
};

test('source "none" with ok:true is rejected', () => {
  const x = withClaude({ ...NONE_USAGE, ok: true });
  assert.throws(() => parseUsagePayload(x), /claude\.ok/);
});

test('source "none" with a non-null window is rejected', () => {
  const x = withClaude({ ...NONE_USAGE, weekly: { usedPct: 1, resetsAt: '2026-09-10T09:00:00+10:00' } });
  assert.throws(() => parseUsagePayload(x), /claude\.weekly/);
});

test('source "none" with non-null fetchedAt is rejected', () => {
  const x = withClaude({ ...NONE_USAGE, fetchedAt: '2026-09-07T12:03:41+10:00' });
  assert.throws(() => parseUsagePayload(x), /claude\.fetchedAt/);
});

test('source "none" with non-null credits is rejected', () => {
  const x = withCodex({ ...NONE_USAGE, credits: { remainingUsd: 1 } });
  assert.throws(() => parseUsagePayload(x), /codex\.credits/);
});

test('real source with ok:false is rejected', () => {
  const x = withClaude({ ok: false });
  assert.throws(() => parseUsagePayload(x), /claude\.ok/);
});

test('real source with fetchedAt:null is rejected', () => {
  const x = withClaude({ fetchedAt: null });
  assert.throws(() => parseUsagePayload(x), /claude\.fetchedAt/);
});

test('source "cache" with ok:true is rejected', () => {
  const x = withCodex({ source: 'cache', ok: true });
  assert.throws(() => parseUsagePayload(x), /codex\.ok/);
});

test('source "cache" with fetchedAt:null is rejected', () => {
  const x = withCodex({ source: 'cache', ok: false, fetchedAt: null });
  assert.throws(() => parseUsagePayload(x), /codex\.fetchedAt/);
});

test('source "cache" with ok:false and lastGood values passes', () => {
  const x = withCodex({ source: 'cache', ok: false });
  const p = parseUsagePayload(x);
  assert.equal(p.codex.source, 'cache');
  assert.equal(p.codex.ok, false);
  assert.equal(p.codex.fiveHour?.usedPct, 18);
  assert.equal(p.codex.fetchedAt, '2026-09-07T11:55:12+10:00');
});

test('unparseable fetchedAt is rejected', () => {
  const x = withClaude({ fetchedAt: 'garbage' });
  assert.throws(() => parseUsagePayload(x), /claude\.fetchedAt/);
});

test('unparseable generatedAt is rejected', () => {
  const x = validPayload();
  x.generatedAt = 'not-a-date';
  assert.throws(() => parseUsagePayload(x), /generatedAt/);
});

test('unparseable resetsAt is rejected', () => {
  const x = withClaude({ fiveHour: { usedPct: 63, resetsAt: 'yesterday' } });
  assert.throws(() => parseUsagePayload(x), /claude\.fiveHour\.resetsAt/);
});

// §3 / §7 V4 / §10.2: resetsAt may be null (server gave none); the window itself is kept.
test('resetsAt:null passes and keeps the window', () => {
  const x = withClaude({ fiveHour: { usedPct: 63, resetsAt: null } });
  const p = parseUsagePayload(x);
  assert.equal(p.claude.fiveHour?.usedPct, 63);
  assert.equal(p.claude.fiveHour?.resetsAt, null);
});

test('resetsAt missing (undefined) is rejected', () => {
  const x = withClaude({ fiveHour: { usedPct: 63 } });
  assert.throws(() => parseUsagePayload(x), /claude\.fiveHour\.resetsAt/);
});

test('claude with codex-only source is rejected', () => {
  const x = withClaude({ source: 'app_server' });
  assert.throws(() => parseUsagePayload(x), /claude\.source/);
});

test('codex with claude-only source is rejected', () => {
  const x = withCodex({ source: 'statusline' });
  assert.throws(() => parseUsagePayload(x), /codex\.source/);
});

test('claude oauth_usage and codex backend_api pass', () => {
  const x = withClaude({ source: 'oauth_usage' });
  x.codex = { ...(x.codex as Record<string, unknown>), source: 'backend_api' };
  const p = parseUsagePayload(x);
  assert.equal(p.claude.source, 'oauth_usage');
  assert.equal(p.codex.source, 'backend_api');
});

test('upstream interval constants match PLAN §3', () => {
  assert.equal(UPSTREAM_INTERVAL_MIN.claude, 15);
  assert.equal(UPSTREAM_INTERVAL_MIN.codex, 5);
});

// PLAN §3 table: poll 3 → 20/10, poll 5 → 20/10, poll 10 → 20/20.
test('staleness thresholds match PLAN §3 table', () => {
  assert.equal(staleThresholdMin('claude', 3), 20);
  assert.equal(staleThresholdMin('codex', 3), 10);
  assert.equal(staleThresholdMin('claude', 5), 20);
  assert.equal(staleThresholdMin('codex', 5), 10);
  assert.equal(staleThresholdMin('claude', 10), 20);
  assert.equal(staleThresholdMin('codex', 10), 20);
});
