// QuotaLens plugin — pure text formatting for the G2 screens (PLAN §7, §10.2 `Formatter`).
//
// This module is the ONLY place allowed to touch glyph-width computation (§10.2 design note):
// `@evenrealities/pretext` is imported here and nowhere else, and the layout code in render.ts /
// screens/ asks this module for widths. The G2 font is not monospaced (official limit O3), so
// every column position downstream is a measured pixel value, never a space count.
import { getTextWidth, measureTextWrap, pxTruncate } from '@evenrealities/pretext';
import { staleThresholdMin, type ToolId } from '@quotalens/shared';

/** Progress-bar glyphs, both confirmed present on the firmware font by the T3.1-G gate. */
export const BAR_FILLED = '█'; // U+2588
export const BAR_EMPTY = '▒'; // U+2592
export const BAR_CELLS = 12;

/** §7 V1: a tool that has never fetched shows `--` in place of every number. */
export const NO_VALUE = '--';
/** §7 V1 / V6: header clock with no `fetchedAt` behind it. */
export const NO_CLOCK = '--:--';

/**
 * The widest digit in the firmware font, measured rather than assumed — digits are not equal width
 * (O3). Reserved right-hand columns are sized with it so a clock or a counter can never outgrow
 * its box after `textContainerUpgrade` has already fixed the box's x.
 */
export const WIDEST_DIGIT = '0123456789'
  .split('')
  .reduce((widest, d) => (getTextWidth(d) > getTextWidth(widest) ? d : widest));

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/**
 * `stale Xm` has to stay inside a footer column whose x is fixed at mount time (O1 leaves no
 * right-alignment to fall back on), so the number cannot be allowed to grow without bound —
 * a plugin left running overnight reaches four digits, which wraps the 27px-tall container and
 * gets clipped. Past 999 minutes the unit switches to hours, and past 999 hours it saturates:
 * at six weeks offline the exact figure has no reader, but a legible line still does.
 */
const STALE_MAX_UNITS = 999;

function staleAmount(ageMin: number): string {
  if (ageMin <= STALE_MAX_UNITS) return `${ageMin}m`;
  const ageHr = Math.floor(ageMin / 60);
  return ageHr <= STALE_MAX_UNITS ? `${ageHr}h` : `${STALE_MAX_UNITS}h+`;
}

/**
 * Every widest string `staleLabel` can return. The footer column reserves its width from THIS
 * list rather than from a hand-written copy, so the reservation cannot drift away from the
 * formatter that fills it.
 */
export const STALE_WIDEST_LABELS: readonly string[] = (() => {
  // Digits are neither equal width nor free of kerning (O3), so the widest three-digit run is not
  // simply `WIDEST_DIGIT` three times — measuring one glyph and tripling it under-reserved `999`
  // by a pixel. Measure the ten same-digit runs instead; `format.test.ts` then checks every value
  // the label can actually take against the result, which is what makes this safe rather than
  // plausible.
  const runs = '0123456789'.split('').map((d) => d.repeat(String(STALE_MAX_UNITS).length));
  return runs.flatMap((digits) => [`stale ${digits}m`, `stale ${digits}h`, `stale ${digits}h+`]);
})();

/**
 * Every widest string `resetLabel` can return — `resets HH:MM` for today and `resets Ddd HH:MM`
 * otherwise, over every weekday and the widest digit in every position.
 *
 * The §7 "bar alignment" bar column reserves its width from THIS list rather than from a hand-written
 * example string, for the same reason `STALE_WIDEST_LABELS` exists: the reservation and the
 * formatter that fills it cannot then drift apart. (`resets Mon 44:44` measures 157px, three more
 * than §7's `resets Thu 09:00` example — a hand-picked string under-reserves.)
 */
export const RESET_WIDEST_LABELS: readonly string[] = (() => {
  // Same caution as the stale labels: digits are neither equal width nor free of kerning (O3), so
  // the widest clock is measured as whole same-digit runs rather than assembled from one glyph.
  const clocks = '0123456789'.split('').map((d) => `${d}${d}:${d}${d}`);
  return clocks.flatMap((hhmm) => [`resets ${hhmm}`, ...WEEKDAYS.map((day) => `resets ${day} ${hhmm}`)]);
})();

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * PLAN T3.2: `filled = Math.round(usedPct * 12 / 100)`, then clamp — without the clamp 1–4% would
 * draw exactly like 0% and 99% exactly like 100%, which is the one thing a usage bar must not do.
 */
