// Fixed +10:00 zone: the §7 fixtures are all `+10:00`, so this is what makes `resets Thu 09:00`
// and `12:03` the expected strings on any machine. Must precede the first Date in the process.
process.env.TZ = 'Australia/Brisbane';

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BAR_EMPTY, BAR_FILLED, Formatter } from './format.ts';
import type { UsagePayload } from '@quotalens/shared';
import {
  CLAUDE_ONLY_PAYLOAD,
  CODEX_ONLY_PAYLOAD,
  DEMO_NOW,
  DEMO_PAYLOAD,
  EXTREME_PAYLOAD,
  NO_DATA_PAYLOAD,
} from './fixtures.ts';
import {
  BRIGHT_PRIMARY,
  BRIGHT_SECONDARY,
  CANVAS_H,
  CANVAS_W,
  CARD_INNER_W,
  clampCardRows,
  DEFAULT_SETTINGS,
  displayText,
  innerWidthOf,
  insetOf,
  LINE_H,
  MAX_CARD_ROWS,
  MAX_CONTENT_CHARS,
  MAX_TEXT_CONTAINERS,
  validatePage,
  type Screen,
  type ScreenInput,
  type TextSpec,
} from './render.ts';
import { menuScreen } from './screens/menu.ts';
import {
  allScreen,
  BAR_COL_CANDIDATES,
  BAR_COL_W,
  BAR_COL_X,
  CARD_CONTAINERS,
  FOOTER_RIGHT_CANDIDATES,
  LABEL_CANDIDATES,
  LABEL_COL_W,
  NO_DATA_LINES,
  ONE_PAGE,
  alignPercents,
  padPercent,
  PCT_COL_W,
  PCT_PADDED_W,
  REFRESHING,
  SECTION_VALUE_CANDIDATES,
  VALUE_COL_W,
  VALUE_COL_X,
} from './screens/tool.ts';

const SCREENS: Screen[] = [allScreen, menuScreen];

function input(overrides: Partial<ScreenInput> = {}): ScreenInput {
  return {
    payload: DEMO_PAYLOAD,
    now: DEMO_NOW,
    settings: DEFAULT_SETTINGS,
    errorCode: null,
    cursor: 0,
    ...overrides,
  };
}

/** 21 minutes after the EXTREME fixture's `fetchedAt`: past both tools' §3 thresholds. */
const BOTH_STALE_NOW = new Date(Date.parse(EXTREME_PAYLOAD.claude.fetchedAt!) + 21 * 60_000);

/**
 * The one shape whose bar column is entirely empty: a Codex section with no window at all, only a
 * credits balance (§3 allows it — the owner's account has no 5h window, and a plan without a weekly
 * limit would leave just this). Its two rows are a section row and a Credits row, neither of which
 * has a bar, so the §7 "bar alignment" bar container would be `'\n'` — blank without being length-zero.
 */
const CREDITS_ONLY_PAYLOAD: UsagePayload = {
  ...CODEX_ONLY_PAYLOAD,
  codex: { ...CODEX_ONLY_PAYLOAD.codex, weekly: null, credits: { remainingUsd: 4.2 } },
};

/**
 * Every §7 "merged page" frame the merged page has to survive, each named for the design frame and the §7
 * row it stands for. These are the cases the whole file iterates.
 */
const CASES: { name: string; input: ScreenInput }[] = [
  { name: 'G1 — both sections, one live and one stale', input: input() },
  { name: 'G2 — the 3+3 worst case (8 rows)', input: input({ payload: EXTREME_PAYLOAD }) },
  {
    name: 'G3 — both sections stale, refreshing…',
    input: input({ payload: EXTREME_PAYLOAD, now: BOTH_STALE_NOW, statusNotice: REFRESHING }),
  },
  { name: "F1' — Codex never fetched", input: input({ payload: CLAUDE_ONLY_PAYLOAD }) },
  { name: "F1'' — Claude never fetched", input: input({ payload: CODEX_ONLY_PAYLOAD }) },
  { name: "F1''' — neither tool ever fetched", input: input({ payload: NO_DATA_PAYLOAD }) },
  // §7 "bar alignment": the page with no bar on any row, so the bar container is not built.
  { name: 'F4 — a Codex section with nothing but Credits', input: input({ payload: CREDITS_ONLY_PAYLOAD }) },
  { name: "F2' — CONNECTING", input: input({ payload: null, errorCode: 'bad schema' }) },
  { name: 'F3 — UNCONFIGURED overrides cached data', input: input({ unconfigured: true }) },
  { name: 'H — the §7 V9 swipe answer', input: input({ notice: ONE_PAGE }) },
  // A swipe inside the two seconds after a tap: §7 V9 on the left and §7 V7 on the right at the same
  // time. Two slots, two lifetimes — the page has to draw both (2026-09-10 review).
  {
    name: 'H2 — the V9 answer and the V7 notice together',
    input: input({ notice: ONE_PAGE, statusNotice: REFRESHING }),
  },
  { name: 'C2 — menu, cursor on the last item', input: input({ cursor: 2 }) },
];

function byName(specs: TextSpec[], name: string): TextSpec {
  const spec = specs.find((s) => s.name === name);
  assert.ok(spec, `no container named ${name}`);
  return spec;
}

function lines(specs: TextSpec[], name: string): string[] {
  return byName(specs, name).content.split('\n');
}

/** Does this line carry a progress bar? Either cell glyph is enough (0% is all-empty, 100% all-full). */
function hasBar(line: string): boolean {
  return line.includes(BAR_FILLED) || line.includes(BAR_EMPTY);
}

/**
 * The absolute canvas x where card row `row`'s progress bar actually starts to draw — found by
 * looking for the bar in EVERY card container and measuring whatever text precedes it inside the
 * one that has it. `null` when that row has no bar (a section row, a Credits row).
 *
 * Deliberately layout-agnostic: it makes no assumption about which container holds the bar or what
 * else shares the line, which is what lets one assertion tell a one-container layout (where the
 * percentage pushes the bar sideways) from the three-container one §7 asks for.
 */
function barStartX(specs: TextSpec[], row: number): number | null {
  for (const spec of specs) {
    if (!spec.name.startsWith('card')) continue;
    const line = spec.content.split('\n')[row];
    if (line === undefined || !hasBar(line)) continue;
    const at = [BAR_FILLED, BAR_EMPTY].map((g) => line.indexOf(g)).filter((i) => i >= 0);
    return spec.x + insetOf(spec) + Formatter.textWidth(line.slice(0, Math.min(...at)));
  }
  return null;
}

// ---- O4 / naming / canvas budget --------------------------------------------

for (const screen of SCREENS) {
  for (const testCase of CASES) {
    test(`${screen.id} page is a legal page — ${testCase.name}`, () => {
      const specs = screen.buildContainers(testCase.input);
      assert.deepEqual(validatePage(specs), []);
    });
  }
}

test('container counts stay inside the O4 budget', () => {
  // §7 "dim section rows": header 1 + card 5 (labels + percentages + bars + the two dim section
  // containers) + footer-left 1 = 7, plus the footer status column only when V2 or V7 gives it
  // something to say — 8, which is the O4 limit itself. Anything new has to remove something first.
  assert.equal(allScreen.buildContainers(input()).length, 7);
  assert.equal(allScreen.buildContainers(input({ statusNotice: REFRESHING })).length, MAX_TEXT_CONTAINERS);
  // CONNECTING has nothing to split into columns and no section row, and always carries an error
  // code (§7 V2).
  assert.equal(allScreen.buildContainers(input({ payload: null })).length, 4);
  assert.equal(allScreen.buildContainers(input({ unconfigured: true })).length, 4);
  // §7 V1 re-judged: the two-line card, no column split, nothing in the status column.
  assert.equal(allScreen.buildContainers(input({ payload: NO_DATA_PAYLOAD })).length, 3);
  // A section whose only row is Credits has no bar to draw, so no bar container is built at all.
  assert.equal(allScreen.buildContainers(input({ payload: CREDITS_ONLY_PAYLOAD })).length, 6);
  // The menu is one under the O4 limit now that `Switch to …` is gone (M6b).
  assert.equal(menuScreen.buildContainers(input()).length, 7);
  // And no case anywhere in the file exceeds O4 — the page has no headroom left at all now.
  for (const testCase of CASES) {
    const count = allScreen.buildContainers(testCase.input).length;
    assert.ok(count <= MAX_TEXT_CONTAINERS, `${testCase.name}: ${count} containers, over O4's ${MAX_TEXT_CONTAINERS}`);
  }
});

