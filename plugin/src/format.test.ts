// Fixed +10:00 zone so the §7 fixture timestamps (all `+10:00`) render as the spec writes them,
// on any machine. Must run before the first Date is constructed in this process.
process.env.TZ = 'Australia/Brisbane';

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { staleThresholdMin } from '@quotalens/shared';
import { BAR_CELLS, BAR_EMPTY, BAR_FILLED, Formatter, STALE_WIDEST_LABELS } from './format.ts';

/**
 * PLAN T3.2: `filled = Math.round(usedPct * 12 / 100)`, then clamp so 0% and 100% stay the only
 * all-empty / all-full readings. Comparing a hardcoded screen against a hardcoded sample is
 * vacuous — this table is the only thing that can catch a Formatter bug.
 */
const BAR_TABLE: { pct: number; filled: number }[] = [
  { pct: 0, filled: 0 }, // round 0 → 0; no clamp, 0% must read empty
  { pct: 1, filled: 1 }, // round 0.12 → 0, clamped up: >0% must never read empty
  { pct: 4, filled: 1 }, // round 0.48 → 0, clamped up
  { pct: 8, filled: 1 }, // round 0.96 → 1
  { pct: 50, filled: 6 }, // round 6 → 6
  { pct: 63, filled: 8 }, // round 7.56 → 8
  { pct: 96, filled: 11 }, // round 11.52 → 12, clamped down: <100% must never read full
  { pct: 99, filled: 11 }, // round 11.88 → 12, clamped down
  { pct: 100, filled: 12 }, // round 12 → 12; no clamp
];

for (const { pct, filled } of BAR_TABLE) {
  test(`Formatter.bar(${pct}) has ${filled} filled cells`, () => {
    const bar = Formatter.bar(pct);
    const filledCount = [...bar].filter((c) => c === BAR_FILLED).length;
    const emptyCount = [...bar].filter((c) => c === BAR_EMPTY).length;
    assert.equal(filledCount, filled);
    assert.equal(filledCount + emptyCount, BAR_CELLS);
    assert.equal(bar, BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_CELLS - filled));
  });
}

test('Formatter.bar clamps out-of-range percentages instead of drawing a wrong-length bar', () => {
  // The server owns usedPct; over-quota (>100) and nonsense values must still yield 12 cells.
  for (const pct of [-5, 100.4, 137, Number.NaN]) {
    const bar = Formatter.bar(pct);
    assert.equal([...bar].length, BAR_CELLS, `pct=${pct}`);
  }
  assert.equal(Formatter.bar(137), BAR_FILLED.repeat(BAR_CELLS));
  assert.equal(Formatter.bar(-5), BAR_EMPTY.repeat(BAR_CELLS));
});

test('Formatter.pctLabel rounds to a whole percent (statusline sends decimals)', () => {
  assert.equal(Formatter.pctLabel(63), '63%');
  assert.equal(Formatter.pctLabel(62.6), '63%');
  assert.equal(Formatter.pctLabel(8.2), '8%');
});

test('Formatter.clockLabel truncates to the minute and never rounds up', () => {
  // §7 V6: rounding 12:03:41 up to 12:04 would show a future timestamp and disagree with `stale Xm`.
  assert.equal(Formatter.clockLabel('2026-09-07T12:03:41+10:00'), '12:03');
  assert.equal(Formatter.clockLabel('2026-09-07T11:41:00+10:00'), '11:41');
  assert.equal(Formatter.clockLabel('2026-09-07T09:00:59+10:00'), '09:00');
});

test('Formatter.clockLabel renders --:-- when the tool never fetched (§7 V1)', () => {
  assert.equal(Formatter.clockLabel(null), '--:--');
});

test('Formatter.resetLabel omits the weekday on the current day (§7 frame A)', () => {
  const now = new Date('2026-09-07T12:04:00+10:00');
  assert.equal(Formatter.resetLabel('2026-09-07T14:20:00+10:00', now), 'resets 14:20');
});

test('Formatter.resetLabel prefixes the weekday on any other day', () => {
  const now = new Date('2026-09-07T12:04:00+10:00');
  assert.equal(Formatter.resetLabel('2026-09-10T09:00:00+10:00', now), 'resets Thu 09:00');
  assert.equal(Formatter.resetLabel('2026-09-14T08:00:00+10:00', now), 'resets Mon 08:00');
});

test('Formatter.resetLabel returns an empty suffix when the server sent no reset (§7 V4)', () => {
  // V4 keeps the percentage and the bar and drops only the suffix — so the label must be empty,
  // not a placeholder, and never a locally computed guess (§6 rule 6).
  const now = new Date('2026-09-07T12:04:00+10:00');
  assert.equal(Formatter.resetLabel(null, now), '');
  assert.equal(Formatter.resetLabel('not-a-date', now), '');
});

test('Formatter.staleLabel says ok up to the threshold and stale past it (§3)', () => {
  const now = new Date('2026-09-07T12:04:00+10:00');
  const pollMin = 5;
  const claudeThreshold = staleThresholdMin('claude', pollMin); // max(2*5, 15+5) = 20
  assert.equal(claudeThreshold, 20);

  const at = (minutesAgo: number) =>
    new Date(now.getTime() - minutesAgo * 60_000).toISOString();

  assert.equal(Formatter.staleLabel('claude', at(claudeThreshold), now, pollMin), 'ok');
  assert.equal(
    Formatter.staleLabel('claude', at(claudeThreshold + 1), now, pollMin),
    `stale ${claudeThreshold + 1}m`,
  );
});

