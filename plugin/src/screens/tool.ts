// QuotaLens plugin — the merged usage page (PLAN §7 "merged page", task M6b; §10.3(a) screen `all`).
//
// 2026-09-10 (owner-approved M6b): the glasses have ONE data page. Frames A and B are withdrawn and
// `activeTool` is gone — Claude and Codex are two SECTIONS of the same card, each introduced by a
// section row that carries that tool's own clock and its own §3 staleness verdict. A tool whose
// `source` is `"none"` contributes no section at all (§7 V1, re-judged).
//
// The card is THREE containers, not one. The label column has to hold a fixed x so the percentages
// and the bars beside it line up down the page — and a single left-aligned container in a
// non-monospaced font (O1/O3) cannot hold a column at all. So the framed container carries only the
// labels and unframed containers are laid over it at measured absolute x positions. They overlap on
// purpose; `zOrderIndex` stays unset everywhere (it is all-or-nothing per page) and declaration order
// puts the values on top of the frame. (§7 V3's `!` marker was the model's original reason; T6b.2
// withdrew the marker and §7 keeps the two-column model for the alignment it also buys.)
//
// §7 "bar alignment" (owner, on the device, 2026-09-10): the values are TWO columns, not one. While one
// container held `63% ████… resets 14:20`, the non-monospaced font made `8%` (26px), `63%` (38px)
// and `100%` (46px) different widths, so the bars stepped sideways from row to row — the design's
// vertically aligned bars are unreachable that way. The percentage therefore gets a column of its
// own, reserved at the width of `100%`, and the bar column starts at a fixed x past it. A section
// row's `HH:MM · ok` and the Credits row's `$4.20 left` stay in the percent column's x and run on
// under the bar column, which is empty on those rows; only percentages are held to that reservation.
//
// §7 "section gap"/"right-aligned percentages"/"dim section rows" (owner, 2026-09-10, third revision): the two
// sections are separated by one blank row whenever the total including it still fits eight rows; a
// percentage is right-aligned in its column by MEASURED padding (O3's one exception); and a section
// row is drawn at secondary brightness, which — since `textColor` cannot be patched — means two more
// containers, with the primary pair leaving those lines empty so nothing overprints.
//
// Container budget (O4 allows 8): header 1 + card 5 + footer 1 + the footer status column only when it
// has something to say = at most 8, i.e. the limit exactly. Anything added here from now on has to
// remove something first. The header's right-hand column is gone with the `●○`/clock it used to hold,
// and the status column, the bar column and the dim pair are absent while they would be blank —
// `validatePage` counts an empty container as a defect, so "leave it blank" means "do not build it".
import { EXT_CLAUDE_SCOPED_MODEL, type ToolId, type ToolUsage, type UsagePayload, type UsageWindow } from '@quotalens/shared';
import {
  BAR_CELLS,
  BAR_EMPTY,
  BAR_FILLED,
  Formatter,
  NO_CLOCK,
  RESET_WIDEST_LABELS,
  STALE_WIDEST_LABELS,
  WIDEST_DIGIT,
} from '../format.ts';
import {
  BODY_BOTTOM,
  BODY_TOP,
  BRIGHT_PRIMARY,
  BRIGHT_SECONDARY,
  CARD_BORDER,
  CARD_INNER_W,
  CARD_PADDING,
  CARD_RADIUS,
  CARD_W,
  CARD_X,
  clampCardRows,
  COLUMN_GAP,
  FOOTER_Y,
  HEADER_Y,
  LINE_H,
  MARGIN_X,
  MAX_CARD_ROWS,
  RIGHT_EDGE,
  rightColumn,
  type Screen,
  type ScreenInput,
  type TextSpec,
  type TextUpdate,
} from '../render.ts';

/** Drawing order of the two sections (§7 "merged page": CLAUDE first, then CODEX). */
export const TOOL_ORDER: readonly ToolId[] = ['claude', 'codex'];
/** §7 "merged page": the section row's label column. */
const SECTION_LABEL: Readonly<Record<ToolId, string>> = { claude: 'CLAUDE', codex: 'CODEX' };
/** Separator inside the section row's value: `HH:MM · ok`. `·` U+00B7 confirmed by the T3.1-G gate. */
const SECTION_SEP = ' · ';

const HEADER_LEFT = 'Agent usage';
/** §7 "merged page" footer: tap is Refresh and a long press opens the menu; there is no page to turn. */
const FOOTER_LEFT = 'tap refresh · hold menu';
/** §7 V2: CONNECTING shows one line in the card; never a blank screen (§6 rule 5). */
const CONNECTING_LINE = 'Connecting…';
const CONNECTING_ERROR_FALLBACK = 'net err';
/**
 * §7 V1, re-judged 2026-09-10: neither tool has ever fetched, so there is no section to draw and no
 * `--` placeholder row any more. Two lines that say so, and say what to do about it.
 */
export const NO_DATA_LINES: readonly string[] = ['No usage data', 'tap refresh'];
/**
 * §7 V7. Shown from the moment Refresh is pressed until that fetch ends; the App owns the lifetime
 * and hands it in as `ScreenInput.statusNotice`. It lives in the footer STATUS column (right).
 */