// ---- pretext: nothing wraps, nothing is truncated, nothing overflows ---------

for (const screen of SCREENS) {
  for (const testCase of CASES) {
    test(`${screen.id} text fits its containers — ${testCase.name}`, () => {
      for (const spec of screen.buildContainers(testCase.input)) {
        const innerW = innerWidthOf(spec);
        const innerH = spec.h - 2 * insetOf(spec);
        const expectedLines = spec.content.split('\n').length;
        const measured = Formatter.measureLines(spec.content, innerW);

        // A container whose text wrapped would silently push content out of the box.
        assert.equal(
          measured.lineCount,
          expectedLines,
          `${screen.id}/${spec.name} wrapped: ${JSON.stringify(spec.content)} at ${innerW}px`,
        );
        assert.ok(
          Math.max(...measured.lineWidths) <= innerW,
          `${screen.id}/${spec.name} is ${Math.max(...measured.lineWidths)}px wide, inner width ${innerW}px`,
        );
        assert.ok(
          measured.height <= innerH,
          `${screen.id}/${spec.name} is ${measured.height}px tall, inner height ${innerH}px`,
        );
        // `fitLine` clips with an ellipsis. Passing the width check by having been truncated is not
        // passing — none of the specified strings may lose characters at this size.
        assert.ok(
          !spec.content.includes('...'),
          `${screen.id}/${spec.name} was truncated: ${JSON.stringify(spec.content)}`,
        );
      }
    });
  }
}

test('the left and right halves of a header/footer row never overlap', () => {
  for (const screen of SCREENS) {
    for (const testCase of CASES) {
      const specs = screen.buildContainers(testCase.input);
      for (const [left, right] of [
        ['hdrLeft', 'hdrRight'],
        ['ftrLeft', 'ftrRight'],
      ]) {
        const l = specs.find((s) => s.name === left);
        const r = specs.find((s) => s.name === right);
        // The merged page has no header-right container at all, and no footer-right unless V2/V7
        // gives it something to say (§7 "merged page"). A missing column cannot overlap anything.
        if (l === undefined || r === undefined) continue;
        assert.ok(
          l.x + l.w <= r.x,
          `${screen.id}/${testCase.name}: ${left} ends at ${l.x + l.w}, ${right} starts at ${r.x}`,
        );
        assert.ok(r.x + r.w <= CANVAS_W, `${screen.id}: ${right} runs past the canvas`);
      }
    }
  }
});

test('the card never collides with the header or the footer', () => {
  for (const testCase of CASES) {
    const specs = allScreen.buildContainers(testCase.input);
    const card = byName(specs, 'card');
    const header = byName(specs, 'hdrLeft');
    const footer = byName(specs, 'ftrLeft');
    assert.ok(card.y >= header.y + header.h, `${testCase.name}: card overlaps header`);
    assert.ok(card.y + card.h <= footer.y, `${testCase.name}: card overlaps footer`);
    assert.ok(card.y + card.h <= CANVAS_H);
  }
});

// ---- §7 "merged page" text spec ---------------------------------------------------

test('G1 — the merged page draws both sections, each with its own clock and §3 verdict', () => {
  const specs = allScreen.buildContainers(input());
  // §7 "merged page": the header names the app and nothing else — no `●○`, no clock.
  assert.equal(byName(specs, 'hdrLeft').content, 'Agent usage');
  assert.equal(specs.find((s) => s.name === 'hdrRight'), undefined, 'the header-right column is gone');
  // §7 "dim section rows": the section rows are drawn by the dim pair, so the primary label column
  // leaves those lines empty. §7 "section gap": row 4 is the blank between the two sections.
  assert.deepEqual(lines(specs, 'card'), ['', '5h', 'Week', 'Fable', '', '', 'Week']);
  assert.deepEqual(lines(specs, 'secLabels'), ['CLAUDE', '', '', '', '', 'CODEX', '']);
  assert.deepEqual(lines(specs, 'secStatus'), [
    // The section row's time is that tool's own `fetchedAt` (12:03:41), truncated — not `now`.
    '12:03 · ok',
    '',
    '',
    '',
    '',
    // The same payload, 23 minutes older for Codex, past its own 10-minute threshold (§3).
    '11:41 · stale 23m',
    '',
  ]);
  // §7 "bar alignment": the percent container holds the percentages and the bar container the bars — one
  // line each, so the rows stay aligned across all five containers. §7 "right-aligned percentages": the
  // percentages carry measured padding so their `%` glyphs line up on the column's right edge.
  // The padding is chosen per page (`alignPercents`), so the values are compared trimmed here and
  // their alignment is asserted in the right-aligned percentages tests below.
  assert.deepEqual(
    lines(specs, 'cardVals').map((v) => v.trim()),
    ['', '63%', '28%', '8%', '', '', '64%'],
  );
  assert.deepEqual(lines(specs, 'cardBars'), [
    // A section row has no bar, and the empty line is what keeps the rows below it in step.
    '',
    '████████▒▒▒▒ resets 14:20',
    '███▒▒▒▒▒▒▒▒▒ resets Thu 09:00',
    // §7 V4: weeklySonnet has no server reset time, so only the suffix is dropped.
    '█▒▒▒▒▒▒▒▒▒▒▒',
    '',
    '',
    '████████▒▒▒▒ resets Mon 08:00',
  ]);
  assert.equal(byName(specs, 'ftrLeft').content, 'tap refresh · hold menu');
  // §7 "merged page": the status column is blank in the normal case — i.e. it is not built at all.
  assert.equal(specs.find((s) => s.name === 'ftrRight'), undefined, 'the status column should be blank');
});

test('G2 — the 3+3 worst case is exactly 8 rows, card y=27 h=234, filling the band', () => {
  const specs = allScreen.buildContainers(input({ payload: EXTREME_PAYLOAD }));
  const card = byName(specs, 'card');
  const labels = lines(specs, 'card');
  // §7 "section gap": eight rows already, so the sections are NOT separated by a blank one — and the
  // section labels sit in the dim container (§7 "dim section rows").
  // T6b.2: no `!` on the 100% rows any more — the marker was withdrawn, the widths were not.
  assert.deepEqual(labels, ['', '5h', 'Week', 'Sonnet', '', '5h', 'Week', 'Credits']);
  assert.deepEqual(lines(specs, 'secLabels'), ['CLAUDE', '', '', '', 'CODEX', '', '', '']);
  assert.equal(labels.length, MAX_CARD_ROWS, 'the worst case must be the documented maximum');
  // §7 "merged page" vertical rule: 8×27 + 18 = 234, centred in the 27..261 band = exactly that band.
  assert.equal(card.y, 27);
  assert.equal(card.h, 234);
  assert.equal(card.y + card.h, 261);
  assert.deepEqual(lines(specs, 'secStatus'), ['12:03 · ok', '', '', '', '12:03 · ok', '', '', '']);
  assert.deepEqual(lines(specs, 'cardVals'), [
    '',
    '100%',
    '    0%',
    ' 99%',
    '',
    '     1%',
    '100%',
    // Credits are a balance, so no bar and no padding — a wide line in the container.
    '$4.20 left',
  ]);
  assert.deepEqual(lines(specs, 'cardBars'), [
    '',
    '████████████ resets Wed 23:59',
    '▒▒▒▒▒▒▒▒▒▒▒▒ resets Wed 23:59',
    '███████████▒ resets Wed 23:59',
    '',
    // §7 V4: a 5h window with no server reset time keeps its percentage and bar.
    '█▒▒▒▒▒▒▒▒▒▒▒',
    '████████████ resets Wed 23:59',
    '',
  ]);
});