test('Formatter.staleLabel uses the per-tool threshold, not one shared constant (§3)', () => {
  const now = new Date('2026-09-07T12:04:00+10:00');
  const pollMin = 5;
  const codexThreshold = staleThresholdMin('codex', pollMin); // max(2*5, 5+5) = 10
  assert.equal(codexThreshold, 10);

  // The §7 frame B fixture: fetchedAt 11:41, now 12:04 → 23m, past Codex's 10m threshold.
  assert.equal(Formatter.staleLabel('codex', '2026-09-07T11:41:00+10:00', now, pollMin), 'stale 23m');
  // A 15m age sits between the two thresholds: stale for Codex, still `ok` for Claude, whose
  // upstream only moves every 15 min.
  assert.equal(Formatter.staleLabel('codex', '2026-09-07T11:49:00+10:00', now, pollMin), 'stale 15m');
  assert.equal(Formatter.staleLabel('claude', '2026-09-07T11:49:00+10:00', now, pollMin), 'ok');
});

test('Formatter.staleLabel floors the age instead of rounding it', () => {
  const now = new Date('2026-09-07T12:04:00+10:00');
  // 23m 59s must read `stale 23m`, matching the floor used by the header clock.
  assert.equal(Formatter.staleLabel('codex', '2026-09-07T11:40:01+10:00', now, 5), 'stale 23m');
});

test('Formatter.staleLabel compares the raw age, not the floored minutes (§3)', () => {
  const pollMin = 5;
  const thresholdMin = staleThresholdMin('claude', pollMin); // max(2*5, 15+5) = 20
  assert.equal(thresholdMin, 20);
  const fetchedAt = '2026-09-07T12:00:00+10:00';
  const at = (ms: number) => new Date(Date.parse(fetchedAt) + ms);

  // §3: `staleAge ≤ staleThreshold` → ok. Exactly on the threshold is still ok.
  assert.equal(Formatter.staleLabel('claude', fetchedAt, at(thresholdMin * 60_000), pollMin), 'ok');
  // One millisecond past it is not. Flooring before the comparison hid this whole 59.999s band —
  // `Math.floor(20m + 1ms)` is 20, which compares equal to the threshold and read `ok`.
  assert.equal(
    Formatter.staleLabel('claude', fetchedAt, at(thresholdMin * 60_000 + 1), pollMin),
    'stale 20m',
  );
  assert.equal(
    Formatter.staleLabel('claude', fetchedAt, at(thresholdMin * 60_000 + 59_999), pollMin),
    'stale 20m',
  );
});

/**
 * The footer column's x is fixed at mount time, so the `stale …` number has to be bounded or it
 * eventually wraps a 27px-tall container and gets clipped. One overnight with the daemon down
 * reaches four digits, which is well inside normal use.
 */
const STALE_MAGNITUDE_TABLE: { ageMin: number; expect: string }[] = [
  { ageMin: 21, expect: 'stale 21m' },
  { ageMin: 999, expect: 'stale 999m' }, // last minute-denominated reading
  { ageMin: 1000, expect: 'stale 16h' }, // 16h40m — the case that used to overflow the column
  { ageMin: 1440, expect: 'stale 24h' }, // one day offline
  { ageMin: 59_940, expect: 'stale 999h' }, // 999h exactly — last hour-denominated reading
  { ageMin: 60_000, expect: 'stale 999h+' }, // saturated; the figure has no reader by now
];

for (const { ageMin, expect } of STALE_MAGNITUDE_TABLE) {
  test(`Formatter.staleLabel at ${ageMin} minutes reads "${expect}"`, () => {
    const fetchedAt = '2026-09-07T12:00:00+10:00';
    const now = new Date(Date.parse(fetchedAt) + ageMin * 60_000);
    assert.equal(Formatter.staleLabel('claude', fetchedAt, now, 5), expect);
  });
}

test('every stale reading fits the width reserved from STALE_WIDEST_LABELS', () => {
  const reserved = Formatter.widestWidth(STALE_WIDEST_LABELS);
  // Exhaustive, not a sample: the label is bounded to 0–999 minutes, 0–999 hours and one saturated
  // string, so every reachable rendering can be checked. Sampling would miss the one digit run
  // that happens to kern wide — which is precisely how the first attempt at this reservation
  // under-measured `999` by a pixel.
  const fetchedAt = '2026-09-07T12:00:00+10:00';
  const seen = new Set<string>();
  const check = (ageMin: number) => {
    const now = new Date(Date.parse(fetchedAt) + ageMin * 60_000);
    const label = Formatter.staleLabel('claude', fetchedAt, now, 5);
    if (label === 'ok' || seen.has(label)) return;
    seen.add(label);
    assert.ok(
      Formatter.textWidth(label) <= reserved,
      `"${label}" is ${Formatter.textWidth(label)}px, over the ${reserved}px reserved`,
    );
    assert.equal(Formatter.measureLines(label, reserved).lineCount, 1, label);
  };
  for (let ageMin = 0; ageMin <= 999; ageMin += 1) check(ageMin); // every `stale Xm`
  for (let ageHr = 16; ageHr <= 999; ageHr += 1) check(ageHr * 60); // every `stale Xh`
  check(1000 * 60); // the saturated `stale 999h+`
  assert.ok(seen.has('stale 999h+'), 'the saturated label was never produced');
  assert.ok(seen.size > 1900, `only ${seen.size} distinct labels were checked`);
});

test('Formatter.fitLine leaves a fitting line untouched and truncates an over-long one', () => {
  const short = '5h 63%';
  assert.equal(Formatter.fitLine(short, 542), short);
  const truncated = Formatter.fitLine('Agent usage · CLAUDE', 60);
  assert.ok(truncated.endsWith('...'), truncated);
  assert.ok(Formatter.textWidth(truncated) <= 60, truncated);
});
