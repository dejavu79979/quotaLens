// PLAN §7 frame C / C2 — the long-press menu (§10.2 `MenuScreen`).
//
// M6b (2026-09-10): `Switch to …` is gone with `activeTool` — there is one page to switch to. Three
// options, so the page is 2 header + 3 options + 2 footer = 7 text containers, one under the O4
// budget of 8; the footer indicator reads `n/3`.
import { Formatter } from '../format.ts';
import {
  BODY_BOTTOM,
  BODY_TOP,
  BRIGHT_PRIMARY,
  BRIGHT_SECONDARY,
  CARD_RADIUS,
  COLUMN_GAP,
  FOOTER_Y,
  HEADER_Y,
  LINE_H,
  MARGIN_X,
  rightColumn,
  type Screen,
  type ScreenInput,
  type TextSpec,
  type TextUpdate,
} from '../render.ts';

const HEADER_LEFT = 'Menu';
const HEADER_RIGHT_TEXT = 'double-tap = back';
const FOOTER_LEFT = '▲▼ move · tap select';
/** §7: the cursor prefix. Selection is also marked by `borderWidth: 1` on the same row. */
const CURSOR = '> ';

/**
 * §7 V5: `Token stats · soon` has nothing to open yet, so selecting it answers in the footer-left
 * slot for two seconds. Without it that option is an input with no feedback at all (§6 rule 5).
 */
export const COMING_SOON = 'coming in v2';

/**
 * Cursor index → the §10.3(a) `SELECT_*` transition. The App switches on these rather than on the
 * label text, so renaming an option cannot silently rewire what selecting it does.
 */
export const MENU_INDEX = { refresh: 0, tokenStats: 1, exit: 2 } as const;

/** §7 frame C2 (M6b): three fixed entries. */
export function menuItems(): string[] {
  return ['Refresh now', 'Token stats · soon', 'Exit'];
}

/** Every label the list can ever hold — the option boxes are sized once, so they never resize. */
const ALL_LABELS = menuItems();
const LABEL_W = Formatter.widestWidth(ALL_LABELS);
const CURSOR_W = Formatter.textWidth(CURSOR);

/**
 * Both option states inset their text by the same 5px — the selected row spends it on
 * `border 1 + padding 4`, the others on `padding 5`. That keeps the text baseline and the label's
 * x identical whether or not the row is selected, so moving the cursor does not nudge the list.
 */
const OPT_INSET = 5;
const OPT_SELECTED_PADDING = 4;
const OPT_SELECTED_BORDER = 1;
const OPT_UNSELECTED_PADDING = 5;

const OPT_SELECTED_X = MARGIN_X;
const OPT_SELECTED_W = CURSOR_W + LABEL_W + 2 * OPT_INSET;
/**
 * Shifting the unselected box right by exactly the measured width of `"> "` is what lines every
 * label up at one x. O3 forbids doing this with spaces — the font is not monospaced.
 */
const OPT_UNSELECTED_X = OPT_SELECTED_X + CURSOR_W;
const OPT_UNSELECTED_W = OPT_SELECTED_W - CURSOR_W;

const OPT_H = LINE_H + 2 * OPT_INSET;
const OPT_GAP = 4;
const OPT_COUNT = ALL_LABELS.length;
const LIST_H = OPT_COUNT * OPT_H + (OPT_COUNT - 1) * OPT_GAP;
const LIST_Y = BODY_TOP + Math.round((BODY_BOTTOM - BODY_TOP - LIST_H) / 2);

const HEADER_RIGHT = rightColumn([HEADER_RIGHT_TEXT]);
/** `1/3` … `3/3`; §7's ruling is that the indicator is the cursor index, so item 1 reads `1/3`. */
const FOOTER_RIGHT = rightColumn(
  Array.from({ length: OPT_COUNT }, (_, i) => `${i + 1}/${OPT_COUNT}`),
);

const ID = { hdrLeft: 1, hdrRight: 2, opt: 3, ftrLeft: 7, ftrRight: 8 } as const;

export const menuScreen: Screen = {
  id: 'menu',

  buildContainers(input: ScreenInput): TextSpec[] {
    const items = menuItems();
    const cursor = Math.min(Math.max(input.cursor, 0), items.length - 1);
    const headerLeftW = HEADER_RIGHT.x - COLUMN_GAP - MARGIN_X;
    const footerLeftW = FOOTER_RIGHT.x - COLUMN_GAP - MARGIN_X;

    const options: TextSpec[] = items.map((label, i) => {
      const selected = i === cursor;
      const w = selected ? OPT_SELECTED_W : OPT_UNSELECTED_W;
      return {
        id: ID.opt + i,
        name: `opt${i + 1}`,
        x: selected ? OPT_SELECTED_X : OPT_UNSELECTED_X,
        y: LIST_Y + i * (OPT_H + OPT_GAP),
        w,
        h: OPT_H,
        content: Formatter.fitLine(selected ? `${CURSOR}${label}` : label, w - 2 * OPT_INSET),
        border: selected ? OPT_SELECTED_BORDER : 0,
        radius: selected ? CARD_RADIUS : 0,
        padding: selected ? OPT_SELECTED_PADDING : OPT_UNSELECTED_PADDING,
        brightness: selected ? BRIGHT_PRIMARY : BRIGHT_SECONDARY,
        // The first option carries the page's single event capture. It is the one option container
        // that exists at a fixed id no matter where the cursor is.
        capture: i === 0,
      };
    });

    return [
      {
        id: ID.hdrLeft,
        name: 'hdrLeft',
        x: MARGIN_X,
        y: HEADER_Y,
        w: headerLeftW,
        h: LINE_H,
        content: Formatter.fitLine(HEADER_LEFT, headerLeftW),
        brightness: BRIGHT_SECONDARY,
      },
      {
        id: ID.hdrRight,
        name: 'hdrRight',
        x: HEADER_RIGHT.x,
        y: HEADER_Y,
        w: HEADER_RIGHT.w,
        h: LINE_H,
        content: HEADER_RIGHT_TEXT,
        brightness: BRIGHT_SECONDARY,
      },
      ...options,
      {
        id: ID.ftrLeft,
        name: 'ftrLeft',
        x: MARGIN_X,
        y: FOOTER_Y,
        w: footerLeftW,
        h: LINE_H,
        // §7 V5: the transient notice takes over this slot, then the hint comes back.
        content: Formatter.fitLine(input.notice ?? FOOTER_LEFT, footerLeftW),
        brightness: BRIGHT_SECONDARY,
      },
      {
        id: ID.ftrRight,
        name: 'ftrRight',
        x: FOOTER_RIGHT.x,
        y: FOOTER_Y,
        w: FOOTER_RIGHT.w,
        h: LINE_H,
        content: `${cursor + 1}/${OPT_COUNT}`,
        brightness: BRIGHT_SECONDARY,
      },
    ];
  },

  /**
   * Empty on purpose. Moving the cursor changes `borderWidth`, `xPosition` and `width`, none of
   * which `textContainerUpgrade` can touch — the menu is always redrawn with `rebuildPageContainer`
   * (glasses-ui skill: selection highlight requires a rebuild). T3.3 does that redraw.
   */
  patch(): TextUpdate[] {
    return [];
  },
};
