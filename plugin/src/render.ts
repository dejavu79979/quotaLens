// QuotaLens plugin — container model, canvas geometry and the §10.2 `Renderer`.
//
// Official constraints this file encodes (PLAN §7 O1–O4):
//  O1/O3 — text is left-aligned inside its container and the font is not monospaced, so every
//          "right-hand" field is a SECOND container at a measured absolute x. No space padding.
//  O2   — absolute pixel coordinates only.
//  O4   — at most 8 text/list containers per page; exactly one `isEventCapture: 1`.
import {
  CreateStartUpPageContainer,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk';
import type { UsagePayload } from '@quotalens/shared';
import { Formatter } from './format.ts';

// ---- canvas geometry ---------------------------------------------------------

export const CANVAS_W = 576;
export const CANVAS_H = 288;
/** Fixed firmware line height (font-measurement skill). */
export const LINE_H = 27;

/** Left/right text margin. `RIGHT_EDGE` is where every right-hand column ends. */
export const MARGIN_X = 8;
export const RIGHT_EDGE = CANVAS_W - MARGIN_X;
/** Minimum gap between the left and right halves of the header/footer rows. */
export const COLUMN_GAP = 8;

export const HEADER_Y = 0;
export const FOOTER_Y = CANVAS_H - LINE_H;
/** The band between header and footer that the card / menu list is centred in. */
export const BODY_TOP = HEADER_Y + LINE_H;
export const BODY_BOTTOM = FOOTER_Y;

/** §7: card = 1px border, radius 6, padding 8. */
export const CARD_BORDER = 1;
export const CARD_RADIUS = 6;
export const CARD_PADDING = 8;
export const CARD_X = MARGIN_X;
export const CARD_W = CANVAS_W - 2 * MARGIN_X;
/** The font-measurement skill's "common mistake": measure against the inset, not the outer width. */
export const CARD_INNER_W = CARD_W - 2 * (CARD_PADDING + CARD_BORDER);

/**
 * §7 "two-level brightness". The SDK exposes text brightness as `textColor` 0–4 (device default 4), which is
 * the only brightness control that exists. Level 2 was the first guess for the design's "55%
 * opacity"; on the G2 itself (M6 D6, 2026-09-10) the owner could not tell 2 from 4 at all, and
 * level 1 is the first step that reads as dimmer. Measured on the device, not derived.
 */
export const BRIGHT_PRIMARY = 4;
export const BRIGHT_SECONDARY = 1;

/** O4: the hard per-page budget for text/list containers. */
export const MAX_TEXT_CONTAINERS = 8;
export const MAX_CONTAINER_NAME = 16;

/**
 * §7 "merged page" vertical rule: the card holds at most EIGHT rows.
 *
 * It is a geometry limit, not a taste one. `27 + 8×27 + 18 + 27 = 288` fills the canvas exactly
 * (header row + card + footer row), so a ninth row cannot be centred between header and footer —
 * it pushes the card over both of them and past the bottom edge. Eight is also the most the data
 * can produce: two section rows plus three data rows per tool.
 */
export const MAX_CARD_ROWS = 8;

/**
 * Keep a stacked-row container inside `MAX_CARD_ROWS`.
 *
 * A last line of defence in the same sense as `MAX_CONTENT_CHARS`: the row count is bounded by the
 * §3 contract, so this should never bite — and if a future row ever makes it nine, the page still
 * builds (clipped) instead of laying containers outside the canvas, which the SDK refuses outright.
 *
 * The truncation logs here rather than leaving it to `validatePage`. This clamp runs while the SCREEN
 * builds its rows, `validatePage` runs on the finished containers — so by the time the validator sees
 * the card the ninth row is already gone and its row check cannot fire (2026-09-10 QA finding on
 * T6b.1 step ④). Row counts only: no URL and no payload text, per §6 rule 1.
 */
export function clampCardRows<T>(rows: readonly T[]): T[] {
  if (rows.length <= MAX_CARD_ROWS) return [...rows];
  console.error(
    `QuotaLens: card has ${rows.length} rows, over the ${MAX_CARD_ROWS}-row limit; ` +
      `showing the first ${MAX_CARD_ROWS}`,
  );
  return rows.slice(0, MAX_CARD_ROWS);
}

/**
 * The SDK's own cap: `createStartUpPageContainer` and `rebuildPageContainer` accept **1000
 * characters** per text container and answer `StartUpPageCreateResult` 2 (oversize) beyond it —
 * i.e. no page at all (glasses-ui skill, 2026-09-09). `textContainerUpgrade` allows 2000, but the
 * same content has to survive the next rebuild, so 1000 is the number that matters.
 *
 * This is a LAST line of defence, not the layout rule: §7's own measurements keep every real string
 * far below it. What it stops is untrusted input reaching a bridge call — the payload comes off the
 * network, `ext` is an open map by contract (§3), and a schema-valid `ext` string of 2000 newlines
 * was enough to make the page fail to build AND be cached, so it failed again on every restart.
 */
export const MAX_CONTENT_CHARS = 1000;

/**
 * What actually goes into a container: no control characters, and never over the SDK's cap.
 *
 * `\n` is left alone: it is the documented way to stack rows (glasses-ui), and the §7 "merged page" card is
 * built out of it. Every OTHER control character is replaced — `\r` and `\t` have no defined
 * behaviour in the firmware renderer, and neither belongs in a string this app composes.
 *
 * Untrusted newlines are bounded by the length cap rather than by banning them: a schema-valid
 * `ext` string of 2000 of them was enough to blow the SDK's limit, fail the page, and — because the
 * payload was cached first — fail it again on every restart.
 */
export function displayText(content: string): string {
  const flattened = content.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ');
  return flattened.length > MAX_CONTENT_CHARS ? flattened.slice(0, MAX_CONTENT_CHARS) : flattened;
}

// ---- container model ---------------------------------------------------------

/** One text container, in the vocabulary this app uses; converted to the SDK type at render time. */
export interface TextSpec {
  id: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  content: string;
  border?: number;
  radius?: number;
  padding?: number;
  brightness?: number;
  /** Exactly one spec per page must set this. */
  capture?: boolean;
}

/** A `textContainerUpgrade` payload — the flicker-free in-place update used by `Screen.patch`. */
export interface TextUpdate {
  id: number;
  name: string;
  content: string;
}

/**
 * Settings the screens need. T3.5 owns the phone-side editor; these are its defaults (§7, T3.5).
 *
 * One field since T6b.2 withdrew §7 V3: the staleness thresholds in §3 are a function of the poll
 * interval, so this is the only setting a screen has ever had a reason to read.
 */
export interface PluginSettings {
  pollIntervalMin: number;
}

export const DEFAULT_SETTINGS: PluginSettings = { pollIntervalMin: 5 };

/**
 * Everything a screen needs to draw itself.
 *
 * §10.2 writes `buildContainers(p)` with `p` = the payload; staleness (§3) also needs `now` and the
 * poll interval, and the menu needs the cursor — so `p` is this record rather than a bare
 * `UsagePayload`.
 */
export interface ScreenInput {
  /** `null` = CONNECTING (§7 V2): no cache and no successful fetch yet. */
  payload: UsagePayload | null;
  /** §7 V10: no relay address; this view overrides even a cached payload. */
  unconfigured?: boolean;
  now: Date;
  settings: PluginSettings;
  /** §7 V2 footer-right short code while CONNECTING (`net err` / `404` / `bad schema`). */
  errorCode: string | null;
  /** §10.2 `MenuScreen.cursor`. */
  cursor: number;
  /**
   * Transient feedback in the footer-LEFT slot, in place of that page's standing hint: §7 V9's
   * `one page · hold menu` on the merged page, §7 V5's `coming in v2` in the menu. Absent or `null`
   * means the slot shows its normal content. The App owns the lifetime of the string; a screen never
   * invents one.
   */
  notice?: string | null;
  /**
   * Transient feedback in the footer STATUS column (right) of the merged page: §7 V7's `refreshing…`.
   *
   * A field of its own, not a second string in `notice`: the two slots have independent lifetimes, so
   * raising one must not clear the other (2026-09-10 review — a swipe 100ms after a tap took
   * `refreshing…` down with it, before its fetch had ended). The menu has no status column and
   * ignores this.
   */
  statusNotice?: string | null;
}

/**
 * §10.2 `Screen`. The diagram also gives it an `onEvent(e) Action`; T3.3 did not add one — the
 * whole §10.3(a) transition table lives in one pure reducer in `app.ts` instead, because
 * "every input produces feedback" is a property of the machine, not of any single page, and
 * splitting it across three screens would leave nothing to assert it against.
 */
export interface Screen {
  /** §10.3(a) after M6b: one merged usage page plus the menu overlay. */
  readonly id: 'all' | 'menu';
  buildContainers(input: ScreenInput): TextSpec[];
  patch(input: ScreenInput): TextUpdate[];
}

// ---- helpers -----------------------------------------------------------------

/** Total inset LVGL applies on each side of a container's text area. */
export function insetOf(spec: Pick<TextSpec, 'border' | 'padding'>): number {
  return (spec.border ?? 0) + (spec.padding ?? 0);
}

/** The width text actually gets inside a container. */
export function innerWidthOf(spec: TextSpec): number {
  return spec.w - 2 * insetOf(spec);
}

/**
 * Place a right-hand column: reserve the width of the widest string it will ever hold, and anchor
 * that reserved box at `RIGHT_EDGE`. Reserving the maximum is what makes `textContainerUpgrade`
 * usable — the box never has to move when the text inside it changes length, and O1 leaves no
 * right-alignment to fall back on.
 */
export function rightColumn(candidates: readonly string[]): { x: number; w: number } {
  const w = Formatter.widestWidth(candidates);
  return { x: RIGHT_EDGE - w, w };
}

/** O4 and the naming rules, checked before the payload reaches the bridge. */
export function validatePage(specs: TextSpec[]): string[] {
  const problems: string[] = [];
  if (specs.length > MAX_TEXT_CONTAINERS) {
    problems.push(`page has ${specs.length} text containers, over the limit of ${MAX_TEXT_CONTAINERS}`);
  }
  const captures = specs.filter((s) => s.capture).length;
  if (captures !== 1) problems.push(`page has ${captures} isEventCapture containers, expected exactly 1`);
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const s of specs) {
    if (!Number.isInteger(s.id)) problems.push(`containerID ${String(s.id)} is not an integer`);
    if (ids.has(s.id)) problems.push(`duplicate containerID ${s.id}`);
    ids.add(s.id);
    if (names.has(s.name)) problems.push(`duplicate containerName ${s.name}`);
    names.add(s.name);
    if (s.name.length > MAX_CONTAINER_NAME) {
      problems.push(`containerName "${s.name}" is ${s.name.length} chars, over ${MAX_CONTAINER_NAME}`);
    }
    if (s.x < 0 || s.y < 0 || s.x + s.w > CANVAS_W || s.y + s.h > CANVAS_H) {
      problems.push(`container "${s.name}" falls outside the ${CANVAS_W}x${CANVAS_H} canvas`);
    }
    if (s.content.length === 0) problems.push(`container "${s.name}" has empty content`);
    // Loud as well as clamped: `toTextContainer` will trim it so the page still builds, but a
    // screen producing this much text is a bug upstream and the log is where that gets noticed.
    if (s.content.length > MAX_CONTENT_CHARS) {
      problems.push(`container "${s.name}" holds ${s.content.length} chars, over the SDK's ${MAX_CONTENT_CHARS}`);
    }
    if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(s.content)) {
      problems.push(`container "${s.name}" contains a control character other than a line break`);
    }
    // §7 "merged page": a ninth row cannot be placed between header and footer at all, so a page that
    // produced one is a layout bug. The card path can no longer reach here with nine rows —
    // `clampCardRows` has already cut it down and logged that it did — so this catches a stacked
    // container built by any OTHER path, where nothing has clamped it.
    const rows = s.content.split('\n').length;
    if (rows > MAX_CARD_ROWS) {
      problems.push(`container "${s.name}" holds ${rows} rows, over the ${MAX_CARD_ROWS}-row card limit`);
    }
  }
  return problems;
}