export const REFRESHING = 'refreshing…';
/**
 * §7 V9 (M6b). A swipe has nowhere to go now, so it answers in the footer-left slot at primary
 * brightness for two seconds. It arrives in `ScreenInput.notice`, the left slot's own field — the
 * page no longer has to tell it apart from §7 V7 by its text (2026-09-10 review).
 */
export const ONE_PAGE = 'one page · hold menu';
/** §7 V10: feedback when Refresh cannot run before a relay address exists. */
export const SET_ADDRESS_FIRST = 'set the address first';

const UNCONFIGURED_LINES = ['Set the relay address', 'in the Even App on your phone'] as const;
const UNCONFIGURED_FOOTER = 'hold menu';

/**
 * Everything §7 lets the footer STATUS column hold after M6b: the §7 V2 error codes and the §7 V7
 * notice. `ok`/`stale …` moved into the section rows, so they are no longer reserved here.
 */
export const FOOTER_RIGHT_CANDIDATES: readonly string[] = ['net err', '404', 'bad schema', REFRESHING];

/**
 * The column's x is fixed at mount time and `textContainerUpgrade` cannot move it (O1: no
 * right-alignment), so the reservation has to cover the longest string that can ever land here.
 */
const FOOTER_RIGHT = rightColumn(FOOTER_RIGHT_CANDIDATES);

/**
 * Every label the card can hold. `5h`/`Week`/`Credits` are fixed by §7; the third Claude row is named
 * by the server (`ext.claudeScopedModel`), so the model display names it can currently return are
 * listed here rather than guessed at with an arbitrary margin. The two SECTION labels are in the same
 * column, so they are measured with the rest of them.
 *
 * A longer name than any of these is clipped by `fitLine` — losing a character off a model name is
 * the cheap failure; letting the label push into the value column would misalign every row below it.
 */
export const LABEL_CANDIDATES: readonly string[] = [
  '5h',
  'Week',
  'Credits',
  'Sonnet',
  'Fable',
  'Haiku',
  'Opus',
  SECTION_LABEL.claude,
  SECTION_LABEL.codex,
];
/**
 * 68px (re-measured 2026-09-10 after T6b.2 dropped the `!` prefixes): `CLAUDE` is the widest label
 * and the column width is unchanged, because `CLAUDE` was already wider than `!Sonnet`'s 65.
 */
export const LABEL_COL_W = Formatter.widestWidth(LABEL_CANDIDATES);
/**
 * Gap between the two columns, in measured pixels. The space glyph is the unit of measurement
 * here, not a padding character — O3 forbids spelling this gap with actual spaces in the content.
 */
const LABEL_COL_GAP = Formatter.textWidth(' ') * 2;

/** Absolute x/y of the card's text area, i.e. inside both the border and the padding. */
const CARD_TEXT_X = CARD_X + CARD_BORDER + CARD_PADDING;
const CARD_TEXT_RIGHT = CARD_X + CARD_W - CARD_BORDER - CARD_PADDING;
export const VALUE_COL_X = CARD_TEXT_X + LABEL_COL_W + LABEL_COL_GAP;
/**
 * 464px: 542 (card text width) − 68 (label column) − 10 (gap).
 *
 * This is the width of the percent CONTAINER, which runs all the way to the card's right text edge
 * so the wide lines that share it — a section row's `HH:MM · ok`, the Credits row's `$4.20 left` —
 * have room to finish. It is NOT the width a percentage may occupy; that is `PCT_COL_W` (§7
 * "bar alignment").
 */
export const VALUE_COL_W = CARD_TEXT_RIGHT - VALUE_COL_X;

/**
 * §7 "bar alignment": the visible percent column, 46px — the measured width of every label
 * `Formatter.pctLabel` can return, which is `100%`.
 *
 * Reserving the maximum is the whole point: the bar column's x is fixed at mount time (O1 offers no
 * alignment of any kind), so a percentage that grew past its reservation would collide with the bar
 * instead of pushing it. 0–100 are all measured rather than assuming `100%` is widest.
 */
export const PCT_COL_W = Formatter.widestWidth(Array.from({ length: 101 }, (_, pct) => Formatter.pctLabel(pct)));
/** More spaces than can ever fit the column, so the search below cannot miss the best count. */
const PCT_PAD_MAX_SPACES = Math.ceil(PCT_COL_W / Formatter.textWidth(' ')) + 1;

/**
 * §7 "right-aligned percentages" (owner 2026-09-10) + O3's exception: right-align a percentage inside the 46px
 * percent column by prefixing MEASURED spaces, because a container has no alignment option (O1) and
 * one container per row would break O4.
 *
 * PLAN §7 writes the count as `round((PCT_COL_W − width(text)) / width(' '))`, which assumes the
 * widths add up. They do not: pretext rounds every glyph's advance individually and applies kerning
 * (`node_modules/@evenrealities/pretext/dist/font_measure.js:26881`, `getAdvWPx` =
 * `(raw + kern + 8) >> 4`), so four spaces before `5%` measure 47px where the arithmetic says 46, and
 * PLAN's count for `63%` lands 3px past the column — outside PLAN's own ≤ half-a-space bound. Each
 * candidate count is therefore MEASURED and the closest one wins: at most 2px from the column's right
 * edge, where the formula reaches 3px. Still not a character count (O3): the count comes out of
 * `getTextWidth`, and this is the exception O3's table records.
 */