test('G3 — both sections stale, and refreshing… in the status column', () => {
  const specs = allScreen.buildContainers(
    input({ payload: EXTREME_PAYLOAD, now: BOTH_STALE_NOW, statusNotice: REFRESHING }),
  );
  assert.deepEqual(lines(specs, 'card'), ['', '5h', 'Week', 'Sonnet', '', '5h', 'Week', 'Credits']);
  const values = lines(specs, 'secStatus');
  assert.equal(values[0], '12:03 · stale 21m', 'the CLAUDE section carries its own staleness');
  assert.equal(values[4], '12:03 · stale 21m', 'and so does CODEX, from its own fetchedAt');
  // §7 V7 lives in the footer status column; the footer-left hint is untouched by it.
  assert.equal(byName(specs, 'ftrRight').content, REFRESHING);
  assert.equal(byName(specs, 'ftrLeft').content, 'tap refresh · hold menu');
});

test("F1' / F1'' — a tool with source:\"none\" contributes no section at all (§7 V1 re-judged)", () => {
  const claudeOnly = allScreen.buildContainers(input({ payload: CLAUDE_ONLY_PAYLOAD }));
  assert.deepEqual(lines(claudeOnly, 'card'), ['', '5h', 'Week', 'Fable']);
  assert.deepEqual(lines(claudeOnly, 'secLabels'), ['CLAUDE', '', '', '']);
  assert.ok(!byName(claudeOnly, 'secLabels').content.includes('CODEX'), 'the never-fetched tool is drawn');
  // The withdrawn V1 rendering: no `--` values and no all-empty bar anywhere on the page.
  assert.ok(!byName(claudeOnly, 'cardVals').content.includes('--'));
  assert.ok(!byName(claudeOnly, 'cardBars').content.includes('▒▒▒▒▒▒▒▒▒▒▒▒'));

  const codexOnly = allScreen.buildContainers(input({ payload: CODEX_ONLY_PAYLOAD }));
  // Only one tool left, and its section row is still drawn (§7 V1 re-judged, second clause) — dim,
  // and with no gap row, because one section has nothing to be separated from.
  assert.deepEqual(lines(codexOnly, 'card'), ['', 'Week']);
  assert.deepEqual(lines(codexOnly, 'secLabels'), ['CODEX', '']);
  assert.deepEqual(lines(codexOnly, 'secStatus'), ['11:41 · stale 23m', '']);
  assert.deepEqual(lines(codexOnly, 'cardVals'), ['', '  64%']);
  assert.deepEqual(lines(codexOnly, 'cardBars'), ['', '████████▒▒▒▒ resets Mon 08:00']);
});

test("F1''' — with neither tool ever fetched the card says so in two lines", () => {
  const specs = allScreen.buildContainers(input({ payload: NO_DATA_PAYLOAD }));
  assert.deepEqual(lines(specs, 'card'), [...NO_DATA_LINES]);
  assert.deepEqual(NO_DATA_LINES, ['No usage data', 'tap refresh']);
  // No label/value split in this state, so no second card container — and nothing says `no data`
  // in the footer any more (§7 V1 re-judged: that column stays blank).
  assert.equal(specs.find((s) => s.name === 'cardVals'), undefined);
  assert.equal(specs.find((s) => s.name === 'ftrRight'), undefined);
  // Two rows, centred: 2×27 + 18 = 72 in the 27..261 band.
  assert.equal(byName(specs, 'card').h, 72);
});

test("F2' — CONNECTING keeps a visible card and shows the error code (§7 V2, unchanged)", () => {
  const specs = allScreen.buildContainers(input({ payload: null, errorCode: '404' }));
  assert.equal(byName(specs, 'card').content, 'Connecting…');
  assert.equal(byName(specs, 'ftrRight').content, '404');
  assert.equal(specs.find((s) => s.name === 'cardVals'), undefined, 'there is no value column yet');
  // §7 V7 outranks the code: a Refresh pressed while CONNECTING must not read as no feedback.
  const refreshing = allScreen.buildContainers(input({ payload: null, errorCode: '404', statusNotice: REFRESHING }));
  assert.equal(byName(refreshing, 'ftrRight').content, REFRESHING);
});

test('F3 — UNCONFIGURED shows the two-line setup card with a dim second line', () => {
  const screenInput = input({ unconfigured: true });
  const specs = allScreen.buildContainers(screenInput);
  const card = byName(specs, 'card');
  const second = byName(specs, 'secLabels');

  assert.deepEqual(card.content.split('\n'), ['Set the relay address', '']);
  assert.deepEqual(second.content.split('\n'), ['', 'in the Even App on your phone']);
  assert.equal(card.brightness, BRIGHT_PRIMARY);
  assert.equal(second.brightness, BRIGHT_SECONDARY);
  assert.equal(second.x, card.x + insetOf(card));
  assert.equal(second.y, card.y + insetOf(card));
  assert.equal(second.w, CARD_INNER_W);
  assert.equal(second.h, 2 * LINE_H);
  assert.equal(byName(specs, 'ftrLeft').content, 'hold menu');
  assert.equal(specs.find((spec) => spec.name === 'ftrRight'), undefined);
  assert.equal(specs.find((spec) => spec.name === 'cardVals'), undefined);
  assert.deepEqual(validatePage(specs), []);
  assert.ok(specs.length <= MAX_TEXT_CONTAINERS);

  const patch = allScreen.patch(screenInput);
  assert.equal(patch.find((update) => update.name === 'secLabels')?.content, second.content);
});

test('H — §7 V9: the swipe answer takes the footer-LEFT slot at primary brightness', () => {
  const quiet = allScreen.buildContainers(input());
  const swiped = allScreen.buildContainers(input({ notice: ONE_PAGE }));
  assert.equal(byName(swiped, 'ftrLeft').content, 'one page · hold menu');
  assert.equal(ONE_PAGE, 'one page · hold menu');
  // Primary vs the standing hint's secondary — which is also why raising it costs a rebuild:
  // `textContainerUpgrade` cannot change `textColor`.
  assert.equal(byName(swiped, 'ftrLeft').brightness, BRIGHT_PRIMARY);
  assert.equal(byName(quiet, 'ftrLeft').brightness, BRIGHT_SECONDARY);
  // …and it must not land in the status column, where §7 V7 lives.
  assert.equal(swiped.find((s) => s.name === 'ftrRight'), undefined);

  // Both at once — a swipe inside the two seconds after a tap. Each slot carries its own notice, so
  // neither can displace the other (2026-09-10 review: they shared one field and one lifetime).
  const both = allScreen.buildContainers(input({ notice: ONE_PAGE, statusNotice: REFRESHING }));
  assert.equal(byName(both, 'ftrLeft').content, ONE_PAGE);
  assert.equal(byName(both, 'ftrLeft').brightness, 4);
  assert.equal(byName(both, 'ftrRight').content, REFRESHING);
  assert.deepEqual(validatePage(both), []);
});

test('C2 — the menu is three items with an n/3 indicator (M6b)', () => {
  const specs = menuScreen.buildContainers(input());
  assert.equal(byName(specs, 'hdrLeft').content, 'Menu');
  assert.equal(byName(specs, 'hdrRight').content, 'double-tap = back');
  assert.equal(byName(specs, 'opt1').content, '> Refresh now');
  assert.equal(byName(specs, 'opt2').content, 'Token stats · soon');
  assert.equal(byName(specs, 'opt3').content, 'Exit');
  assert.equal(specs.find((s) => s.name === 'opt4'), undefined, 'Switch to … was withdrawn by M6b');
  assert.equal(byName(specs, 'ftrLeft').content, '▲▼ move · tap select');
  // §7 ruling: the indicator is the cursor index, so the first item reads 1/3.
  assert.equal(byName(specs, 'ftrRight').content, '1/3');
});