function toTextContainer(spec: TextSpec): TextContainerProperty {
  return new TextContainerProperty({
    xPosition: spec.x,
    yPosition: spec.y,
    width: spec.w,
    height: spec.h,
    borderWidth: spec.border ?? 0,
    borderColor: 15,
    borderRadius: spec.radius ?? 0,
    paddingLength: spec.padding ?? 0,
    containerID: spec.id,
    containerName: spec.name,
    // The one place every container passes through on its way to the bridge.
    content: displayText(spec.content),
    textColor: spec.brightness ?? BRIGHT_PRIMARY,
    isEventCapture: spec.capture ? 1 : 0,
    // zOrderIndex is deliberately omitted on every container: it is all-or-nothing per page and
    // nothing here overlaps, so declaration order is enough (glasses-ui skill).
  });
}

// ---- Renderer ----------------------------------------------------------------

/**
 * What `App` needs from a renderer. The concrete `Renderer` holds the bridge in private fields,
 * which makes it impossible to stand in for structurally — and a test that cannot make a render
 * fail cannot check what happens when one does. `App` therefore depends on this, not on the class.
 */
export interface PageRenderer {
  /** `false` = the page did not land; the glasses still show whatever was there before. */
  mount(screen: Screen, input: ScreenInput): Promise<boolean>;
  /** `false` = at least one container still shows its old text. */
  patch(updates: TextUpdate[]): Promise<boolean>;
  /**
   * Abandon everything in flight. A caller's deadline only stops the CALLER waiting — the bridge
   * call it gave up on is still on its way, and a multi-container `patch` would keep issuing the
   * rest of its batch. After this, work started earlier issues no further bridge calls and reports
   * failure, so a timed-out render cannot paint over a newer one and nothing can write after exit.
   */
  invalidate(): void;
  /**
   * The host has torn the page down (BLE loss, `ABNORMAL_EXIT`; PLAN §10.3(a) DISCONNECTED).
   * Abandons in-flight work like `invalidate()` AND forgets that the page was ever created, so the
   * next `mount` runs the one-shot `createStartUpPageContainer` again instead of rebuilding a page
   * that no longer exists.
   */
  pageLost(): void;
  /**
   * Queue one more call onto the single bridge chain and hand back its result.
   *
   * The glasses are one serial link, and the App makes one bridge call of its own —
   * `shutDownPageContainer`. A shutdown still in flight when the next redraw is issued is the same
   * overlap the renders were serialised to remove, reached through the one call that was not going
   * through the renderer (measured: in-flight 2 with a stalled shutdown, 1 on the normal path).
   */
  enqueue<T>(call: () => Promise<T>): Promise<T>;
}