function filledCells(usedPct: number): number {
  const pct = Number.isFinite(usedPct) ? Math.min(100, Math.max(0, usedPct)) : 0;
  let filled = Math.round((pct * BAR_CELLS) / 100);
  if (pct > 0 && filled < 1) filled = 1;
  if (pct < 100 && filled > BAR_CELLS - 1) filled = BAR_CELLS - 1;
  return filled;
}

export const Formatter = {
  /** 12-cell progress bar for a 0–100 percentage. Always exactly `BAR_CELLS` glyphs wide. */
  bar(usedPct: number): string {
    const filled = filledCells(usedPct);
    return BAR_FILLED.repeat(filled) + BAR_EMPTY.repeat(BAR_CELLS - filled);
  },

  /** An all-empty bar, used for §7 V1 where there is no percentage to draw. */
  emptyBar(): string {
    return BAR_EMPTY.repeat(BAR_CELLS);
  },

  /** Percentages arrive with decimals from the statusline (T1.2); the glasses show whole percent. */
  pctLabel(usedPct: number): string {
    return `${Math.round(usedPct)}%`;
  },

  /**
   * §7 V6: header clock = the active tool's `fetchedAt`, truncated to the minute. Reading the
   * hour/minute components is inherently a floor — rounding would print a future time and
   * disagree with the floored `stale Xm`.
   */
  clockLabel(iso: string | null): string {
    if (iso === null) return NO_CLOCK;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return NO_CLOCK;
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  },

  /**
   * `resets 14:20` for later today, `resets Thu 09:00` otherwise. Always the server's value
   * (§6 rule 6); §7 V4 drops the whole suffix — hence the empty string — when the server sent none.
   */
  resetLabel(iso: string | null, now: Date = new Date()): string {
    if (iso === null) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const hhmm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    return sameDay ? `resets ${hhmm}` : `resets ${WEEKDAYS[d.getDay()]} ${hhmm}`;
  },

  /**
   * §3 staleness, the single rule: `staleAge = now − fetchedAt`; `≤ staleThreshold(tool)` → `ok`,
   * otherwise `stale Xm`. The threshold comes from `@quotalens/shared` — the plugin must never
   * hardcode one, because daemon and plugin have to agree on it.
   *
   * The comparison is on the raw age, not on floored minutes: flooring first makes everything from
   * `threshold + 1ms` to `threshold + 59s` still read `ok`, which §3 says is already stale. The
   * floor belongs to the display only, where it also keeps `stale Xm` consistent with §7 V6's
   * floored clock.
   */
  staleLabel(tool: ToolId, fetchedAt: string | null, now: Date, pollIntervalMin: number): string {
    if (fetchedAt === null) return 'ok';
    const fetchedMs = Date.parse(fetchedAt);
    if (Number.isNaN(fetchedMs)) return 'ok';
    const ageMs = now.getTime() - fetchedMs;
    if (ageMs <= staleThresholdMin(tool, pollIntervalMin) * 60_000) return 'ok';
    return `stale ${staleAmount(Math.floor(ageMs / 60_000))}`;
  },

  /** Single-line pixel width of `s`. */
  textWidth(s: string): number {
    return getTextWidth(s);
  },

  /** Widest of a set of strings — used to reserve a right-hand column that never has to move. */
  widestWidth(candidates: readonly string[]): number {
    return candidates.reduce((max, s) => Math.max(max, getTextWidth(s)), 0);
  },

  /**
   * Wrap measurement for a container's inner width. Callers must subtract
   * `2 * (paddingLength + borderWidth)` first — LVGL renders inside the inset, and measuring
   * against the outer width is the classic overflow bug.
   */
  measureLines(s: string, innerWidth: number): { lineCount: number; height: number; lineWidths: number[] } {
    return measureTextWrap(s, innerWidth);
  },

  /** §10.2 `fitLine`: clip a single line to a pixel budget so it can never wrap or overflow. */
  fitLine(s: string, innerWidth: number): string {
    return pxTruncate(s, innerWidth);
  },
} as const;