test('only the selected menu row is bordered, and every label shares one x', () => {
  for (const cursor of [0, 1, 2]) {
    const specs = menuScreen.buildContainers(input({ cursor }));
    const options = [1, 2, 3].map((i) => byName(specs, `opt${i}`));
    options.forEach((opt, i) => {
      assert.equal(opt.border ?? 0, i === cursor ? 1 : 0, `opt${i + 1} border at cursor ${cursor}`);
      assert.ok(i === cursor ? opt.content.startsWith('> ') : !opt.content.startsWith('> '));
    });
    // The label's absolute x must not move when the cursor does — the selected row spends its
    // inset on border+padding and the others on padding alone, and the box shifts by the measured
    // width of "> " rather than by any number of spaces (O3).
    const labelX = options.map((opt, i) => opt.x + insetOf(opt) + (i === cursor ? Formatter.textWidth('> ') : 0));
    assert.equal(new Set(labelX).size, 1, `label x drifted at cursor ${cursor}: ${labelX.join(',')}`);
    assert.equal(byName(specs, 'ftrRight').content, `${cursor + 1}/3`);
  }
});

// ---- §7 "bar alignment": the bars share one x (2026-09-10 owner finding, second revision) -----------

test('§7 bar alignment — an 8% row and a 63% row start their bars at the same x', () => {
  const specs = allScreen.buildContainers(input());
  // G1's rows: 0 = the CLAUDE section row, 1 = `63%`, 2 = `28%`, 3 = `8%`. Three glyphs against
  // two, so while one container holds `63% ████… resets 14:20` the font's own width difference
  // (38px vs 26px) offsets the bars — which is what the owner saw on the real glasses.
  const wide = barStartX(specs, 1);
  const narrow = barStartX(specs, 3);
  assert.ok(wide !== null, 'the 63% row has no bar at all');
  assert.ok(narrow !== null, 'the 8% row has no bar at all');
  assert.equal(narrow, wide, `the 8% bar starts at ${narrow}, the 63% bar at ${wide}`);
  // The other half of the fix: a percentage and its bar are in DIFFERENT containers, so no
  // percentage line may carry a bar glyph.
  for (const line of lines(specs, 'cardVals')) {
    assert.ok(!hasBar(line), `the percent column still carries a bar: ${JSON.stringify(line)}`);
  }
});

test('§7 bar alignment — every bar on every fixture starts at the one reserved x', () => {
  const starts = new Set<number>();
  for (const testCase of WINDOW_CASES) {
    const specs = allScreen.buildContainers(testCase.input);
    const rowCount = byName(specs, 'card').content.split('\n').length;
    for (let row = 0; row < rowCount; row++) {
      const x = barStartX(specs, row);
      if (x !== null) starts.add(x);
    }
    // No percentage may carry a bar on any fixture, or the row above would drift again.
    for (const line of lines(specs, 'cardVals')) assert.ok(!hasBar(line), `${testCase.name}: ${line}`);
  }
  assert.ok(starts.size > 0, 'no fixture drew a bar at all, so this test proves nothing');
  assert.deepEqual([...starts], [BAR_COL_X], `bars drew at ${[...starts].join(', ')}`);
  // The reserved x, spelled out: 17 (card text) + 68 (labels) + 10 + 46 (percent) + 10 = 151.
  assert.equal(BAR_COL_X, 151);
});

test('§7 bar alignment — the three columns measure 68 + 10 + 46 + 10 + 402 inside a 542px card', () => {
  const GAP = Formatter.textWidth(' ') * 2;
  assert.equal(GAP, 10);
  assert.equal(LABEL_COL_W, 68);
  // §7's reservation: the widest percentage `Formatter.pctLabel` can return, which is `100%`.
  assert.equal(PCT_COL_W, 46);
  assert.equal(Formatter.widestWidth(['100%']), 46);
  assert.equal(BAR_COL_W, 408);
  const widestBar = BAR_COL_CANDIDATES.reduce((a, b) => (Formatter.textWidth(b) > Formatter.textWidth(a) ? b : a));
  // 402px, not §7's 394px: the widest weekday and the widest digits are `resets Mon 44:44`, three
  // pixels past `resets Thu 09:00`. Both fit, and the reservation is taken from the wider one.
  assert.equal(Formatter.textWidth(widestBar), 402);
  assert.equal(LABEL_COL_W + GAP + PCT_COL_W + GAP + Formatter.textWidth(widestBar), 536);
  assert.ok(
    LABEL_COL_W + GAP + PCT_COL_W + GAP + Formatter.textWidth(widestBar) <= CARD_INNER_W,
    `the three columns need ${LABEL_COL_W + GAP + PCT_COL_W + GAP + Formatter.textWidth(widestBar)}px of ${CARD_INNER_W}`,
  );
  // The columns are laid out from those measurements, so the x values follow from them.
  assert.equal(VALUE_COL_X, 95);
  assert.equal(BAR_COL_X, VALUE_COL_X + PCT_COL_W + GAP);
  assert.equal(VALUE_COL_W, 464);
});

test('§7 bar alignment — every percentage fits 46px and every bar line fits the bar column', () => {
  for (let pct = 0; pct <= 100; pct++) {
    const label = Formatter.pctLabel(pct);
    assert.ok(
      Formatter.textWidth(label) <= PCT_COL_W,
      `"${label}" is ${Formatter.textWidth(label)}px, over the ${PCT_COL_W}px percent column`,
    );
    assert.equal(Formatter.measureLines(label, PCT_COL_W).lineCount, 1, `"${label}" wraps`);
  }
  // Every bar shape against every `resets …` the formatter can produce — 1053 lines, none clipped.
  assert.ok(BAR_COL_CANDIDATES.length > 1000, 'the candidate set stopped covering the combinations');
  for (const candidate of BAR_COL_CANDIDATES) {
    assert.ok(
      Formatter.textWidth(candidate) <= BAR_COL_W,
      `"${candidate}" is ${Formatter.textWidth(candidate)}px, over the ${BAR_COL_W}px bar column`,
    );
    assert.equal(Formatter.measureLines(candidate, BAR_COL_W).lineCount, 1, `"${candidate}" wraps`);
    assert.equal(Formatter.fitLine(candidate, BAR_COL_W), candidate, `"${candidate}" was clipped`);
  }
});

test('§7 bar alignment — the three columns never overlap on any row of any fixture', () => {
  for (const testCase of DATA_CASES) {
    const specs = allScreen.buildContainers(testCase.input);
    const card = byName(specs, 'card');
    const pcts = lines(specs, 'cardVals');
    const bars = specs.find((s) => s.name === 'cardBars');
    const labels = lines(specs, 'card');
    labels.forEach((label, row) => {
      const pct = pcts[row] ?? '';
      const bar = bars?.content.split('\n')[row] ?? '';
      // Where each column's visible text actually ends. An empty line occupies nothing, which is
      // what lets a section row's wide `HH:MM · ok` run on under the (empty) bar column.
      const labelEnd = card.x + insetOf(card) + Formatter.textWidth(label);
      const pctEnd = VALUE_COL_X + Formatter.textWidth(pct);
      const barEnd = bar === '' ? BAR_COL_X : BAR_COL_X + Formatter.textWidth(bar);
      const where = `${testCase.name} row ${row} (${label} | ${pct} | ${bar})`;
      assert.ok(labelEnd <= VALUE_COL_X, `${where}: the label reaches the percent column at ${labelEnd}`);
      if (bar !== '') {
        assert.ok(pctEnd <= BAR_COL_X, `${where}: the percentage reaches the bar column at ${pctEnd}`);
      }
      assert.ok(barEnd <= card.x + card.w - insetOf(card), `${where}: the bar runs past the frame at ${barEnd}`);
      // A row that has a bar must have a percentage, and one that has none must not (the wide rows).
      assert.equal(bar !== '', !hasBar(pct) && /%$/.test(pct), `${where}: percentage and bar disagree`);
    });
  }
});