export function padPercent(text: string, target: number = PCT_COL_W): string {
  let best = text;
  let bestGap = Math.abs(target - Formatter.textWidth(text));
  for (let spaces = 1; spaces <= PCT_PAD_MAX_SPACES; spaces += 1) {
    const candidate = ' '.repeat(spaces) + text;
    const gap = Math.abs(target - Formatter.textWidth(candidate));
    // Strictly better only, so a tie keeps the shorter string.
    if (gap < bestGap) {
      bestGap = gap;
      best = candidate;
    }
  }
  return best;
}

/**
 * How far below / above the column a padded percentage may end when it is being aligned with the
 * others on its page. Below: the column is 46px and the narrowest value (`1%`, 22px) needs headroom
 * to meet the widest (`100%`, 46px) somewhere both can reach. Above: it must stay clear of the bar.
 */
const PCT_ALIGN_MIN = PCT_COL_W - 12;
const PCT_ALIGN_MAX = PCT_COL_W + 4;

/** Every padding of one value whose width falls in the alignment window, narrowest first. */
function percentCandidates(text: string): Array<{ width: number; padded: string }> {
  const out: Array<{ width: number; padded: string }> = [];
  for (let spaces = 0; spaces <= PCT_PAD_MAX_SPACES; spaces += 1) {
    const padded = ' '.repeat(spaces) + text;
    const width = Formatter.textWidth(padded);
    if (width >= PCT_ALIGN_MIN && width <= PCT_ALIGN_MAX) out.push({ width, padded });
  }
  return out.sort((a, b) => a.width - b.width);
}

/**
 * §7 "right-aligned percentages", second pass (owner on the device, 2026-09-10): the percentages on ONE page share
 * one right edge as nearly as the font allows.
 *
 * Padding each value to the column's width on its own left `9%` at 47px, `81%` at 44px and `17%` at
 * 47px — the owner saw the `9%` sit to the right of the other two. The cause is arithmetic, not a
 * bug: the space is 5px, `1` is 8px where every other digit is 12–13px, and the font has no thinner
 * blank (thin/hair/figure spaces are all missing glyphs, measured). So the paddings are chosen
 * JOINTLY: every value's reachable widths are listed, and for each possible narrowest width the
 * others take their smallest width at or above it — the assignment with the smallest spread wins
 * (ties: the one closest to the column). Measured over every pair of percentages the spread is
 * ≤ 2px. A whole page is bounded by one blank plus kerning — 6px — and no tighter number is
 * promised: sampled triples reach 3px (`0% / 7% / 13%`), five- and six-value pages 4px
 * (`0% / 1% / 2% / 25% / 91%`), because a 5px blank cannot split the 1px between a 12px and a 13px
 * digit. `screens.test.ts` measures the pair bound exhaustively and the page bound by sampling.
 *
 * ponytail: at most six values with ≤ 4 candidates each — a few dozen comparisons per render. The
 * ceiling is a font with an odd-width blank glyph; the upgrade is a second padding glyph in
 * `percentCandidates`.
 */
export function alignPercents(texts: readonly string[]): string[] {
  if (texts.length === 0) return [];
  const candidates = texts.map(percentCandidates);
  const floors = [...new Set(candidates.flat().map((c) => c.width))].sort((a, b) => a - b);
  let best: string[] | null = null;
  let bestSpread = Number.POSITIVE_INFINITY;
  let bestDrift = Number.POSITIVE_INFINITY;
  for (const floor of floors) {
    const picks = candidates.map((list) => list.find((c) => c.width >= floor));
    if (picks.some((pick) => pick === undefined)) continue;
    const widths = picks.map((pick) => pick!.width);
    const spread = Math.max(...widths) - floor;
    const drift = Math.max(...widths.map((width) => Math.abs(width - PCT_COL_W)));
    if (spread < bestSpread || (spread === bestSpread && drift < bestDrift)) {
      best = picks.map((pick) => pick!.padded);
      bestSpread = spread;
      bestDrift = drift;
    }
  }
  // Unreachable with the window above (every value has at least one candidate), kept as the honest
  // fallback: pad one by one rather than draw nothing.
  return best ?? texts.map((text) => padPercent(text));
}

/**
 * The widest a PADDED percentage can measure, over all 101 of them and every width `alignPercents`
 * may pick (`PCT_ALIGN_MAX`).
 *
 * Past `PCT_COL_W` by the kerning the padding cannot divide away plus the alignment headroom (see
 * `padPercent` / `alignPercents`). It is what percentage lines are clipped to — clipping them at 46px
 * instead would make `fitLine` eat the `%` off two thirds of the values. The number that has to hold
 * is not this one but the bar column's x: a padded percentage must end short of `BAR_COL_X`, so the
 * bars keep the single x §7 "bar alignment" asks for. `screens.test.ts` holds it against exactly that.
 */
export const PCT_PADDED_W = Math.max(
  Formatter.widestWidth(Array.from({ length: 101 }, (_, pct) => padPercent(Formatter.pctLabel(pct)))),
  PCT_ALIGN_MAX,
);

