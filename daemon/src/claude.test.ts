import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUsagePayload } from '@quotalens/shared';
import { readStatuslineUsage } from './claude.ts';

// Shape per https://code.claude.com/docs/en/statusline (2026-09-07):
// used_percentage 0–100 (may be fractional), resets_at = Unix epoch seconds.
const SAMPLE = {
  session_id: 'test',
  rate_limits: {
    five_hour: { used_percentage: 23.5, resets_at: 1738425600 },
    seven_day: { used_percentage: 41.2, resets_at: 1738857600 },
  },
};

function tmpFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'quotalens-claude-'));
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

function wrap(claude: unknown) {
  return parseUsagePayload({
    version: 1,
    generatedAt: new Date().toISOString(),
    claude,
    codex: { ok: false, source: 'none', fiveHour: null, weekly: null, weeklySonnet: null, credits: null, fetchedAt: null },
    ext: {},
  });
}

test('valid file maps five_hour/seven_day to fiveHour/weekly with ISO resetsAt and mtime fetchedAt', () => {
  const p = tmpFile('claude.json', JSON.stringify(SAMPLE));
  const fixed = new Date('2026-09-07T10:00:00Z');
  utimesSync(p, fixed, fixed);
  const u = readStatuslineUsage(p);
  assert.ok(u !== null);
  assert.equal(u.ok, true);
  assert.equal(u.source, 'statusline');
  assert.deepEqual(u.fiveHour, { usedPct: 23.5, resetsAt: '2025-02-01T16:00:00.000Z' });
  assert.deepEqual(u.weekly, { usedPct: 41.2, resetsAt: '2025-02-06T16:00:00.000Z' });
  // The reader itself never has a per-model window; ClaudeSource.fetch() merges the last oauth
  // value into weeklySonnet (T6b.3) — see claude-oauth.test.ts for that half.
  assert.equal(u.weeklySonnet, null);
  assert.equal(u.credits, null);
  assert.equal(u.fetchedAt, statSync(p).mtime.toISOString());
  assert.equal(u.fetchedAt, fixed.toISOString());
  assert.doesNotThrow(() => wrap(u));
});

test('wrapper-written {rate_limits} subset (no other stdin keys) parses identically', () => {
  const p = tmpFile('claude.json', JSON.stringify({ rate_limits: SAMPLE.rate_limits }));
  const u = readStatuslineUsage(p);
  assert.ok(u !== null);
  assert.equal(u.source, 'statusline');
  assert.deepEqual(u.fiveHour, { usedPct: 23.5, resetsAt: '2025-02-01T16:00:00.000Z' });
  assert.deepEqual(u.weekly, { usedPct: 41.2, resetsAt: '2025-02-06T16:00:00.000Z' });
  assert.doesNotThrow(() => wrap(u));
});

test('missing file returns null', () => {
  assert.equal(readStatuslineUsage(join(tmpdir(), 'quotalens-does-not-exist', 'claude.json')), null);
});

test('malformed JSON returns null', () => {
  const p = tmpFile('claude.json', '{not json');
  assert.equal(readStatuslineUsage(p), null);
});

test('missing seven_day gives weekly null while fiveHour is kept', () => {
  const p = tmpFile('claude.json', JSON.stringify({ rate_limits: { five_hour: SAMPLE.rate_limits.five_hour } }));
  const u = readStatuslineUsage(p);
  assert.ok(u !== null);
  assert.equal(u.weekly, null);
  assert.deepEqual(u.fiveHour, { usedPct: 23.5, resetsAt: '2025-02-01T16:00:00.000Z' });
  assert.doesNotThrow(() => wrap(u));
});

test('missing resets_at gives resetsAt null (never computed locally)', () => {
  const p = tmpFile('claude.json', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5 } } }));
  const u = readStatuslineUsage(p);
  assert.ok(u !== null);
  assert.deepEqual(u.fiveHour, { usedPct: 5, resetsAt: null });
});

// codex review 2026-09-08: out-of-range epoch made toISOString() throw and bypassed every fallback.
test('out-of-range resets_at (1e20) gives resetsAt null instead of throwing', () => {
  const p = tmpFile('claude.json', JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 1e20 } } }));
  const u = readStatuslineUsage(p);
  assert.ok(u !== null);
  assert.deepEqual(u.fiveHour, { usedPct: 5, resetsAt: null });
});

test('file without rate_limits at all returns null (nothing usable)', () => {
  const p = tmpFile('claude.json', JSON.stringify({ session_id: 'x', context_window: {} }));
  assert.equal(readStatuslineUsage(p), null);
});