test('§7 bar alignment — a page with no bar on any row builds no bar container', () => {
  // §6 rule 5 / `validatePage`: a container of nothing but line breaks is blank without being
  // length-zero, so the empty case has to be caught where the page is built.
  const specs = allScreen.buildContainers(input({ payload: CREDITS_ONLY_PAYLOAD }));
  assert.deepEqual(lines(specs, 'card'), ['', 'Credits']);
  assert.deepEqual(lines(specs, 'secLabels'), ['CODEX', '']);
  assert.deepEqual(lines(specs, 'secStatus'), ['11:41 · stale 23m', '']);
  assert.deepEqual(lines(specs, 'cardVals'), ['', '$4.20 left']);
  assert.equal(specs.find((s) => s.name === 'cardBars'), undefined, 'an all-blank bar column was built');
  assert.deepEqual(validatePage(specs), []);
  // And `patch` must not address a container that mount never created — `textContainerUpgrade`
  // fails silently against one, which would leave the screen stale with no other symptom.
  assert.equal(
    allScreen.patch(input({ payload: CREDITS_ONLY_PAYLOAD })).find((u) => u.name === 'cardBars'),
    undefined,
  );
  // The known-good side: the same page one weekly window later does build one.
  assert.ok(allScreen.buildContainers(input()).some((s) => s.name === 'cardBars'));
  assert.ok(allScreen.patch(input()).some((u) => u.name === 'cardBars'));
});