/**
 * §10.2 `Renderer`. `createStartUpPageContainer` is one-shot, so the first `mount` creates the page
 * and every later one rebuilds it; `patch` upgrades text in place without the rebuild flicker.
 */
export class Renderer implements PageRenderer {
  private readonly bridge: EvenAppBridge;
  private created = false;
  /**
   * Bumped by `invalidate()`. Work that started under an older epoch stops issuing bridge calls
   * and reports failure — the only way to make an abandoned call harmless, since the SDK gives us
   * nothing to cancel with.
   */
  private epoch = 0;
  /** The one-shot startup call while it is still out, so a retry joins it instead of repeating it. */
  private pendingCreate: Promise<StartUpPageCreateResult> | null = null;
  /**
   * Bumped by `pageLost()`. A create that was in flight when the host tore the page down answers for
   * a page that is gone: its success must not set `created`, or the next mount would REBUILD a page
   * that does not exist (and keep failing). `invalidate()` alone is the wrong tool for that — it
   * deliberately lets a device-side success be recorded even when the render was abandoned.
   */
  private pageGeneration = 0;
  /** The tail of every bridge call issued so far. A new call is chained onto it, never raced with it. */
  private chain: Promise<void> = Promise.resolve();

  constructor(bridge: EvenAppBridge) {
    this.bridge = bridge;
  }