/** §7 "bar alignment": 95 + 46 + 10 = 151. One gap past the percent column, measured like the other. */
export const BAR_COL_X = VALUE_COL_X + PCT_COL_W + LABEL_COL_GAP;
/** 408px: 559 (card right text edge) − 151, against a 402px widest bar line. */
export const BAR_COL_W = CARD_TEXT_RIGHT - BAR_COL_X;

/**
 * Every string the bar column can hold, at its widest: a 12-cell bar on its own (§7 V4, where the
 * server sent no reset time) or a bar plus the widest `resets …` the formatter can produce.
 *
 * All thirteen bar shapes are included rather than one: `█` and `▒` measure the same 20px today,
 * and this is what would catch a firmware font where they do not. §7 quotes 394px for
 * `████████████ resets Thu 09:00`; the widest over every weekday and every digit is 402px, and the
 * layout test holds the column against THAT (68 + 10 + 46 + 10 + 402 = 536 ≤ 542).
 */
export const BAR_COL_CANDIDATES: readonly string[] = Array.from(
  { length: BAR_CELLS + 1 },
  (_, filled) => BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_CELLS - filled),
).flatMap((bar) => [bar, ...RESET_WIDEST_LABELS.map((suffix) => `${bar} ${suffix}`)]);

/**
 * Every string a section row's value can be, at its widest. It shares the percent container with the
 * percentages but is not held to the 46px percent column — §7 "bar alignment" lets these lines run on to
 * the card's right text edge, because the bar column is empty on the rows that carry them. So this
 * is a check rather than a reservation, and the layout test holds it against `VALUE_COL_W`.
 */
export const SECTION_VALUE_CANDIDATES: readonly string[] = (() => {
  const widestClock = `${WIDEST_DIGIT}${WIDEST_DIGIT}:${WIDEST_DIGIT}${WIDEST_DIGIT}`;
  const verdicts = ['ok', ...STALE_WIDEST_LABELS];
  return [widestClock, NO_CLOCK].flatMap((clock) => verdicts.map((v) => `${clock}${SECTION_SEP}${v}`));
})();

/** One card row, split at the two column boundaries §7 "merged page" and §7 "bar alignment" ask for. */
interface CardRow {
  label: string;
  /** The percent column's text: a percentage, or a wide line that runs on under the bar column. */
  value: string;
  /**
   * §7 "dim section rows": this is a SECTION row, so its `label` and `value` are drawn by the two dim
   * containers and the primary pair leaves those lines empty. Never both — one line, one container.
   */
  section: boolean;
  /**
   * The bar column's text — the 12-cell bar and §7 V4's `resets …` suffix. `''` on a row that has no
   * bar, which is every row where `wide` is true.
   */
  bar: string;
  /**
   * `true` = `value` is one of the wide lines that share the percent container (a section row's
   * `HH:MM · ok`, the Credits row's `$4.20 left`), so it is clipped to the container's full width.
   * `false` = a percentage, clipped to `PCT_COL_W` so that the bars beside it all begin at one x.
   *
   * An explicit field rather than `bar === ''`: a future row with a percentage and no bar would
   * otherwise be clipped to the wide width and reach into the bar column, silently.
   */
  wide: boolean;
  /** A percentage row: `value` is the raw label until `alignPercentRows` pads the page's set. */
  pct?: boolean;
}

/**
 * §3: `ext.claudeScopedModel` names Claude's third row; fall back to `Sonnet` when absent.
 *
 * `ext` is an open map by contract — anything the daemon puts there is schema-valid — and this is
 * the only place its contents reach the canvas. So it is trimmed and bounded HERE, at the display
 * boundary: 16 characters is longer than any name the server has returned (T1.3 measured `Fable`)
 * and short enough that the label column cannot grow into the value column beside it.
 */
export const MAX_MODEL_LABEL = 16;

function scopedModelLabel(ext: Record<string, unknown> | undefined): string {
  const value = ext?.[EXT_CLAUDE_SCOPED_MODEL];
  if (typeof value !== 'string') return 'Sonnet';
  const cleaned = value.replace(/\s+/g, ' ').trim();
  return cleaned.length === 0 ? 'Sonnet' : cleaned.slice(0, MAX_MODEL_LABEL);
}

/**
 * §7 V1 (re-judged) / §3: which tools this page draws a section for.
 *
 * The single definition of "rendered tools", because §10.3(a) derives LIVE/STALE from exactly this set
 * — `app.ts` asks this function rather than repeating the `source === 'none'` test, so the machine
 * can never disagree with the page about which tools are on screen.
 */
export function drawnTools(payload: UsagePayload | null): ToolId[] {
  if (payload === null) return [];
  return TOOL_ORDER.filter((tool) => payload[tool].source !== 'none');
}

/**
 * §7 "merged page": the section row. Time = that tool's own `fetchedAt` under §7 V6's truncation, verdict
 * = §3's staleness for that tool. It starts at the value column's x like every other value: §7 is
 * explicit that it is NOT flush right, because `ok` ↔ `stale Xm` would then need a rebuild every
 * time it changed (O1 gives no right-alignment, so the box's x is fixed at mount).
 */