test('§7 bar alignment — the bar column shares the card baselines and sits inside the frame', () => {
  for (const testCase of WINDOW_CASES) {
    const specs = allScreen.buildContainers(testCase.input);
    const card = byName(specs, 'card');
    const vals = byName(specs, 'cardVals');
    const bars = byName(specs, 'cardBars');
    const inset = insetOf(card);
    assert.equal(bars.y, vals.y, `${testCase.name}: the bars are off the percent baseline`);
    assert.equal(bars.y, card.y + inset, `${testCase.name}: the bars are off the label baseline`);
    assert.equal(bars.h, vals.h, `${testCase.name}: the bar column is a different height`);
    assert.equal(
      bars.content.split('\n').length,
      card.content.split('\n').length,
      `${testCase.name}: the bar column has a different number of rows`,
    );
    assert.ok(bars.x + bars.w <= card.x + card.w - inset, `${testCase.name}: the bar column runs past the frame`);
    assert.ok(bars.y + bars.h <= card.y + card.h - inset, `${testCase.name}: the bar column runs below the frame`);
    // Declaration order is the only z-ordering available (zOrderIndex is all-or-nothing per page),
    // so the bars must be declared after both the frame and the percentages.
    const order = ['card', 'cardVals', 'cardBars'].map((n) => specs.findIndex((s) => s.name === n));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${testCase.name}: declaration order ${order.join(',')}`);
  }
});

// ---- §7 third revision (2026-09-10 owner rulings): gap, right-aligned %, dim section rows -------

/** One card row's text in a container that may not exist on this page (the bar column, the dim pair). */
function rowText(specs: TextSpec[], name: string, row: number): string {
  return specs.find((s) => s.name === name)?.content.split('\n')[row] ?? '';
}

/** G1's gap row: 2 section rows + 4 data rows = 6, so the blank lands between the two sections. */
const G1_GAP_ROW = 4;

test('§7 section gap — a blank row separates the sections while the total still fits eight rows', () => {
  const specs = allScreen.buildContainers(input());
  assert.equal(lines(specs, 'card').length, 7, 'six data/section rows plus the gap');
  // §7 "section gap": the blank is blank in EVERY card container, or something would show on that line.
  for (const name of CARD_CONTAINERS) {
    assert.equal(lines(specs, name).length, 7, `${name} has a different number of rows`);
    assert.equal(rowText(specs, name, G1_GAP_ROW), '', `${name} has text on the gap row`);
  }
  // …and it counts toward the card's height like any other row: 7×27 + 18 = 207.
  const card = byName(specs, 'card');
  assert.equal(card.h, 7 * LINE_H + 2 * 9);
  assert.ok(card.y + card.h <= 261, `the card ends at ${card.y + card.h}`);
  assert.deepEqual(validatePage(specs), []);
});

test('§7 section gap — the 3+3 worst case gets no gap, because nine rows do not fit', () => {
  const specs = allScreen.buildContainers(input({ payload: EXTREME_PAYLOAD }));
  assert.equal(lines(specs, 'card').length, MAX_CARD_ROWS);
  // The CODEX section row follows the last CLAUDE data row directly — row 4, not row 5.
  assert.deepEqual(lines(specs, 'secLabels'), ['CLAUDE', '', '', '', 'CODEX', '', '', '']);
  const card = byName(specs, 'card');
  assert.equal(card.y, 27);
  assert.equal(card.h, 234);
});

test('§7 section gap — a single-section page has no blank row anywhere', () => {
  for (const payload of [CLAUDE_ONLY_PAYLOAD, CODEX_ONLY_PAYLOAD, CREDITS_ONLY_PAYLOAD]) {
    const specs = allScreen.buildContainers(input({ payload }));
    const rows = lines(specs, 'card').length;
    assert.equal(lines(specs, 'secLabels').filter((l) => l !== '').length, 1, 'one section only');
    for (let row = 0; row < rows; row++) {
      const blank = CARD_CONTAINERS.every((name) => rowText(specs, name, row) === '');
      assert.ok(!blank, `row ${row} of ${rows} is blank on a single-section page`);
    }
  }
});

test('§7 right-aligned percentages — 5% and 73% land within half a space of the column edge', () => {
  const half = Formatter.textWidth(' ') / 2;
  for (const pct of [5, 73]) {
    const text = Formatter.pctLabel(pct);
    const padded = padPercent(text);
    const width = Formatter.textWidth(padded);
    assert.ok(padded.startsWith(' ') && padded.endsWith(text), `"${padded}" is not padded ${text}`);
    assert.ok(
      Math.abs(PCT_COL_W - width) <= half,
      `"${padded}" measures ${width}px against a ${PCT_COL_W}px column, over half a space (${half}px)`,
    );
  }
  // Every percentage, not just those two — and the padding is measured, so none of them may reach
  // the bar column beside it (which is the hard limit; the 46px reservation is the target).
  for (let pct = 0; pct <= 100; pct++) {
    const padded = padPercent(Formatter.pctLabel(pct));
    const width = Formatter.textWidth(padded);
    assert.ok(
      Math.abs(PCT_COL_W - width) <= half,
      `"${padded}" measures ${width}px against a ${PCT_COL_W}px column, over half a space (${half}px)`,
    );
    assert.ok(width <= PCT_PADDED_W, `"${padded}" is ${width}px, over the measured ${PCT_PADDED_W}px`);
    assert.ok(VALUE_COL_X + width < BAR_COL_X, `"${padded}" ends at ${VALUE_COL_X + width}, at the bar column`);
    assert.equal(Formatter.fitLine(padded, PCT_PADDED_W), padded, `"${padded}" was clipped`);
  }
  // 48px: two past the 46px reservation. That is kerning at the space→digit junction — the reason the
  // count is measured per candidate instead of divided out of a width difference (O3's exception).
  // Past the 46px reservation by the kerning at the space→digit junction plus the widest target
  // `alignPercents` may choose — the reason the count is measured per candidate instead of divided
  // out of a width difference (O3's exception). What must hold is the bar column, not the number.
  assert.ok(PCT_PADDED_W >= 48 && VALUE_COL_X + PCT_PADDED_W < BAR_COL_X, `padded width ${PCT_PADDED_W} reaches the bar column`);
});

test('§7 right-aligned percentages — the percentages on one page share a right edge as nearly as the font allows', () => {
  // The owner on the device, 2026-09-10: `9%` sat right of `81%` and `17%`. Padded one by one to the
  // column they measured 47 / 44 / 47 — a 3px spread, because `1` is 8px where other digits are
  // 12–13 and the only blank is 5px wide (thin/hair/figure spaces are all missing glyphs).
  const spreadOf = (set: string[]): number => {
    const padded = alignPercents(set);
    for (const [i, text] of padded.entries()) assert.ok(text.endsWith(set[i]!), `"${text}" is not a padded ${set[i]}`);
    const widths = padded.map((text) => Formatter.textWidth(text));
    return Math.max(...widths) - Math.min(...widths);
  };
  assert.ok(spreadOf(['9%', '81%', '17%']) <= 2, 'the owner’s set');
  assert.ok(spreadOf(['0%', '1%', '30%']) <= 2, 'the codex counter-example on the target search');
  // The claim PLAN §7 makes, measured rather than asserted: every PAIR within 2px…
  const labels = Array.from({ length: 101 }, (_, pct) => Formatter.pctLabel(pct));
  let worstPair = 0;
  for (let a = 0; a <= 100; a++) for (let b = a + 1; b <= 100; b++) worstPair = Math.max(worstPair, spreadOf([labels[a]!, labels[b]!]));
  assert.equal(worstPair, 2, `some pair of percentages spreads ${worstPair}px`);
  // …and a whole page — up to the six percentages a card can hold — inside the bound PLAN §7 gives:
  // one 5px blank plus 1px of kerning. No tighter number is claimed; the sampled five-value worst
  // case (4px, codex's `0% / 1% / 2% / 10% / 31%` among them) is recorded so a regression that
  // widens it shows up here.
  const blankPlusKern = Formatter.textWidth(' ') + 1;
  assert.ok(spreadOf(['0%', '1%', '2%', '10%', '31%']) <= 4, 'the codex five-value counter-example');
  let worstSet = 0;
  for (let a = 0; a <= 100; a += 2) for (let b = a + 1; b <= 100; b += 5) for (let c = b + 1; c <= 100; c += 7) {
    for (let d = c + 1; d <= 100; d += 11) for (let e = d + 1; e <= 100; e += 13) {
      worstSet = Math.max(worstSet, spreadOf([labels[a]!, labels[b]!, labels[c]!, labels[d]!, labels[e]!]));
    }
  }
  assert.ok(worstSet <= blankPlusKern, `a five-value page spreads ${worstSet}px, over the ${blankPlusKern}px bound`);
  assert.ok(worstSet <= 4, `the sampled five-value worst case widened from 4px to ${worstSet}px`);
  // On the page: every percentage line ends short of the bar column and inside its clip budget.
  const specs = allScreen.buildContainers(input({ payload: EXTREME_PAYLOAD }));
  for (const value of lines(specs, 'cardVals').filter((v) => v.endsWith('%'))) {
    const width = Formatter.textWidth(value);
    assert.ok(width <= PCT_PADDED_W && VALUE_COL_X + width < BAR_COL_X, `"${value}" (${width}px) reaches the bar column`);
  }
});

test('§7 right-aligned percentages — the section rows and the Credits line are not padded', () => {
  const specs = allScreen.buildContainers(input({ payload: EXTREME_PAYLOAD }));
  const values = lines(specs, 'cardVals');
  assert.deepEqual([values[0], values[4], values[7]], ['', '', '$4.20 left']);
  assert.deepEqual(values.map((v) => v.trim()), ['', '100%', '0%', '99%', '', '1%', '100%', '$4.20 left']);
  for (const value of lines(specs, 'secStatus')) {
    assert.ok(!value.startsWith(' '), `the section row "${value}" was padded; §7 keeps it flush left`);
  }
});

test('§7 dim section rows — the section rows move into two dim containers', () => {
  const specs = allScreen.buildContainers(input());
  const card = byName(specs, 'card');
  const vals = byName(specs, 'cardVals');
  const secLabels = byName(specs, 'secLabels');
  const secStatus = byName(specs, 'secStatus');
  assert.equal(secLabels.brightness, BRIGHT_SECONDARY);
  assert.equal(secStatus.brightness, BRIGHT_SECONDARY);
  assert.equal(card.brightness, BRIGHT_PRIMARY, 'the data rows stay primary');
  assert.equal(vals.brightness, BRIGHT_PRIMARY);
  // Same columns as the primary pair, same baselines, same row count — that is what makes the dim
  // lines land exactly where the primary ones would have (§7 "dim section rows").
  assert.equal(secLabels.x, card.x + insetOf(card));
  assert.equal(secStatus.x, VALUE_COL_X);
  for (const spec of [secLabels, secStatus]) {
    assert.equal(spec.y, vals.y, `${spec.name} is off the card baseline`);
    assert.equal(spec.h, vals.h, `${spec.name} is a different height`);
    assert.equal(spec.content.split('\n').length, lines(specs, 'card').length, `${spec.name} row count`);
  }
  assert.deepEqual(lines(specs, 'secLabels'), ['CLAUDE', '', '', '', '', 'CODEX', '']);
  assert.deepEqual(lines(specs, 'secStatus'), ['12:03 · ok', '', '', '', '', '11:41 · stale 23m', '']);
});

test('§7 dim section rows — no card row carries text in both a primary and a dim container', () => {
  for (const testCase of DATA_CASES) {
    const specs = allScreen.buildContainers(testCase.input);
    for (const [primary, dim] of [
      ['card', 'secLabels'],
      ['cardVals', 'secStatus'],
    ]) {
      const rows = lines(specs, primary).length;
      for (let row = 0; row < rows; row++) {
        const a = rowText(specs, primary, row);
        const b = rowText(specs, dim, row);
        assert.ok(
          a === '' || b === '',
          `${testCase.name} row ${row}: ${primary} "${a}" and ${dim} "${b}" would overprint`,
        );
      }
    }
  }
});

test('§7 dim section rows — a card with no section row builds neither dim container', () => {
  // §7 V2's `Connecting…` and §7 V1's two-line card are plain lines with no sections at all, and an
  // all-blank container is a `validatePage` defect rather than a blank slot.
  for (const payload of [null, NO_DATA_PAYLOAD]) {
    const specs = allScreen.buildContainers(input({ payload, errorCode: 'net err' }));
    assert.equal(specs.find((s) => s.name === 'secLabels'), undefined, 'a dim label column was built');
    assert.equal(specs.find((s) => s.name === 'secStatus'), undefined, 'a dim status column was built');
    assert.deepEqual(validatePage(specs), []);
  }
  // `patch` must not address a container mount never created — the upgrade fails silently.
  const updates = allScreen.patch(input({ payload: NO_DATA_PAYLOAD }));
  assert.equal(updates.find((u) => u.name === 'secLabels'), undefined);
  assert.equal(updates.find((u) => u.name === 'secStatus'), undefined);
  // The known-good side: the data page builds both and patches both.
  assert.ok(allScreen.buildContainers(input()).some((s) => s.name === 'secLabels'));
  assert.ok(allScreen.patch(input()).some((u) => u.name === 'secLabels'));
  assert.ok(allScreen.patch(input()).some((u) => u.name === 'secStatus'));
});

test('§7 dim section rows — the five card containers are declared in the documented order', () => {
  // zOrderIndex is all-or-nothing per page, so declaration order is the only z-ordering there is:
  // card (the frame) first, then the columns laid over it (§7 "dim section rows").
  assert.deepEqual([...CARD_CONTAINERS], ['card', 'cardVals', 'cardBars', 'secLabels', 'secStatus']);
  const specs = allScreen.buildContainers(input());
  const order = CARD_CONTAINERS.map((name) => specs.findIndex((s) => s.name === name));
  assert.ok(
    order.every((i) => i >= 0),
    `G1 should build all five card containers: ${order.join(',')}`,
  );
  assert.deepEqual([...order].sort((a, b) => a - b), order, `declaration order ${order.join(',')}`);
});

test('the label column is 68px and the value container 464px, over a 450px longest row', () => {
  // §7 "merged page" text width: adding `CLAUDE` (68) / `CODEX` (59) to the candidates takes the label column
  // from 65 to 68, leaving 542 − 68 − 10 = 464 for the values.
  assert.equal(LABEL_COL_W, 68);
  assert.equal(VALUE_COL_W, 464);
  // §7's 445px floor, measured on the longest row before §7 "bar alignment" split it in two. The row is
  // drawn as `100%` in the percent container and the rest in the bar column now, so this is the
  // budget the two of them together are held to rather than one line's width.
  const longest = '100% ████████████ resets Wed 23:59';
  assert.equal(Formatter.textWidth(longest), 450);
  assert.ok(VALUE_COL_W >= 445, `the value column is ${VALUE_COL_W}px, under §7's 445px floor`);
  assert.ok(Formatter.textWidth(longest) <= VALUE_COL_W);
  // And the built container really is that wide, in every case that has one.
  for (const testCase of CASES) {
    const vals = allScreen.buildContainers(testCase.input).find((s) => s.name === 'cardVals');
    if (vals !== undefined) assert.equal(vals.w, VALUE_COL_W, testCase.name);
  }
});

test('a section row value fits the value column at its widest', () => {
  // `HH:MM · stale 999h+` and `--:-- · …` are the extremes the formatter can produce there.
  for (const candidate of SECTION_VALUE_CANDIDATES) {
    assert.ok(
      Formatter.textWidth(candidate) <= VALUE_COL_W,
      `"${candidate}" is ${Formatter.textWidth(candidate)}px, over the ${VALUE_COL_W}px column`,
    );
    assert.equal(Formatter.measureLines(candidate, VALUE_COL_W).lineCount, 1, `"${candidate}" wraps`);
  }
});

// ---- the label column holds one fixed x (the model §7 V3 asked for, kept by T6b.2) -------------

/** Every case that actually draws a data card — the notice cards have no label/value split. */
const DATA_CASES = CASES.filter(
  (c) => c.input.unconfigured !== true && c.input.payload !== null && c.input.payload !== NO_DATA_PAYLOAD,
);

/**
 * The subset that has at least one WINDOW row — the rows that carry a percentage and a bar, which is
 * what the column alignment is for. Recognised by the bar container, which exists on exactly the
 * pages that have a window (§7 "bar alignment").
 */
const WINDOW_CASES = DATA_CASES.filter((c) =>
  allScreen.buildContainers(c.input).some((s) => s.name === 'cardBars'),
);

test('the value column starts at one x, on every row of every fixture', () => {
  const columns = new Set<string>();
  for (const testCase of DATA_CASES) {
    const vals = byName(allScreen.buildContainers(testCase.input), 'cardVals');
    // One container holds every value line, so all rows share its x by construction — this
    // records that x to prove it is also the same across fixtures and row counts.
    columns.add(`${vals.x}/${vals.w}`);
  }
  assert.equal(columns.size, 1, `value column moved between cases: ${[...columns].join(', ')}`);
});

test('T6b.2 — no label on any fixture starts with the withdrawn ! marker', () => {
  // §7 V3 was withdrawn entirely by the 2026-09-10 owner ruling: the glasses never mark a row, at
  // any percentage. The 100% rows in the EXTREME fixture are what used to produce one, and they are
  // still here — the fixture's job is the column widths, not the marker (T6b.2 step ⑤).
  assert.ok(DATA_CASES.length > 0, 'no fixture draws a data card, so this test proves nothing');
  let labelsSeen = 0;
  for (const testCase of DATA_CASES) {
    for (const name of ['card', 'secLabels']) {
      for (const label of lines(allScreen.buildContainers(testCase.input), name)) {
        assert.ok(!label.startsWith('!'), `${testCase.name}/${name}: "${label}" carries a warning marker`);
        if (label !== '') labelsSeen += 1;
      }
    }
  }
  assert.ok(labelsSeen > 0, 'no non-empty label was examined at all');
  // The one payload that reaches every threshold V3 ever had: 100% on two windows and 99% on a third.
  assert.deepEqual(
    lines(allScreen.buildContainers(input({ payload: EXTREME_PAYLOAD })), 'cardVals'),
    ['', '100%', '    0%', ' 99%', '', '     1%', '100%', '$4.20 left'],
  );
});

test('no label reaches into the value column, on any row of any fixture', () => {
  for (const testCase of DATA_CASES) {
    const specs = allScreen.buildContainers(testCase.input);
    const card = byName(specs, 'card');
    const vals = byName(specs, 'cardVals');
    const labelX = card.x + insetOf(card);
    // The dim section labels share the same column and the same x, so they are held to it too.
    for (const label of [...lines(specs, 'card'), ...(specs.some((s) => s.name === 'secLabels') ? lines(specs, 'secLabels') : [])]) {
      assert.ok(
        labelX + Formatter.textWidth(label) < vals.x,
        `${testCase.name}: label "${label}" ends at ${labelX + Formatter.textWidth(label)}, value column starts at ${vals.x}`,
      );
    }
  }
});

test('T6b.2 — the label column is measured from candidates that carry no marker', () => {
  // Step ④: the column is re-measured after the `!` prefixes went, and `CLAUDE` is still the widest
  // candidate — which is why 68px did not move.
  assert.ok(!LABEL_CANDIDATES.some((c) => c.includes('!')), `a candidate still carries a marker: ${LABEL_CANDIDATES}`);
  const widest = LABEL_CANDIDATES.reduce((a, b) => (Formatter.textWidth(b) > Formatter.textWidth(a) ? b : a));
  assert.equal(widest, 'CLAUDE');
  assert.equal(Formatter.textWidth('CLAUDE'), 68);
  assert.equal(LABEL_COL_W, 68);
  // And every candidate really does fit the column it defines.
  for (const candidate of LABEL_CANDIDATES) {
    assert.equal(Formatter.fitLine(candidate, LABEL_COL_W), candidate, `"${candidate}" was clipped`);
  }
});

test('the footer status column holds every string it can ever be given, on one line', () => {
  // The reservation is what fixes the column's x, and `textContainerUpgrade` cannot move it (O1).
  // Reserving too little does not error — the text wraps inside a 27px-tall container and the
  // overflow is simply clipped, which is exactly how `stale 1000m` was lost before M6b moved the
  // staleness label out of this column altogether.
  const ftr = byName(allScreen.buildContainers(input({ statusNotice: REFRESHING })), 'ftrRight');
  const inner = innerWidthOf(ftr);
  for (const candidate of FOOTER_RIGHT_CANDIDATES) {
    assert.ok(
      Formatter.textWidth(candidate) <= inner,
      `"${candidate}" is ${Formatter.textWidth(candidate)}px, over the ${inner}px column`,
    );
    assert.equal(Formatter.measureLines(candidate, inner).lineCount, 1, `"${candidate}" wraps`);
  }
  // And `ok`/`stale …` are no longer among them: they live in the section rows now (§3, M6b).
  assert.ok(!FOOTER_RIGHT_CANDIDATES.some((c) => c === 'ok' || c.startsWith('stale ')));
});

test('a long outage renders as one unclipped section row', () => {
  // 16h40m offline — one night with the daemon down, the case the old three-digit reservation could
  // not hold. It is a section row now, so the check moves with it.
  const fetchedAt = DEMO_PAYLOAD.claude.fetchedAt!;
  const now = new Date(Date.parse(fetchedAt) + 1000 * 60_000);
  const specs = allScreen.buildContainers(input({ now }));
  // It is a DIM section row now (§7 "dim section rows"), in a container the same width as the percent
  // column's, so the reservation this test guards moved with it.
  const vals = byName(specs, 'secStatus');
  assert.equal(vals.content.split('\n')[0], '12:03 · stale 16h');
  assert.equal(Formatter.measureLines(vals.content.split('\n')[0], innerWidthOf(vals)).lineCount, 1);
});

test('the value column is declared after the card so the frame is not painted over it', () => {
  // zOrderIndex is all-or-nothing per page, so these two overlapping containers rely on
  // declaration order instead (glasses-ui skill): later declarations render on top.
  const specs = allScreen.buildContainers(input());
  const cardIdx = specs.findIndex((s) => s.name === 'card');
  const valsIdx = specs.findIndex((s) => s.name === 'cardVals');
  assert.ok(cardIdx >= 0 && valsIdx > cardIdx, 'cardVals must follow card');
});

test('the value column stays inside the card frame', () => {
  for (const testCase of DATA_CASES) {
    const specs = allScreen.buildContainers(testCase.input);
    const card = byName(specs, 'card');
    const vals = byName(specs, 'cardVals');
    const inset = insetOf(card);
    assert.ok(vals.x >= card.x + inset, `${testCase.name}: values start left of the card text area`);
    assert.ok(vals.x + vals.w <= card.x + card.w - inset, `${testCase.name}: values run past the frame`);
    assert.ok(vals.y >= card.y + inset, `${testCase.name}: values sit above the card text area`);
    assert.ok(vals.y + vals.h <= card.y + card.h - inset, `${testCase.name}: values run below the frame`);
    // Label rows and value rows must line up: same baseline, same number of rows.
    assert.equal(vals.y, card.y + inset, `${testCase.name}: value rows are off the label baseline`);
    assert.equal(vals.content.split('\n').length, card.content.split('\n').length);
  }
});

test('T6b.2 — the poll interval is the only setting a screen reads', () => {
  // The settings record is one field now, and changing it moves the §3 staleness verdict and nothing
  // else: the labels are identical at 3, 5 and 10 minutes, where a threshold setting would show.
  const labels = [3, 5, 10].map((pollIntervalMin) =>
    lines(allScreen.buildContainers(input({ settings: { pollIntervalMin } })), 'card').join('|'),
  );
  assert.equal(new Set(labels).size, 1, `the labels moved with the interval: ${labels.join(' vs ')}`);
  assert.deepEqual(lines(allScreen.buildContainers(input()), 'card'), ['', '5h', 'Week', 'Fable', '', '', 'Week']);
  // The known-good side: the interval DOES move the section row's verdict, so the field is live. 15
  // minutes after Codex's `fetchedAt` is past its 10-minute threshold at a 5-minute interval and
  // inside its 20-minute one at 10 (§3's table).
  const now = new Date('2026-09-07T11:56:00+10:00');
  const verdictAt = (pollIntervalMin: number) =>
    rowText(allScreen.buildContainers(input({ now, settings: { pollIntervalMin } })), 'secStatus', 5);
  assert.equal(verdictAt(5), '11:41 · stale 15m');
  assert.equal(verdictAt(10), '11:41 · ok');
});

test('no screen is ever blank — every page has content in every case (§6 rule 5)', () => {
  for (const screen of SCREENS) {
    for (const testCase of CASES) {
      const specs = screen.buildContainers(testCase.input);
      assert.ok(specs.length > 0);
      assert.ok(specs.every((s) => s.content.trim().length > 0), `${screen.id}/${testCase.name}`);
    }
  }
});

test('patch targets containers that mount actually creates', () => {
  for (const screen of SCREENS) {
    for (const testCase of CASES) {
      const mounted = screen.buildContainers(testCase.input);
      for (const update of screen.patch(testCase.input)) {
        const spec = mounted.find((s) => s.id === update.id && s.name === update.name);
        // textContainerUpgrade fails silently when the id/name pair does not match exactly.
        assert.ok(spec, `${screen.id}/${testCase.name}: patch targets unknown container ${update.id}/${update.name}`);
        assert.equal(spec.content, update.content);
      }
    }
  }
});

// ---- the eight-row ceiling ---------------------------------------------------

test('validatePage reports a container that holds more rows than the card can hold', () => {
  // A known-bad page: nine stacked rows cannot be centred between header and footer at all, so the
  // SDK would be handed containers off the canvas. The guard is what makes that visible in the log.
  const nineRows: TextSpec = {
    id: 1,
    name: 'card',
    x: 8,
    y: 0,
    w: 560,
    h: 261,
    content: Array.from({ length: 9 }, (_, i) => `row${i}`).join('\n'),
    capture: true,
  };
  assert.deepEqual(validatePage([nineRows]), [
    `container "card" holds 9 rows, over the ${MAX_CARD_ROWS}-row card limit`,
  ]);
  // Eight is legal, so the check cannot be passing by rejecting everything.
  assert.deepEqual(
    validatePage([{ ...nineRows, content: Array.from({ length: 8 }, (_, i) => `row${i}`).join('\n') }]),
    [],
  );
});

test('clampCardRows truncates to the eight rows the canvas can hold, and leaves the rest alone', () => {
  const nine = Array.from({ length: 9 }, (_, i) => i);
  assert.deepEqual(clampCardRows(nine), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(clampCardRows(nine).length, MAX_CARD_ROWS);
  assert.deepEqual(clampCardRows([1, 2, 3]), [1, 2, 3]);
});

test('a clamped ninth row is logged, not swallowed', () => {
  // The clamp runs BEFORE `validatePage` (the screen builds its rows, then the renderer validates
  // the containers), so `validatePage`'s row check can never see a ninth row that came through the
  // card path — it has already been cut off. Truncating is right (the page must still build), but
  // silence is not: this is the only place the layout bug can still become visible.
  const { result, logged } = captureErrors(() => clampCardRows(Array.from({ length: 9 }, (_, i) => i)));
  assert.equal(result.length, MAX_CARD_ROWS);
  assert.equal(logged.length, 1, `expected exactly one log line, got ${logged.length}`);
  assert.match(logged[0] ?? '', /QuotaLens/);
  // The count is what tells the reader how far over the limit the page went; "over the limit" alone
  // would not distinguish nine rows from ninety.
  assert.match(logged[0] ?? '', /\b9\b/);
  assert.match(logged[0] ?? '', new RegExp(`\\b${MAX_CARD_ROWS}\\b`));
  // The control: at or under the limit nothing is truncated and nothing is logged, so the assertion
  // above cannot be passing on a function that logs unconditionally.
  assert.deepEqual(captureErrors(() => clampCardRows([1, 2, 3])).logged, []);
  assert.deepEqual(captureErrors(() => clampCardRows(Array.from({ length: 8 }, (_, i) => i))).logged, []);
});

/** Collect what a body writes to `console.error`, one entry per call. */
function captureErrors<T>(body: () => T): { result: T; logged: string[] } {
  const real = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => void logged.push(args.map(String).join(' '));
  try {
    return { result: body(), logged };
  } finally {
    console.error = real;
  }
}

// ---- untrusted payload data cannot break the page ---------------------------

test('a hostile ext string cannot produce a container the SDK will refuse', () => {
  // `ext` is an open map by contract (§3), so this payload is schema-valid: the daemon is ours, but
  // the payload arrives over the network and the plugin validates SHAPE, not sanity. 2000 newlines
  // in `claudeScopedModel` built a 2008-character card — past the SDK's 1000-char cap, which
  // answers `StartUpPageCreateResult` 2 (oversize), i.e. no page at all. And the payload is cached
  // before it is drawn, so that blank screen came back on every restart.
  // `ext` is TOP-LEVEL on the payload (`shared/schema.ts`) and that is where the screen reads it
  // from. The first version of this test put it on `payload.claude`, which the screens never look
  // at — so it asserted the protection worked while exercising nothing at all.
  const hostile = { ...DEMO_PAYLOAD, ext: { claudeScopedModel: '\n'.repeat(2000) } };
  const specs = allScreen.buildContainers(input({ payload: hostile }));
  assert.deepEqual(validatePage(specs), [], 'the page is illegal before it ever reaches the bridge');
  for (const spec of specs) {
    assert.ok(
      spec.content.length <= MAX_CONTENT_CHARS,
      `container "${spec.name}" holds ${spec.content.length} chars`,
    );
  }
  // The card's row count is what a hostile `ext` would blow up: the label column has one line per
  // card row and no more, so 2000 newlines in a model name cannot add a single row. (Checking for
  // `\n\n` would not do it any more — §7 "section gap" and "dim section rows" put legitimate blank lines
  // next to each other.)
  assert.equal((specs.find((s) => s.name === 'card')?.content ?? '').split('\n').length, 7);
  // The whitespace-only name collapses to nothing and falls back to §3's default, on ONE line.
  assert.equal(specs.find((s) => s.name === 'card')?.content.split('\n')[3], 'Sonnet');
});

test('displayText keeps line breaks and drops every other control character', () => {
  // `\n` is the documented way to stack rows (glasses-ui) and the §7 "merged page" card is built out of it, so
  // banning control characters outright would have broken every card on the device.
  assert.equal(displayText('5h\nWeek\nFable'), '5h\nWeek\nFable');
  assert.equal(displayText('a\tb\rc'), 'a b c');
  assert.equal(displayText('x'.repeat(MAX_CONTENT_CHARS + 500)).length, MAX_CONTENT_CHARS);
});