  invalidate(): void {
    this.epoch += 1;
  }

  pageLost(): void {
    this.invalidate();
    this.created = false;
    this.pageGeneration += 1;
  }

  /**
   * One bridge call at a time — for ALL of them: the renders, the one-shot create, and whatever
   * the App queues through `enqueue` (its own `shutDownPageContainer`).
   *
   * `invalidate()` only stops calls that have not been ISSUED yet. The call a caller's deadline
   * gave up on is already with the bridge, so the repair render scheduled behind it went out
   * alongside it (the review probe measured `BRIDGE_OVERLAP=true`). The glasses-ui skill is
   * explicit that concurrent calls can drop the BLE link, so the new call waits its turn instead.
   *
   * ponytail: one chain for the whole renderer. Per-container chains would be finer-grained and
   * pointless — the device is a single serial link either way. A call that never settles now
   * blocks every later one; that is the same link being down, and painting over it is not an
   * option we ever had.
   */
  enqueue<T>(call: () => Promise<T>): Promise<T> {
    const result = this.chain.then(call);
    this.chain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Did anything invalidate the work that started under `epoch`? */
  private stale(epoch: number): boolean {
    return this.epoch !== epoch;
  }

  async mount(screen: Screen, input: ScreenInput): Promise<boolean> {
    const epoch = this.epoch;
    const specs = screen.buildContainers(input);
    for (const problem of validatePage(specs)) {
      // A page that breaks O4 is rejected by the SDK and renders nothing — the one thing §6 rule 5
      // forbids — so it has to be loud rather than a silent blank screen.
      console.error(`QuotaLens: invalid page "${screen.id}": ${problem}`);
    }
    const textObject = specs.map(toTextContainer);
    if (this.stale(epoch)) return this.abandoned(`mount "${screen.id}"`);

    // The startup call is one-shot AND slow enough to still be out when a retry arrives. Joining
    // the pending one instead of issuing another is what keeps that true: a caller's deadline
    // schedules a repair render, and `created` cannot flip until the first call answers, so the
    // naive check issued a second (and third) create while the first was still in flight.
    if (this.pendingCreate !== null) {
      await this.pendingCreate;
      // Anything can have happened while we waited — the app may have exited. Without this, a
      // joiner whose create came back FAILED falls straight through and issues another startup
      // call, on a page that is already gone.
      if (this.stale(epoch)) return this.abandoned(`mount "${screen.id}"`);
    }

    if (!this.created) {
      const generation = this.pageGeneration;
      this.pendingCreate = this.enqueue(() =>
        this.bridge.createStartUpPageContainer(
          new CreateStartUpPageContainer({ containerTotalNum: specs.length, textObject }),
        ),
      )
        // Record what the DEVICE did before deciding whether we still care: if the page was created
        // and we drop that because this render was abandoned, every later mount calls the startup
        // API again, and a host that refuses the second create blanks the glasses for good.
        // Unless the page itself has been lost since — then this success is about a page that no
        // longer exists, and recording it would make every later mount a rebuild of nothing.
        .then((result) => {
          if (result === StartUpPageCreateResult.success && generation === this.pageGeneration) this.created = true;
          return result;
        })
        .finally(() => {
          this.pendingCreate = null;
        });
      const result = await this.pendingCreate;
      if (this.stale(epoch)) return this.abandoned(`mount "${screen.id}"`);
      if (result !== StartUpPageCreateResult.success) {
        console.error(`QuotaLens: createStartUpPageContainer failed with ${result}`);
        return false;
      }
      return true;
    }
    if (this.stale(epoch)) return this.abandoned(`mount "${screen.id}"`);
    // Re-checked inside the queued call as well: this may have waited behind a stuck call, and by
    // the time its turn comes the page it was going to rebuild can already be gone.
    const ok = await this.enqueue(() =>
      this.stale(epoch)
        ? Promise.resolve(false)
        : this.bridge.rebuildPageContainer(new RebuildPageContainer({ containerTotalNum: specs.length, textObject })),
    );
    if (this.stale(epoch)) return this.abandoned(`mount "${screen.id}"`);
    if (!ok) console.error(`QuotaLens: rebuildPageContainer failed for "${screen.id}"`);
    return ok;
  }

  private abandoned(what: string): false {
    console.error(`QuotaLens: ${what} was abandoned before it finished; its result is discarded`);
    return false;
  }

  /**
   * Serialised on purpose — concurrent bridge calls can drop the BLE connection (glasses-ui skill).
   *
   * Returns whether EVERY update landed. A partial patch leaves the glasses showing a mixture of
   * old and new text, and the caller has to know that so it does not carry on as if the screen
   * matched its state. Every update is attempted even after one fails: stopping early would leave
   * strictly more of the screen stale.
   */
  async patch(updates: TextUpdate[]): Promise<boolean> {
    const epoch = this.epoch;
    let allLanded = true;
    for (const update of updates) {
      // Checked before EVERY call, not once at the top: this loop is the reason a caller's
      // deadline was not enough. Abandoning the wait left the batch running, so the remaining
      // containers were still written — after `SYSTEM_EXIT` had already torn the page down.
      if (this.stale(epoch)) return this.abandoned('patch');
      const ok = await this.enqueue(() =>
        this.stale(epoch)
          ? Promise.resolve(false)
          : this.bridge.textContainerUpgrade(
              new TextContainerUpgrade({
                containerID: update.id,
                containerName: update.name,
                contentOffset: 0,
                contentLength: 0,
                // Same guard as `mount`: PLAN §10.3(a) says EVERY container's content passes
                // through here, and a patch is a bridge call like any other. `textContainerUpgrade`
                // allows 2000 characters where a rebuild allows 1000 — but the same text has to
                // survive the next rebuild, so the tighter cap is the one that matters.
                content: displayText(update.content),
              }),
            ),
      );
      // containerID/containerName must match the mounted container exactly or the upgrade fails
      // silently — the screen would then keep showing stale text with no other symptom.
      if (!ok) {
        console.error(`QuotaLens: textContainerUpgrade failed for "${update.name}"`);
        allLanded = false;
      }
    }
    return allLanded;
  }
}