function sectionRow(tool: ToolId, usage: ToolUsage, input: ScreenInput): CardRow {
  const verdict = Formatter.staleLabel(tool, usage.fetchedAt, input.now, input.settings.pollIntervalMin);
  return {
    label: SECTION_LABEL[tool],
    // §7 "bar alignment": it stays in the percent column's x and runs on under the (empty) bar column.
    // §7 "right-aligned percentages" is explicit that this line is NOT padded — it starts at the column's x.
    value: `${Formatter.clockLabel(usage.fetchedAt)}${SECTION_SEP}${verdict}`,
    section: true,
    bar: '',
    wide: true,
  };
}

/**
 * §7 "section gap" (owner 2026-09-10): the blank row between two sections. Blank in every one of the
 * five card containers, and a row like any other as far as the eight-row limit and the card's height
 * are concerned.
 */
const GAP_ROW: CardRow = { label: '', value: '', section: false, bar: '', wide: true };

/**
 * One window row, or `null` when the window is absent — §3 hides the whole row rather than
 * printing a placeholder (the owner's Codex account has no 5h window at all).
 */
function windowRow(label: string, window: UsageWindow | null, now: Date): CardRow | null {
  if (window === null) return null;
  const suffix = Formatter.resetLabel(window.resetsAt, now); // '' when the server sent none (V4)
  // §7 "bar alignment": the percentage and the bar go to different containers, so the space that used to
  // join them is gone — the gap between them is `LABEL_COL_GAP` measured pixels now, not a glyph.
  const bar = Formatter.bar(window.usedPct);
  return {
    label,
    // §7 "right-aligned percentages": the RAW label here; `alignPercents` pads every percentage on the page
    // together, once the page's set is known (`view`), so they share one right edge.
    value: Formatter.pctLabel(window.usedPct),
    section: false,
    bar: suffix === '' ? bar : `${bar} ${suffix}`,
    wide: false,
    pct: true,
  };
}

/** §7 "right-aligned percentages": pad the page's percentages as a set, leaving every other row as it is. */
function alignPercentRows(rows: readonly CardRow[]): CardRow[] {
  const padded = alignPercents(rows.filter((row) => row.pct === true).map((row) => row.value));
  let next = 0;
  return rows.map((row) => (row.pct === true ? { ...row, value: padded[next++] ?? row.value } : row));
}

/** §7's Codex third row. Credits are a balance, not a percentage, so they get no bar. */
function creditsRow(usage: ToolUsage): CardRow | null {
  if (usage.credits === null) return null;
  // Not a percentage, so §7 "bar alignment" leaves it in the percent container at full width, like a
  // section row: `$4.20 left` is 90px, well past the 46px a percentage is held to — and
  // §7 "right-aligned percentages" leaves it unpadded for the same reason.
  return {
    label: 'Credits',
    value: `$${usage.credits.remainingUsd.toFixed(2)} left`,
    section: false,
    bar: '',
    wide: true,
  };
}

/** The data rows of one section, in §7 order. A null window contributes nothing (§3). */
function dataRows(tool: ToolId, usage: ToolUsage, input: ScreenInput, scopedModel: string): CardRow[] {
  const rows =
    tool === 'claude'
      ? [
          windowRow('5h', usage.fiveHour, input.now),
          windowRow('Week', usage.weekly, input.now),
          windowRow(scopedModel, usage.weeklySonnet, input.now),
        ]
      : [windowRow('5h', usage.fiveHour, input.now), windowRow('Week', usage.weekly, input.now), creditsRow(usage)];
  return rows.filter((row): row is CardRow => row !== null);
}

/** Container identity is fixed per page so `textContainerUpgrade` can find them again. */
const ID = { hdrLeft: 1, card: 3, cardVals: 4, cardBars: 7, secLabels: 8, secStatus: 9, ftrLeft: 5, ftrRight: 6 } as const;
const NAME = {
  hdrLeft: 'hdrLeft',
  card: 'card',
  cardVals: 'cardVals',
  cardBars: 'cardBars',
  secLabels: 'secLabels',
  secStatus: 'secStatus',
  ftrLeft: 'ftrLeft',
  ftrRight: 'ftrRight',
} as const;

/**
 * The card's containers in DECLARATION order (§7 "dim section rows"): the frame and the label column
 * first, then the three columns laid over it, then the two dim section columns. `zOrderIndex` is
 * all-or-nothing per page, so this order is the only z-ordering the page has — and it is exported so
 * the tests can walk "every card container" without a second, drifting list.
 */
export const CARD_CONTAINERS: readonly string[] = [
  NAME.card,
  NAME.cardVals,
  NAME.cardBars,
  NAME.secLabels,
  NAME.secStatus,
];

interface AllView {
  /**
   * Card lines that are NOT split into columns — §7 V2's `Connecting…` and §7 V1's two-line
   * "no usage data" card. `null` means the card is a label/value pair of columns as usual.
   */
  plainLines: readonly string[] | null;
  /** Optional dim overlay for a plain card, aligned line-for-line with `plainLines`. */
  plainSecondary: readonly string[] | null;
  rows: CardRow[];
  /** §7 V9 replaces the footer-left hint, at primary brightness, for two seconds. */
  footerLeft: string;
  footerLeftPrimary: boolean;
  /** §7 V2 / V7. `null` = the column has nothing to say, so it is not built at all. */
  footerRight: string | null;
}

