// Aggregator (PLAN §10.2): merges both sources into a UsagePayload and applies the daemon's own
// `?refresh=1` throttle (PLAN §3: at most one real upstream refresh per 60 s).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXT_CLAUDE_SCOPED_MODEL, parseUsagePayload, type ToolUsage } from '@quotalens/shared';
import { Aggregator, type AggregatorDeps } from './aggregator.ts';

const T0 = new Date('2026-09-08T00:00:00.000Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

const CLAUDE: ToolUsage = {
  ok: true,
  source: 'statusline',
  fiveHour: { usedPct: 63, resetsAt: '2026-09-08T04:20:00.000Z' },
  weekly: { usedPct: 28, resetsAt: null },
  weeklySonnet: null,
  credits: null,
  fetchedAt: '2026-09-07T23:59:00.000Z',
};
const CODEX: ToolUsage = {
  ok: true,
  source: 'app_server',
  fiveHour: null,
  weekly: { usedPct: 64, resetsAt: '2026-09-14T08:00:00.000Z' },
  weeklySonnet: null,
  credits: null,
  fetchedAt: '2026-09-07T23:58:00.000Z',
};

function fakes(claude: ToolUsage | null, codex: ToolUsage | null, scopedModel: string | null = null) {
  const claudeRefresh: boolean[] = [];
  const codexRefresh: boolean[] = [];
  const deps: AggregatorDeps = {
    claude: async (_now, opts) => {
      claudeRefresh.push(opts.refresh === true);
      return { usage: claude, scopedModel };
    },
    codex: async (_now, opts) => {
      codexRefresh.push(opts.refresh === true);
      return codex;
    },
  };
  return { deps, claudeRefresh, codexRefresh };
}

test('both sources present → payload validates, values and ext pass through, generatedAt = now', async () => {
  const f = fakes(CLAUDE, CODEX, 'Fable');
  const p = await new Aggregator(f.deps).buildPayload(T0);
  assert.doesNotThrow(() => parseUsagePayload(p));
  assert.equal(p.generatedAt, T0.toISOString());
  assert.deepEqual(p.claude, CLAUDE);
  assert.deepEqual(p.codex, CODEX);
  assert.equal(p.ext[EXT_CLAUDE_SCOPED_MODEL], 'Fable');
});

test('a source returning null → that tool is source:"none" with every field null (PLAN §3 cold start)', async () => {
  const f = fakes(null, CODEX);
  const p = await new Aggregator(f.deps).buildPayload(T0);
  assert.doesNotThrow(() => parseUsagePayload(p));
  assert.deepEqual(p.claude, {
    ok: false,
    source: 'none',
    fiveHour: null,
    weekly: null,
    weeklySonnet: null,
    credits: null,
    fetchedAt: null,
  });
  assert.equal(p.codex.source, 'app_server');
  assert.equal(p.ext[EXT_CLAUDE_SCOPED_MODEL], null, 'key present with null, never omitted');

  const both = await new Aggregator(fakes(null, null).deps).buildPayload(T0);
  assert.doesNotThrow(() => parseUsagePayload(both));
  assert.equal(both.claude.source, 'none');
  assert.equal(both.codex.source, 'none');
});

test('plain request never forwards refresh', async () => {
  const f = fakes(CLAUDE, CODEX);
  const agg = new Aggregator(f.deps);
  await agg.buildPayload(T0);
  await agg.buildPayload(at(1), {});
  await agg.buildPayload(at(2), { refresh: false });
  assert.deepEqual(f.claudeRefresh, [false, false, false]);
  assert.deepEqual(f.codexRefresh, [false, false, false]);
});

test('?refresh=1 is forwarded at most once per 60 s: 0 s → true, 30 s → false, 60 s → true', async () => {
  const f = fakes(CLAUDE, CODEX);
  const agg = new Aggregator(f.deps);
  await agg.buildPayload(at(0), { refresh: true });
  await agg.buildPayload(at(30), { refresh: true });
  await agg.buildPayload(at(59.9), { refresh: true });
  await agg.buildPayload(at(60), { refresh: true });
  assert.deepEqual(f.claudeRefresh, [true, false, false, true]);
  assert.deepEqual(f.codexRefresh, [true, false, false, true]);
});

test('a throttled refresh is an ordinary request: sources are still called (current value), just without refresh', async () => {
  const f = fakes(CLAUDE, CODEX);
  const agg = new Aggregator(f.deps);
  await agg.buildPayload(at(0), { refresh: true });
  const p = await agg.buildPayload(at(10), { refresh: true });
  assert.equal(f.claudeRefresh.length, 2);
  assert.equal(p.claude.ok, true);
});

test('plain requests in between do not reset the refresh window', async () => {
  const f = fakes(CLAUDE, CODEX);
  const agg = new Aggregator(f.deps);
  await agg.buildPayload(at(0), { refresh: true });
  await agg.buildPayload(at(45));
  await agg.buildPayload(at(50), { refresh: true }); // 50 s after the last real refresh → throttled
  await agg.buildPayload(at(61), { refresh: true }); // 61 s → allowed
  assert.deepEqual(f.claudeRefresh, [true, false, false, true]);
});

test('sources are invoked concurrently with the same `now`', async () => {
  let claudeStarted = false;
  let codexStarted = false;
  const seen: Date[] = [];
  const deps: AggregatorDeps = {
    claude: async (now) => {
      seen.push(now);
      claudeStarted = true;
      await new Promise((r) => setTimeout(r, 5));
      assert.equal(codexStarted, true, 'codex started while claude was still pending');
      return { usage: CLAUDE, scopedModel: null };
    },
    codex: async (now) => {
      seen.push(now);
      codexStarted = true;
      assert.equal(claudeStarted, true);
      return CODEX;
    },
  };
  await new Aggregator(deps).buildPayload(T0);
  assert.deepEqual(seen, [T0, T0]);
});