function view(input: ScreenInput): AllView {
  // Two slots, two fields, two lifetimes: §7 V9 in the footer-left hint slot and §7 V7 in the status
  // column. They used to share one field and be told apart by string identity, which meant raising
  // either one silently took the other down (2026-09-10 review).
  const notice = input.notice ?? null;
  const statusNotice = input.statusNotice ?? null;
  const footerLeft = notice ?? FOOTER_LEFT;
  const noticeShown = notice !== null;
  const payload = input.payload;

  // §7 V10 outranks cache: the first line stays in the framed primary container, while the second
  // uses the existing dim overlay identity because one container cannot mix text brightness.
  if (input.unconfigured === true) {
    return {
      plainLines: [UNCONFIGURED_LINES[0], ''],
      plainSecondary: ['', UNCONFIGURED_LINES[1]],
      rows: [],
      footerLeft: notice ?? UNCONFIGURED_FOOTER,
      footerLeftPrimary: noticeShown,
      footerRight: null,
    };
  }

  // §7 V2: nothing cached and nothing fetched. The card still says something (§6 rule 5) and the
  // status column carries the short code — or the §7 V7 notice, which outranks it: a Refresh pressed
  // while CONNECTING would otherwise leave the error code up and read as no feedback at all.
  if (payload === null) {
    return {
      plainLines: [CONNECTING_LINE],
      plainSecondary: null,
      rows: [],
      footerLeft,
      footerLeftPrimary: noticeShown,
      footerRight: statusNotice ?? input.errorCode ?? CONNECTING_ERROR_FALLBACK,
    };
  }

  const drawn = drawnTools(payload);
  // §7 V1 (re-judged): both tools have never fetched, so there is no section and no staleness.
  if (drawn.length === 0) {
    return { plainLines: NO_DATA_LINES, plainSecondary: null, rows: [], footerLeft, footerLeftPrimary: noticeShown, footerRight: statusNotice };
  }

  const scopedModel = scopedModelLabel(payload.ext);
  const sections = drawn.map((tool) => [
    sectionRow(tool, payload[tool], input),
    ...dataRows(tool, payload[tool], input, scopedModel),
  ]);
  // §7 "section gap": one blank row between sections — but only while the total INCLUDING the blanks
  // still fits the eight rows the canvas can hold. The 3+3 worst case is already exactly eight, so it
  // gets none; a single section has nothing to separate.
  const withGaps = sections.reduce((n, section) => n + section.length, 0) + sections.length - 1;
  const rows =
    withGaps <= MAX_CARD_ROWS
      ? sections.flatMap((section, i) => (i === 0 ? section : [GAP_ROW, ...section]))
      : sections.flat();
  return {
    plainLines: null,
    plainSecondary: null,
    // 2 sections + 3 + 3 = 8 is the most the §3 contract can produce, which is exactly the canvas's
    // capacity; the clamp is what keeps a ninth row from placing containers off the canvas.
    // §7 "right-aligned percentages": padded as a SET, once the page's percentages are all known.
    rows: clampCardRows(alignPercentRows(rows)),
    footerLeft,
    footerLeftPrimary: noticeShown,
    footerRight: statusNotice,
  };
}

/**
 * The framed container's text: either the unsplit lines, or the label column.
 *
 * §7 "dim section rows": a section row's label belongs to `secLabels` at secondary brightness, so this
 * container leaves that line EMPTY. Two containers with text on one line would overprint.
 *
 * ponytail: a tool drawn with no window and no credits at all (schema-valid: §3 makes every window
 * nullable) contributes a section row and no data row, so a page whose only tool is that one leaves
 * this container with nothing but empty lines — `validatePage` then logs one "empty content" line.
 * The page still builds and the glasses still show that section through `secLabels`, so it is a log
 * defect, not a blank screen. The upgrade path, if the owner ever sees it: let `validatePage` accept
 * empty content on a container that draws a border, since the frame is content of its own.
 */
function cardContent(v: AllView): string {
  if (v.plainLines !== null) return v.plainLines.map((line) => Formatter.fitLine(line, CARD_INNER_W)).join('\n');
  return v.rows.map((row) => (row.section ? '' : Formatter.fitLine(row.label, LABEL_COL_W))).join('\n');
}

/**
 * The percent container's text. §7 "bar alignment": a percentage is clipped to the percent column so it
 * can never reach the bar beside it; the wide lines that share this container are clipped to the whole
 * width, which is where they were already being clipped before the split. Section rows are empty here
 * for the same reason as in `cardContent` — `secStatus` draws them.
 *
 * The percentage budget is `PCT_PADDED_W`, not `PCT_COL_W`: the measured padding from §7 "right-aligned percentages"
 * can measure up to 2px past the 46px reservation, and clipping at 46 would eat the `%` off most of
 * the values. Both numbers are still well short of `BAR_COL_X`, which is the boundary that matters.
 */
function valuesContent(v: AllView): string {
  return v.rows
    .map((row) => (row.section ? '' : Formatter.fitLine(row.value, row.wide ? VALUE_COL_W : PCT_PADDED_W)))
    .join('\n');
}

/**
 * §7 "dim section rows" (owner 2026-09-10, on the device — this overturns the same day's "not yet"):
 * the section rows, at secondary brightness, in two containers that mirror the label and percent
 * columns line for line. Text on the section rows only; every other line is empty, which is what puts
 * `CLAUDE` on the same baseline the primary containers left blank for it.
 */
function secLabelsContent(v: AllView): string {
  if (v.plainSecondary !== null) {
    return v.plainSecondary.map((line) => Formatter.fitLine(line, CARD_INNER_W)).join('\n');
  }
  return v.rows.map((row) => (row.section ? Formatter.fitLine(row.label, LABEL_COL_W) : '')).join('\n');
}

function secStatusContent(v: AllView): string {
  return v.rows.map((row) => (row.section ? Formatter.fitLine(row.value, VALUE_COL_W) : '')).join('\n');
}

/**
 * Is there a section row to draw at all? §7 V2's `Connecting…` and §7 V1's two-line card are plain
 * lines with no sections, and an all-empty container is a `validatePage` defect — same rule as the bar
 * column and the footer status column: "leave it blank" means "do not build it".
 */
function hasSections(v: AllView): boolean {
  return v.rows.some((row) => row.section);
}

/**
 * The bar container's text, one line per card row so the rows stay aligned across all three
 * containers. A row with no bar contributes an EMPTY line, which is what holds that alignment.
 */
function barsContent(v: AllView): string {
  return v.rows.map((row) => Formatter.fitLine(row.bar, BAR_COL_W)).join('\n');
}

/**
 * Is there anything for the bar column to draw?
 *
 * A page can legitimately have none — a Codex section whose only row is Credits — and then every
 * line of `barsContent` is empty. That container must not be built at all (§6 rule 5), and the check
 * has to be HERE: `validatePage` rejects content of length zero, and `'\n'` is blank without being
 * length zero, so it would let this one through. Same rule as the footer status column: "leave it
 * blank" means "do not build it".
 */
function hasBars(v: AllView): boolean {
  return v.rows.some((row) => row.bar !== '');
}

const HEADER_LEFT_W = RIGHT_EDGE - MARGIN_X;
const FOOTER_LEFT_W = FOOTER_RIGHT.x - COLUMN_GAP - MARGIN_X;

export const allScreen: Screen = {
  id: 'all',

  buildContainers(input: ScreenInput): TextSpec[] {
    const v = view(input);
    const rowCount = v.plainLines !== null ? v.plainLines.length : v.rows.length;
    // The card grows with its rows (one tool, or a tool with a single window), so it is centred in
    // the band between header and footer instead of being pinned to a fixed y. At the eight-row
    // maximum that puts it at y=27 with height 234, filling the band exactly (§7 "merged page").
    const cardH = rowCount * LINE_H + 2 * (CARD_PADDING + CARD_BORDER);
    const cardY = BODY_TOP + Math.round((BODY_BOTTOM - BODY_TOP - cardH) / 2);

    const card: TextSpec = {
      id: ID.card,
      name: NAME.card,
      x: CARD_X,
      y: cardY,
      w: CARD_W,
      h: cardH,
      content: cardContent(v),
      border: CARD_BORDER,
      radius: CARD_RADIUS,
      padding: CARD_PADDING,
      brightness: BRIGHT_PRIMARY,
      capture: true,
    };

    // Overlaid on the card at the fixed value-column x. No border and no padding, so its own
    // text starts exactly at `VALUE_COL_X` and its first line shares the card's text baseline.
    const cardTextY = cardY + CARD_BORDER + CARD_PADDING;
    const values: TextSpec = {
      id: ID.cardVals,
      name: NAME.cardVals,
      x: VALUE_COL_X,
      y: cardTextY,
      w: VALUE_COL_W,
      h: rowCount * LINE_H,
      content: valuesContent(v),
      // §7 "dim section rows" (owner 2026-09-10, third revision): data rows are primary here; the
      // section rows are blank in this container and drawn by `secLabels` / `secStatus` below at
      // BRIGHT_SECONDARY, so one line is ever owned by one container.
      brightness: BRIGHT_PRIMARY,
    };

    // §7 "bar alignment": the bars, at their own fixed x past the percent column's reservation. Same y,
    // same row count and the same `\n` mechanism as the other two, which is what keeps the three
    // columns on shared baselines.
    const bars: TextSpec = {
      id: ID.cardBars,
      name: NAME.cardBars,
      x: BAR_COL_X,
      y: cardTextY,
      w: BAR_COL_W,
      h: rowCount * LINE_H,
      content: barsContent(v),
      brightness: BRIGHT_PRIMARY,
    };

    // §7 "dim section rows": the section rows, dim, in the same two columns and on the same baselines as
    // the primary label and percent containers. `textContainerUpgrade` cannot change `textColor`, so a
    // second brightness has to be a second pair of containers — which is what takes this page to
    // 8 = O4's limit exactly.
    const secLabels: TextSpec = {
      id: ID.secLabels,
      name: NAME.secLabels,
      x: CARD_TEXT_X,
      y: cardTextY,
      w: v.plainSecondary === null ? LABEL_COL_W : CARD_INNER_W,
      h: rowCount * LINE_H,
      content: secLabelsContent(v),
      brightness: BRIGHT_SECONDARY,
    };
    const secStatus: TextSpec = {
      id: ID.secStatus,
      name: NAME.secStatus,
      x: VALUE_COL_X,
      y: cardTextY,
      w: VALUE_COL_W,
      h: rowCount * LINE_H,
      content: secStatusContent(v),
      brightness: BRIGHT_SECONDARY,
    };

    return [
      {
        id: ID.hdrLeft,
        name: NAME.hdrLeft,
        x: MARGIN_X,
        y: HEADER_Y,
        w: HEADER_LEFT_W,
        h: LINE_H,
        content: Formatter.fitLine(HEADER_LEFT, HEADER_LEFT_W),
        brightness: BRIGHT_SECONDARY,
      },
      card,
      // Declared after the card on purpose: with zOrderIndex unset page-wide, the later
      // declaration renders on top, so the frame never paints over the values.
      ...(v.plainLines !== null ? [] : [values]),
      // And the bars after the values, for the same reason. Their boxes overlap (the percent
      // container runs to the card's right edge so its wide lines have room), but never their text:
      // the bar column is empty on exactly the rows whose percent line is wide.
      ...(v.plainLines === null && hasBars(v) ? [bars] : []),
      // The dim pair last, in the order from §7 "dim section rows". Their boxes overlap the primary pair
      // exactly, and their text never does: each line belongs to one container or the other.
      ...(v.plainSecondary !== null ? [secLabels] : v.plainLines === null && hasSections(v) ? [secLabels, secStatus] : []),
      {
        id: ID.ftrLeft,
        name: NAME.ftrLeft,
        x: MARGIN_X,
        y: FOOTER_Y,
        w: FOOTER_LEFT_W,
        h: LINE_H,
        content: Formatter.fitLine(v.footerLeft, FOOTER_LEFT_W),
        // §7 V9: the swipe answer is primary, the standing hint secondary. `textContainerUpgrade`
        // cannot change `textColor`, which is why raising this notice costs a rebuild — the App's
        // structural comparison sees the brightness change and upgrades the patch by itself.
        brightness: v.footerLeftPrimary ? BRIGHT_PRIMARY : BRIGHT_SECONDARY,
      },
      // §7 "merged page": the status column holds V7 and V2 and nothing else, so most of the time it is
      // not there at all. An empty container is a `validatePage` defect, not a blank slot.
      ...(v.footerRight === null
        ? []
        : [
            {
              id: ID.ftrRight,
              name: NAME.ftrRight,
              x: FOOTER_RIGHT.x,
              y: FOOTER_Y,
              w: FOOTER_RIGHT.w,
              h: LINE_H,
              // fitLine is the structural guard: the reservation above is meant to cover every
              // string that can land here, but a clipped line beats a wrapped one if that set grows.
              content: Formatter.fitLine(v.footerRight, FOOTER_RIGHT.w),
              brightness: BRIGHT_SECONDARY,
            },
          ]),
    ];
  },

  /**
   * The fields that change while the page stays up. Valid only while the container SET and the
   * geometry are unchanged — a different row count, the CONNECTING/data split, the §7 V9 brightness
   * change, and either the status column or the bar column appearing or disappearing all need a
   * `rebuildPageContainer`, which the App's structural comparison (T3.4) detects and upgrades to a
   * mount.
   */
  patch(input: ScreenInput): TextUpdate[] {
    const v = view(input);
    const updates: TextUpdate[] = [{ id: ID.card, name: NAME.card, content: cardContent(v) }];
    if (v.plainLines === null) {
      updates.push({ id: ID.cardVals, name: NAME.cardVals, content: valuesContent(v) });
      // Only when it was mounted. A page whose bar column is entirely empty does not build one, and
      // `textContainerUpgrade` fails silently against a container that is not there.
      if (hasBars(v)) updates.push({ id: ID.cardBars, name: NAME.cardBars, content: barsContent(v) });
      // Same rule for the dim pair: they exist only while there is a section row to put in them, and
      // their text changes on every tick that moves a `stale Xm` counter.
      if (hasSections(v)) {
        updates.push({ id: ID.secLabels, name: NAME.secLabels, content: secLabelsContent(v) });
        updates.push({ id: ID.secStatus, name: NAME.secStatus, content: secStatusContent(v) });
      }
    } else if (v.plainSecondary !== null) {
      updates.push({ id: ID.secLabels, name: NAME.secLabels, content: secLabelsContent(v) });
    }
    updates.push({
      id: ID.ftrLeft,
      name: NAME.ftrLeft,
      content: Formatter.fitLine(v.footerLeft, FOOTER_LEFT_W),
    });
    if (v.footerRight !== null) {
      updates.push({
        id: ID.ftrRight,
        name: NAME.ftrRight,
        content: Formatter.fitLine(v.footerRight, FOOTER_RIGHT.w),
      });
    }
    return updates;
  },
};
