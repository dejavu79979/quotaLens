// QuotaLens plugin — T3.3 application state machine (PLAN §10.3(a)) and its effect runner.
//
// The file is split in two on purpose:
//
//   `reduce()`  — a pure function `(state, event, now) → { next, effects }`. Every visible
//                 consequence of an input is named in `effects`, which is what turns PLAN §6
//                 rule 5 ("no input may go without feedback") into an assertion in `app.test.ts`
//                 rather than something a human has to spot in a screenshot.
//   `App`       — a thin shell that owns the bridge, the renderer and the timers, and executes
//                 those effects one at a time. Bridge calls are serialised (never concurrent):
//                 overlapping calls can drop the BLE connection (glasses-ui skill).
//
// PLAN §10.3(a) invariants encoded here (M6b: one merged page, no `activeTool`):
//   - LIVE/STALE is derived from §3 staleness ONLY, never from the success of a fetch, and it is
//     recomputed after every fetch, on leaving MENU and on `FOREGROUND_ENTER`. STALE means EVERY
//     drawn tool is past its own threshold; one fresh section keeps the page LIVE.
//   - The PHASE is therefore not what the page shows: each section carries its own §3 verdict, so a
//     redraw is owed whenever any of THOSE moved, phase or no phase (`staleShown` / `TICK`).
//   - On a configured root page a tap IS `SELECT_Refresh` (§7 V7); UNCONFIGURED answers with V10's
//     setup notice instead. A swipe answers in the footer (§7 V9).
//     Two footer slots, two fields, two lifetimes: `notice` (left, a two-second timer) and
//     `statusNotice` (right, until the fetch ends). Raising either one never touches the other.
//   - DOUBLE_CLICK on a root page hands the exit to the system (`shutDownPageContainer(1)`), and
//     nothing is torn down before it — the user can still cancel. Cleanup happens on the
//     SYSTEM_EXIT / ABNORMAL_EXIT events instead.
//   - LONG_PRESS_RELEASE is consumed deliberately: the release always follows the press, and
//     dropping it into an "unknown event" branch is precisely what §10.3(a) constraint 1 forbids.
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk';
import type { ToolId, UsagePayload } from '@quotalens/shared';
import { Formatter } from './format.ts';
import type { UiEvent } from './input.ts';
import { InputRouter } from './input.ts';
import type { DataPoller, PollOutcome } from './poll.ts';
import { DEFAULT_SETTINGS, type PageRenderer, type PluginSettings, type Screen, type ScreenInput, type TextSpec } from './render.ts';
import { COMING_SOON, MENU_INDEX, menuItems } from './screens/menu.ts';
import { drawnTools, ONE_PAGE, REFRESHING, SET_ADDRESS_FIRST } from './screens/tool.ts';

export type ScreenId = Screen['id'];

/**
 * §10.3(a).
 *
 * BOOT and SHOW_CACHED have no runtime phase of their own: `main.ts` reads the T3.4 cache and hands
 * it to `initialState`, which derives LIVE/STALE from §3 on the spot — which is exactly what the
 * diagram's `BOOT --> SHOW_CACHED --> LIVE|STALE` edges say, with nothing observable in between.
 * A cold boot with no cache lands in CONNECTING when a relay is configured; an empty relay takes
 * the higher-priority UNCONFIGURED root phase (§7 V10).
 */
export type Phase =
  | 'UNCONFIGURED'
  | 'CONNECTING'
  | 'LIVE'
  | 'STALE'
  | 'MENU'
  | 'EXIT_REQUESTED'
  | 'EXIT_OFFERED'
  /**
   * The host tore the page down because the glasses went away (`ABNORMAL_EXIT` = BLE loss, M6 D5),
   * but this WebView is still running. Nothing draws — there is no page — and nothing is torn down
   * either: the poller keeps the cache fresh and the tick keeps §3 honest, so that `RECONNECTED`
   * can put a current page straight back. Measured on device 2026-09-09: treating this as EXITING
   * left the glasses on the Dashboard until the owner closed and reopened the app.
   */
  | 'DISCONNECTED'
  | 'EXITING';

/**
 * The exit request is a STATE, not a flag on the side (2026-09-08 ruling, after six rounds of
 * review found six defects in the same gap).
 *
 * `shutDownPageContainer(1)` only OFFERS the system dialog: the app may not tear down, because the
 * user can cancel — but it may not carry on either, because it may be the last thing that ever
 * happens to the page. Every one of those six defects was the same shape: the machine kept moving
 * while the glasses could not. Two phases say it instead:
 *
 *   `EXIT_REQUESTED` — the call is on its way. Nothing draws, nothing moves, and NOTHING is a
 *                      cancel: there is no dialog yet, so an input is the old page talking.
 *   `EXIT_OFFERED`   — the host has the request and the dialog is up. From here, and only here, an
 *                      input can only mean the user dismissed it.
 *
 * The ordering that used to need arrival stamps now comes from the dispatch queue: `EXIT_OFFERED`
 * is dispatched like any other event, so everything that arrived before it is handled before it,
 * and sees `EXIT_REQUESTED`.
 */
export function isExitDialogPhase(phase: Phase): boolean {
  return phase === 'EXIT_REQUESTED' || phase === 'EXIT_OFFERED';
}

/** Everything the FSM needs; `cursor` is the extended state of §10.3(a) (M6b dropped `activeTool`). */
export interface AppState {
  phase: Phase;
  cursor: number;
  /** §7 V10: no relay address; this root state overrides a cached payload. */
  unconfigured: boolean;
  /** `null` = CONNECTING (§7 V2): nothing cached and nothing fetched yet. */
  payload: UsagePayload | null;
  errorCode: string | null;
  settings: PluginSettings;
  now: Date;
  /**
   * §7 V5 / §7 V9 transient footer-LEFT text; see `ScreenInput.notice`.
   *
   * The LEFT slot only. It has its own lifetime — a two-second timer — and raising it may not touch
   * `statusNotice` (2026-09-10 review: a swipe 100ms after a tap took `refreshing…` down with it).
   */
  notice: string | null;
  /**
   * §7 V7 `refreshing…`, in the footer STATUS column (right). A separate field rather than a second
   * string in `notice` because the two slots answer to different things: this one comes down when
   * the fetch ends (and not before its one-second floor), the left one when its timer expires.
   */
  statusNotice: string | null;
  /**
   * The per-tool §3 verdicts as they were last DRAWN — `claude=ok|codex=stale 10m`.
   *
   * What makes a single section crossing its own threshold visible to `TICK`: the PHASE cannot see
   * it (one fresh section keeps the whole page LIVE), so the tick compares the verdict LABELS
   * instead and redraws when any of them moved (2026-09-10 review). Comparing labels rather than
   * ages is also what keeps the `stale Xm` counter to one redraw per minute instead of one per tick.
   */
  staleShown: string;
  /** Which page the exit was requested from, so a cancelled dialog returns the user to it (§7 C). */
  exitFrom: 'root' | 'menu';
}

/**
 * Everything the reducer reacts to: the mapped user input, plus the internal events the effect
 * runner feeds back (a finished refresh, an expired notice, the staleness re-check tick).
 */
export type AppEvent =
  | UiEvent
  | 'REFRESH_DONE'
  | 'NOTICE_EXPIRED'
  | 'TICK'
  | 'RENDER'
  /**
   * A poll finished (T3.4). The outcome itself is handed to `App.deliver` and applied to the state
   * on the dispatch queue, so this stays a bare name like every other event: what it means is
   * "there is new data (or a new error code) to show", and §3 decides the rest.
   */
  | 'DATA'
  /** The host has the exit request; the dialog is up. Dispatched when the call answers. */
  | 'EXIT_OFFERED'
  /** The exit request reached nobody — refused or thrown. The page is still ours. */
  | 'EXIT_REFUSED'
  /** The user dismissed the dialog. Its own event so a lost redraw can be re-delivered as itself. */
  | 'EXIT_CANCELLED'
  /** The glasses are back (`onDeviceStatusChanged` → Connected). Only meaningful in DISCONNECTED. */
  | 'RECONNECTED';

/**
 * Events that must survive a failed render, because nobody is going to produce them again.
 *
 * A rolled-back USER gesture is fine to lose: the screen did not change, so the user simply
 * presses again. These three have no such person behind them — `RENDER` is the first page (lose it
 * and the glasses stay blank, which §6 rule 5 forbids outright), and the two completion events are
 * one-shot timers that have already fired (lose one and its transient footer text — `refreshing…`,
 * `coming in v2` — stays up forever, hiding the real §3 status underneath).
 */
const RETRYABLE: ReadonlySet<AppEvent> = new Set<AppEvent>([
  'RENDER',
  'REFRESH_DONE',
  'NOTICE_EXPIRED',
  // Nobody will send this again either, and losing it strands the app in `EXIT_REQUESTED`: a phase
  // that draws nothing and treats no input as a cancel, because the dialog it is waiting on was
  // never offered. That is the frozen screen, reached from the one path that reports a refusal.
  'EXIT_REFUSED',
  // Same reason, from the other side: the cancel has already HAPPENED — the user dismissed the
  // dialog — and only its redraw was lost. Dropping it strands the machine in `EXIT_OFFERED`,
  // where a bare `RENDER` draws nothing by design, so nothing would ever put the page back.
  'EXIT_CANCELLED',
  // The poll that produced it will not produce it again for another five minutes. Losing the first
  // successful payload is the worst case: the rollback puts the app back in CONNECTING, and the
  // glasses would keep saying `Connecting…` for a whole interval with the data already in hand.
  // Re-delivery is safe because `App.latest` holds the outcome rather than the event doing so.
  'DATA',
  // The glasses came back once; the host will not say so again. If the rebuild of the page does not
  // land, the rollback leaves the machine in DISCONNECTED and this is the only way out of it.
  'RECONNECTED',
]);

/**
 * Gestures that take an ACTION rather than move between pages, frozen while the screen is unknown.
 *
 * After a bridge deadline the machine is rolled back but the call we abandoned may still paint, so
 * the glasses can be showing a page the machine is not on. A tap is then interpreted against a
 * state the user cannot see — the reproduction was a tap meant for `Token stats · soon` reaching
 * `Exit` and quitting the app. Scrolling is left live: it only moves the cursor, and its own
 * `mount` repaints the whole page, so it cannot act on something invisible.
 */
const ACTION_EVENTS: ReadonlySet<AppEvent> = new Set<AppEvent>(['CLICK', 'DOUBLE_CLICK', 'LONG_PRESS']);

/**
 * Events that could only have come from a page that is still on the glasses. In `EXIT_OFFERED`
 * one of these is the user dismissing the dialog — there is no cancel event to wait for, because
 * the answer goes to the host and simulator 0.9.5 never sends `SYSTEM_EXIT` back at all (§8).
 */
const FROM_LIVE_PAGE: ReadonlySet<AppEvent> = new Set<AppEvent>([
  'SCROLL_TOP',
  'SCROLL_BOTTOM',
  'CLICK',
  'DOUBLE_CLICK',
  'LONG_PRESS',
  'LONG_PRESS_RELEASE',
  'FOREGROUND_ENTER',
]);

/**
 * A named visible consequence. `ack` is the one entry that changes nothing on the glasses — it
 * marks an event that was consumed on purpose (the tail of a long press, a long press while the
 * menu is already open) as opposed to one that fell through unhandled. The test table allows it
 * only for exactly those cells.
 */
export type Effect =
  | { kind: 'mount'; screen: ScreenId }
  | { kind: 'patch'; screen: ScreenId }
  | { kind: 'refresh' }
  | { kind: 'noticeTimer'; ms: number }
  | { kind: 'exit' }
  | { kind: 'cleanup' }
  /** The page is gone but the app is not (DISCONNECTED): abandon in-flight writes, forget the page. */
  | { kind: 'suspend' }
  /**
   * Write the last good payload to `localStorage` now (T3.4).
   *
   * Not a visible consequence, and not claimed as one: `FOREGROUND_EXIT` is the host telling us the
   * phone is leaving, not a gesture, so §6 rule 5 owes it nothing. It is an effect rather than
   * something the runner does on the side so that "the cache is written before the WebView can be
   * migrated" is a line in the transition table instead of a detail buried in the shell.
   */
  | { kind: 'flush' }
  | { kind: 'ack'; reason: string };

export interface Transition {
  next: AppState;
  effects: Effect[];
}

/** §7 V5 / V9 / V10: how long footer-left notices stay up. */
export const NOTICE_MS = 2000;

export function isRootPhase(phase: Phase): boolean {
  return phase === 'UNCONFIGURED' || phase === 'CONNECTING' || phase === 'LIVE' || phase === 'STALE';
}

/**
 * §3 / §10.3(a): the root phase is a function of the data's age, nothing else.
 *
 * M6b: the page draws both tools, so the verdict is over the SET of drawn sections — STALE only when
 * every one of them is past its own threshold, LIVE while any section is still fresh. The two states
 * look identical on the glasses now (each section carries its own `ok`/`stale Xm`); the distinction
 * is what the log and the tests read.
 *
 * The per-tool verdict is read back from `Formatter.staleLabel` — the same call the section row makes
 * — rather than recomputed against the threshold here. Two independent comparisons could disagree,
 * and then a section would say `ok` while the machine believed STALE.
 */
export function rootPhase(state: AppState): Phase {
  if (state.unconfigured) return 'UNCONFIGURED';
  if (state.payload === null) return 'CONNECTING';
  // §7 V1 (re-judged): a tool that never fetched draws no section, so it has no staleness to be
  // past. With neither tool drawn the card says `No usage data` — a normal page, hence LIVE.
  const verdicts = staleVerdicts(state);
  if (verdicts.length === 0) return 'LIVE';
  return verdicts.every(({ verdict }) => verdict !== 'ok') ? 'STALE' : 'LIVE';
}

/**
 * §3's verdict for every drawn section, from the same `Formatter.staleLabel` call `sectionRow` makes.
 *
 * One source for the phase (`rootPhase`) and for the redraw trigger (`staleKeyOf`): two independent
 * comparisons against the threshold could disagree, and then a section would say `ok` while the
 * machine believed STALE.
 */
function staleVerdicts(state: AppState): { tool: ToolId; verdict: string }[] {
  if (state.unconfigured) return [];
  const payload = state.payload;
  if (payload === null) return [];
  return drawnTools(payload).map((tool) => ({
    tool,
    verdict: Formatter.staleLabel(tool, payload[tool].fetchedAt, state.now, state.settings.pollIntervalMin),
  }));
}

/**
 * Everything §3 currently says about this page, as one comparable string (`claude=ok|codex=stale 10m`).
 *
 * `AppState.staleShown` holds the value that is on the glasses; `TICK` compares the two. The tool
 * names are in the key so that a tool appearing or disappearing (§7 V1) counts as a change too.
 */
export function staleKeyOf(state: AppState): string {
  return staleVerdicts(state)
    .map(({ tool, verdict }) => `${tool}=${verdict}`)
    .join('|');
}

/** Which page is on the glasses in this state — behind the system dialog, the one it covers. */
export function screenIdOf(state: AppState): ScreenId {
  if (isExitDialogPhase(state.phase)) return state.exitFrom === 'menu' ? 'menu' : 'all';
  return state.phase === 'MENU' ? 'menu' : 'all';
}

/** The render input for a state — the single place the FSM meets the T3.2 screens. */
export function screenInputOf(state: AppState): ScreenInput {
  return {
    payload: state.payload,
    unconfigured: state.unconfigured,
    now: state.now,
    settings: state.settings,
    errorCode: state.errorCode,
    cursor: state.cursor,
    notice: state.notice,
    statusNotice: state.statusNotice,
  };
}

/**
 * Redraw the page currently on screen. The menu is always a `rebuildPageContainer`: moving the
 * cursor changes `borderWidth`, `xPosition` and `width`, none of which `textContainerUpgrade` can
 * touch (its `patch()` returns nothing, deliberately). The merged page asks for the flicker-free
 * path; `App.plan` upgrades it to a mount whenever the container set or the geometry moved, which
 * after M6b includes raising or lowering either footer notice.
 */
function redraw(state: AppState): Effect {
  const screen = screenIdOf(state);
  return screen === 'menu' ? { kind: 'mount', screen } : { kind: 'patch', screen };
}

/** Leave MENU back to a root page, recomputing LIVE/STALE from §3 as §10.3(a) requires. */
function leaveMenu(state: AppState): AppState {
  // §7 V5's `coming in v2` sits in the MENU's footer-left slot, so it goes down with the menu. On the
  // root page there is no menu to leave and no notice of the menu's to clear: a §7 V9 answer raised a
  // moment ago keeps the two seconds it was promised (2026-09-10 review — this path is shared with
  // the root page's tap, which used to wipe it).
  const next = state.phase === 'MENU' ? { ...state, notice: null } : state;
  return { ...next, phase: rootPhase(next) };
}

/** Both footer slots cleared — for the transitions where no notice can still be on screen. */
const NO_NOTICES = { notice: null, statusNotice: null } as const;

/**
 * The dialog is gone and the page is ours again: back to whichever page it was covering, with
 * LIVE/STALE re-derived from §3 exactly as leaving the menu does.
 */
function leaveExitDialog(state: AppState): AppState {
  if (state.exitFrom === 'menu') return { ...state, phase: 'MENU' };
  const next: AppState = { ...state, phase: 'LIVE' };
  return { ...next, phase: rootPhase(next) };
}

/**
 * §7 V7 / M6b: raise `refreshing…` in the same transition that asks for the fetch.
 *
 * Shared by the menu's first entry and the root page's tap, because §7 "merged page" makes them the same
 * action — the same 10-second debounce in `poll.ts`, the same notice, the same generation rule.
 * `leaveMenu` is what makes it one path: from the menu it closes the overlay, and on the root page it
 * is a no-op apart from re-deriving §3, which is what the phase should be anyway.
 */
function startRefresh(state: AppState): AppState {
  return { ...leaveMenu(state), statusNotice: REFRESHING };
}

function ack(state: AppState, reason: string): Transition {
  return { next: state, effects: [{ kind: 'ack', reason }] };
}

/**
 * Everything about a container except the text inside it — i.e. everything `textContainerUpgrade`
 * cannot change. Two pages that differ anywhere in here need a `rebuildPageContainer`.
 */
function sameBox(a: TextSpec, b: TextSpec): boolean {
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.x === b.x &&
    a.y === b.y &&
    a.w === b.w &&
    a.h === b.h &&
    a.border === b.border &&
    a.radius === b.radius &&
    a.padding === b.padding &&
    a.brightness === b.brightness &&
    a.capture === b.capture
  );
}

export function initialState(options: {
  payload?: UsagePayload | null;
  unconfigured?: boolean;
  settings?: PluginSettings;
  errorCode?: string | null;
  now: Date;
}): AppState {
  const base: AppState = {
    phase: 'CONNECTING',
    cursor: 0,
    unconfigured: options.unconfigured ?? false,
    payload: options.payload ?? null,
    errorCode: options.errorCode ?? null,
    settings: options.settings ?? DEFAULT_SETTINGS,
    now: options.now,
    notice: null,
    statusNotice: null,
    staleShown: '',
    exitFrom: 'root',
  };
  const phased: AppState = { ...base, phase: rootPhase(base) };
  // The boot render draws these verdicts, so this is what is "on screen" from the first frame on.
  return { ...phased, staleShown: staleKeyOf(phased) };
}

/**
 * §10.3(a), as a pure function. `now` is injected so staleness never reads the wall clock here.
 *
 * The wrapper does one thing on top of the transition table: whenever the merged page is redrawn, the
 * §3 verdicts that redraw carries become `staleShown`. Recording it HERE rather than in each branch
 * is what keeps the tick's comparison honest — a redraw the table produces for any other reason
 * (`DATA`, a notice, a foreground enter) also brings the section rows up to date, so the next tick
 * must not count it as a change. A rolled-back render restores the old value with the rest of the
 * state, because `App.handle` rolls back the whole record.
 */
export function reduce(state: AppState, event: AppEvent, now: Date): Transition {
  const transition = reduceEvent({ ...state, now }, event);
  if (!transition.effects.some((e) => (e.kind === 'mount' || e.kind === 'patch') && e.screen === 'all')) {
    return transition;
  }
  return { next: { ...transition.next, staleShown: staleKeyOf(transition.next) }, effects: transition.effects };
}

/** The §10.3(a) transition table itself; `s` already carries the injected `now`. */
function reduceEvent(s: AppState, event: AppEvent): Transition {
  // The page has been torn down: nothing may draw on it again, and the subscription is already
  // gone. This has to come FIRST, before the phase-independent events below — a retry armed
  // before the exit is still sitting in the dispatch queue when cleanup runs, and clearing the
  // timer cannot recall it. `RENDER` reaching the bridge here would repaint a page the app no
  // longer owns (observed as mount → unsubscribe → mount).
  if (s.phase === 'EXITING') return ack(s, `${event} arrived after the app was torn down`);

  // The user confirmed the system dialog. THIS is where teardown belongs — not next to
  // `shutDownPageContainer`, which the user can still cancel. Ahead of the exit-dialog phases
  // below, because a confirmation outranks everything they say about drawing.
  if (event === 'SYSTEM_EXIT') {
    return { next: { ...s, phase: 'EXITING', ...NO_NOTICES }, effects: [{ kind: 'cleanup' }] };
  }
  // The glasses went away (BLE loss): the host tore the page down, but we are still here. Not a
  // teardown — the page comes back with the glasses (M6 D5). Outranks the exit-dialog phases for
  // the same reason SYSTEM_EXIT does: whatever dialog was up is gone with the page.
  if (event === 'ABNORMAL_EXIT') {
    return { next: { ...s, phase: 'DISCONNECTED', ...NO_NOTICES }, effects: [{ kind: 'suspend' }] };
  }
  if (s.phase === 'DISCONNECTED') return reduceDisconnected(s, event);

  // The dialog is the host's, and so is the screen while it is up. This has to come before the
  // phase-independent events below: `RENDER` and `FOREGROUND_ENTER` both draw, and drawing is the
  // one thing this phase exists to prevent.
  if (isExitDialogPhase(s.phase)) return reduceExitDialog(s, event);

  // ---- events that mean the same thing in every phase -------------------------
  switch (event) {
    case 'FOREGROUND_ENTER': {
      // Re-render whatever was on screen; the glasses may have been showing something else. The
      // phase is re-derived first: the app may have spent ten minutes in the background (M6 D4),
      // which is long enough to cross §3's threshold, and the `TICK` that would have noticed is up
      // to thirty seconds away — the redraw below would otherwise paint a footer saying `stale 12m`
      // out of a machine that still believes it is LIVE.
      const next = isRootPhase(s.phase) ? { ...s, phase: rootPhase(s) } : s;
      return { next, effects: [{ kind: 'mount', screen: screenIdOf(next) }] };
    }
    case 'FOREGROUND_EXIT':
      // T3.4: write the payload cache out before the host migrates us into a headless WebView. The
      // new instance re-runs `main.ts` from scratch, so `localStorage` is the only thing that
      // crosses over — this is what makes coming back from ten minutes in the background (M6 D4)
      // show data rather than `Connecting…`.
      return { next: s, effects: [{ kind: 'flush' }] };
    case 'IGNORED':
      // IMU samples and anything a future firmware adds. Not input, so no feedback is owed.
      return { next: s, effects: [] };
    case 'EXIT_OFFERED':
    case 'EXIT_REFUSED':
    case 'EXIT_CANCELLED':
      // The dialog resolved after the machine had already left the exit phases — a retried
      // `EXIT_REFUSED` arriving behind the cancel that beat it, say. The page is ours and already
      // drawn, so there is nothing left for it to say.
      return { next: s, effects: [] };
    case 'RECONNECTED':
      // The glasses report Connected while we still hold a page (the initial connection, or a
      // status blip that never cost us the page). Nothing to rebuild.
      return { next: s, effects: [] };
    case 'RENDER':
      // "Make the glasses show the state we are in." The first page, and the retry after any
      // render that did not land.
      return { next: s, effects: [{ kind: 'mount', screen: screenIdOf(s) }] };
    case 'DATA': {
      // The runner has already put the poll outcome into `s`. Nothing here looks at whether the
      // fetch succeeded: §3 and §10.3(a) are explicit that LIVE/STALE follows the age of the data
      // and never the outcome of a call, so this recomputes the phase exactly as `TICK` does — and
      // then redraws unconditionally, because the numbers themselves may have moved even when the
      // phase did not. In the menu there is nothing of the payload on screen to update; the phase
      // is re-derived on the way out (`leaveMenu`), from the payload that is by then in place.
      if (!isRootPhase(s.phase)) return { next: s, effects: [] };
      const next = { ...s, phase: rootPhase(s) };
      return { next, effects: [redraw(next)] };
    }
    case 'REFRESH_DONE': {
      // §7 V7: the STATUS notice comes down when the fetch ends, whatever its outcome, and the phase
      // is recomputed from §3 staleness — never from whether the fetch succeeded. Only that notice:
      // a §7 V9 answer in the left slot has its own two seconds and is none of this event's business.
      if (s.statusNotice !== REFRESHING) return { next: s, effects: [] };
      const cleared = { ...s, statusNotice: null };
      const next = isRootPhase(cleared.phase) ? { ...cleared, phase: rootPhase(cleared) } : cleared;
      return { next, effects: [redraw(next)] };
    }
    case 'NOTICE_EXPIRED': {
      // Three notices arm this timer, all in the footer-LEFT slot: §7 V5 in the menu and §7 V9/V10
      // on the root page. It reaches nothing else — the §7 V7 notice lives in its own field, so a late
      // timer cannot take down a `refreshing…` raised after the notice this one belongs to had gone
      // (2026-09-10 review; string identity used to be the only thing telling them apart).
      if (s.notice !== COMING_SOON && s.notice !== ONE_PAGE && s.notice !== SET_ADDRESS_FIRST) {
        return { next: s, effects: [] };
      }
      const next = { ...s, notice: null };
      return { next, effects: [redraw(next)] };
    }
    case 'TICK': {
      // §10.3(a) / §3: the threshold-crossing re-check. A redraw is owed whenever anything §3 says
      // about this page has moved since it was last drawn — the PHASE is not enough, because one tool
      // can cross its own threshold while the other keeps the page LIVE, and then that section's row
      // goes on saying `ok` (2026-09-10 review: Codex 10m → 10m30s with Claude fresh drew nothing).
      // The comparison is against the verdict LABELS as drawn, so the `stale Xm` counter costs one
      // redraw per minute rather than one per tick.
      if (!isRootPhase(s.phase)) return { next: s, effects: [] };
      const next = { ...s, phase: rootPhase(s) };
      const moved = next.phase !== s.phase || staleKeyOf(next) !== s.staleShown;
      return moved ? { next, effects: [redraw(next)] } : { next, effects: [] };
    }
    default:
      break;
  }

  if (s.phase === 'MENU') return reduceMenu(s, event);
  return reduceRoot(s, event);
}

/**
 * `DISCONNECTED` — there is no page on the glasses, so nothing here may draw (§10.3(a)).
 *
 * State still moves: a poll outcome is taken so the reconnect draws current numbers, and the tick
 * keeps the phase-to-be honest. The only way out is `RECONNECTED`, which rebuilds from scratch: the
 * menu or exit dialog that was up belonged to the torn-down page and is not restored.
 */
function reduceDisconnected(s: AppState, event: AppEvent): Transition {
  switch (event) {
    case 'RECONNECTED': {
      const next: AppState = { ...s, cursor: 0, exitFrom: 'root', ...NO_NOTICES, phase: 'LIVE' };
      const back = { ...next, phase: rootPhase(next) };
      return { next: back, effects: [{ kind: 'mount', screen: screenIdOf(back) }] };
    }
    case 'DATA':
    case 'TICK':
    case 'REFRESH_DONE':
    case 'NOTICE_EXPIRED':
      // Taken, not drawn. `TICK`/`DATA` have nothing to record beyond the payload already folded in
      // and the phase, which is re-derived on reconnect anyway; both notices are cleared here so a
      // stale `refreshing…` cannot come back with the page.
      return { next: { ...s, ...NO_NOTICES }, effects: [] };
    case 'FOREGROUND_EXIT':
      return { next: s, effects: [{ kind: 'flush' }] };
    case 'RENDER':
    case 'FOREGROUND_ENTER':
    case 'EXIT_OFFERED':
    case 'EXIT_REFUSED':
    case 'EXIT_CANCELLED':
    case 'IGNORED':
      return { next: s, effects: [] };
    default:
      // A gesture with no page to have come from; the glasses are showing the Dashboard.
      return ack(s, `${event} while disconnected: there is no page to act on`);
  }
}

/**
 * `EXIT_REQUESTED` / `EXIT_OFFERED` — the system dialog is on its way, or up (§10.3(a)).
 *
 * Nothing here produces a draw. The glasses are showing the page the dialog covers, and the app has
 * no way to know whether that page still exists: six review rounds' worth of defects were all a
 * write, or a state move, made in this window. The machine holds still until the dialog resolves
 * one way or the other.
 */
function reduceExitDialog(s: AppState, event: AppEvent): Transition {
  switch (event) {
    case 'EXIT_OFFERED':
      // Everything that arrived before this is already handled — the queue guarantees it — so from
      // here an input can only have been made by someone looking at the dialog.
      return { next: { ...s, phase: 'EXIT_OFFERED' }, effects: [] };
    case 'EXIT_REFUSED': {
      // The request reached nobody: nothing will confirm it and nothing can cancel it. Staying
      // would leave a live page frozen on the picture it had at the moment of the tap.
      const next = leaveExitDialog(s);
      return { next, effects: [{ kind: 'mount', screen: screenIdOf(next) }] };
    }
    case 'EXIT_CANCELLED': {
      // The cancel already happened and its redraw was lost. Re-delivered as ITSELF, never as a
      // bare `RENDER`: `RENDER` means "draw the state we are in", and the state we are in is the
      // one whose whole point is that it does not draw.
      if (s.phase !== 'EXIT_OFFERED') return { next: s, effects: [] };
      const next = leaveExitDialog(s);
      return { next, effects: [{ kind: 'mount', screen: screenIdOf(next) }] };
    }
    case 'REFRESH_DONE':
      // One-shot timers that have already fired. Their STATE has to be taken — a notice nobody
      // ever clears is the §7 V5/V7 defect this app has had three times — but the redraw does not:
      // it comes with the cancel, from `screenInputOf` of a state that is by then correct. Each
      // event still takes down only its OWN slot, as it does on a live page.
      return { next: { ...s, statusNotice: null }, effects: [] };
    case 'NOTICE_EXPIRED':
      return { next: { ...s, notice: null }, effects: [] };
    case 'DATA':
      // The payload is taken — it is already in `s`, and dropping it would mean showing older
      // numbers after the dialog is dismissed than the app has in hand — but nothing is drawn: the
      // page behind the dialog is not ours to write on. The cancel's own redraw renders it.
      return { next: s, effects: [] };
    case 'FOREGROUND_EXIT':
      // Writing the cache is not drawing, so it is owed here as much as anywhere: the phone can go
      // to the background while the dialog is up, and the migrated WebView still needs something
      // to boot from.
      return { next: s, effects: [{ kind: 'flush' }] };
    case 'TICK':
    case 'RENDER':
    case 'IGNORED':
    case 'RECONNECTED':
      return { next: s, effects: [] };
    default: {
      if (s.phase === 'EXIT_REQUESTED' || !FROM_LIVE_PAGE.has(event)) {
        // No dialog yet, so this proves nothing: it came from the page that is on its way out.
        return ack(s, `${event} while the exit request is in flight: no dialog to cancel yet`);
      }
      // The dialog is up, so an input can only mean it was dismissed. It is consumed AS the cancel
      // and does not also perform its own action: the page it would act on is the one that has been
      // sitting behind the dialog, and the user has not seen it since. The redraw is the feedback;
      // the next gesture acts normally.
      const next = leaveExitDialog(s);
      return { next, effects: [{ kind: 'mount', screen: screenIdOf(next) }] };
    }
  }
}

/** UNCONFIGURED / CONNECTING / LIVE / STALE — the one merged page (§10.3(a) root page). */
function reduceRoot(s: AppState, event: UiEvent): Transition {
  switch (event) {
    // §7 V9 (M6b): there is no second page to swipe to, so the swipe answers in the footer-left slot
    // for two seconds — the same mechanism as V5, and the reason §6 rule 5 is still satisfied.
    case 'SCROLL_TOP':
    case 'SCROLL_BOTTOM': {
      // The LEFT slot only. `statusNotice` is deliberately untouched: a `refreshing…` raised by a tap
      // a moment ago owns the right-hand slot until its own fetch ends (§7 V7, 2026-09-10 review).
      const next = { ...s, notice: ONE_PAGE };
      return { next, effects: [redraw(next), { kind: 'noticeTimer', ms: NOTICE_MS }] };
    }
    case 'CLICK': {
      if (s.unconfigured) {
        const next = { ...s, notice: SET_ADDRESS_FIRST };
        return { next, effects: [redraw(next), { kind: 'noticeTimer', ms: NOTICE_MS }] };
      }
      // §7 "merged page": a tap on the root page IS the menu's first entry. Same effect, so the debounce,
      // the V7 notice and its generation rule are shared rather than reimplemented here.
      const next = startRefresh(s);
      return { next, effects: [{ kind: 'refresh' }, redraw(next)] };
    }
    case 'LONG_PRESS':
      // The menu always opens on `Refresh now` (§7 frame C).
      return {
        next: { ...s, phase: 'MENU', cursor: MENU_INDEX.refresh, ...NO_NOTICES },
        effects: [{ kind: 'mount', screen: 'menu' }],
      };
    case 'LONG_PRESS_RELEASE':
      // The press that preceded it already did the visible work (or happened on another page).
      return ack(s, 'long-press release: consumed, no action of its own');
    case 'DOUBLE_CLICK':
      // §10.3(a): hand the exit to the system, do not intercept and do not build our own dialog.
      // NOT `EXITING` — `shutDownPageContainer(1)` only OFFERS the dialog and the user may cancel,
      // in which case this page is still up and still owns the input. EXITING belongs to the
      // CONFIRMED exit (SYSTEM_EXIT / ABNORMAL_EXIT) alone. `EXIT_REQUESTED` is the wait in
      // between, where the screen is no longer ours to write on.
      return {
        next: { ...s, phase: 'EXIT_REQUESTED', exitFrom: 'root', ...NO_NOTICES },
        effects: [{ kind: 'exit' }],
      };
    default:
      return ack(s, `unhandled root event ${event}`);
  }
}

/** MENU — the overlay page (§7 frame C2). */
function reduceMenu(s: AppState, event: UiEvent): Transition {
  const count = menuItems().length;
  switch (event) {
    case 'SCROLL_TOP':
    case 'SCROLL_BOTTOM': {
      const delta = event === 'SCROLL_TOP' ? -1 : 1;
      // The cursor wraps, and §7's footer indicator is the cursor index, so it moves with it.
      const next = { ...s, cursor: (s.cursor + delta + count) % count, notice: null };
      return { next, effects: [{ kind: 'mount', screen: 'menu' }] };
    }
    case 'CLICK':
      return reduceMenuSelect(s);
    case 'DOUBLE_CLICK': {
      // §7 frame C's own header says so: double-tap = back. Inside the menu it is NOT an exit.
      const next = leaveMenu(s);
      return { next, effects: [{ kind: 'mount', screen: 'all' }] };
    }
    case 'LONG_PRESS':
      // Opening the menu from the menu would be a rebuild with nothing changed; say so instead.
      return ack(s, 'long press in the menu: already open, nothing to do');
    case 'LONG_PRESS_RELEASE':
      return ack(s, 'long-press release: consumed, the press was already handled');
    default:
      return ack(s, `unhandled menu event ${event}`);
  }
}

/** §10.3(a) `SELECT_*`. */
function reduceMenuSelect(s: AppState): Transition {
  switch (s.cursor) {
    case MENU_INDEX.refresh: {
      if (s.unconfigured) {
        const next = { ...leaveMenu(s), notice: SET_ADDRESS_FIRST };
        return {
          next,
          effects: [{ kind: 'mount', screen: 'all' }, { kind: 'noticeTimer', ms: NOTICE_MS }],
        };
      }
      // §7 V7: the notice goes up in the same frame the menu comes down, so the feedback is
      // immediate even when the fetch is later swallowed by a debounce. A `mount`, not a `patch`:
      // the glasses are showing the MENU's containers, and `textContainerUpgrade` cannot replace a
      // page — the structural comparison in `App.plan` compares two versions of ONE screen and would
      // not see the overlay coming down.
      const next = startRefresh(s);
      return { next, effects: [{ kind: 'refresh' }, { kind: 'mount', screen: 'all' }] };
    }
    case MENU_INDEX.tokenStats: {
      // §7 V5: the cursor does not move and the menu stays up; the answer is in the footer.
      const next = { ...s, notice: COMING_SOON };
      return { next, effects: [{ kind: 'mount', screen: 'menu' }, { kind: 'noticeTimer', ms: NOTICE_MS }] };
    }
    case MENU_INDEX.exit:
      // Same as the root double-tap: a request, not the end. `exitFrom` is what brings a cancelled
      // dialog back to the menu the user was already looking at, with the cursor where they left it.
      return {
        next: { ...s, phase: 'EXIT_REQUESTED', exitFrom: 'menu', ...NO_NOTICES },
        effects: [{ kind: 'exit' }],
      };
    default:
      return ack(s, `menu cursor ${s.cursor} has no action`);
  }
}

// ---- effect runner -----------------------------------------------------------

/**
 * What `App` uses of the bridge, narrowed so a test can supply it without the SDK. The device-status
 * subscription is optional: it only exists to hear the glasses come back after a BLE loss (M6 D5),
 * and a fake that does not offer it simply never reconnects.
 */
export type AppBridge = Pick<EvenAppBridge, 'onEvenHubEvent' | 'shutDownPageContainer'> &
  Partial<Pick<EvenAppBridge, 'onDeviceStatusChanged'>>;

export interface AppDeps {
  bridge: AppBridge;
  renderer: PageRenderer;
  screens: Readonly<Record<ScreenId, Screen>>;
  /** Injected so tests and the T3.3 fixture build can hold the clock still. */
  clock: () => Date;
  initial: AppState;
  /**
   * T3.4's relay poller. Optional so the reducer-level tests can run without a network at all;
   * without one the app draws whatever `initial` carries and Refresh is feedback only.
   */
  poller?: DataPoller;
  /** Base delay before retrying a lost render; only set in tests, which must not sleep a second. */
  retryMs?: number;
  /** Deadline for one bridge call; only set in tests, which must not sleep for seconds. */
  renderTimeoutMs?: number;
}

/** How often the staleness threshold is re-checked (§10.3(a) "timer crossing the threshold"). */
const TICK_MS = 30_000;
/**
 * §7 V7's floor: `refreshing…` stays up for at least a second.
 *
 * The notice comes down when the fetch ends OR when this elapses, whichever is later. The floor is
 * what makes the two swallowed cases visible — the 10-second debounce in `poll.ts` and the daemon's
 * own 60-second `refresh=1` throttle (§3) both answer in microseconds, and a notice that flickered
 * for one frame would read as an input with no feedback at all (§6 rule 5).
 */
export const REFRESH_NOTICE_MIN_MS = 1000;

/** Retry backoff for a render that did not land — the daemon's 1s → capped pattern (T1.4). */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

/**
 * How long one bridge call gets before the app stops waiting on it.
 *
 * Measured rather than guessed: 10 tool switches through the simulator, timed from `POST
 * /api/input` to the changed frame coming back, ran 16–55 ms (median 32) — and that figure
 * includes the screenshot poll, so the render itself is faster still. 5 s is ~90× the slowest of
 * those and a sixth of `TICK_MS`, so a stalled call cannot swallow a staleness re-check either.
 *
 * The simulator is not BLE, so this is a floor, not the real distribution: the glasses-ui skill
 * warns a flaky hop can stall for tens of seconds. M6 re-measures against the real link — if the
 * device's healthy p99 comes anywhere near this, the number moves rather than the design.
 */
const BRIDGE_DEADLINE_MS = 5000;

export class App {
  private readonly deps: AppDeps;
  private state: AppState;
  private unsubscribe: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** `null` = no failure outstanding; otherwise the delay the next retry will use. */
  private retryDelayMs: number | null = null;
  /** Set when a bridge call was abandoned mid-flight: what the glasses show is no longer known. */
  private screenUnknown = false;
  /** Events still owed a retry. Bounded by `RETRYABLE`; one slot let them cancel each other. */
  private readonly pendingRetries = new Set<AppEvent>();
  /**
   * The most recent poll outcome, waiting to be folded into the state on the queue.
   *
   * It is a field rather than a payload on the event because `DATA` is retryable: an event carrying
   * its own data could not be re-delivered from `pendingRetries`, which holds names. Keeping the
   * LATEST outcome here is also the behaviour we want from a retry — if a newer poll landed while
   * the first redraw was failing, the retry should draw the newer numbers, not resurrect the old.
   */
  private latest: PollOutcome | null = null;
  /** Which Refresh owns the §7 V7 notice; an older one's completion may not take it down. */
  private refreshGeneration = 0;
  /** The generation a `REFRESH_DONE` still owed a retry belongs to; a newer Refresh voids it. */
  private refreshOwedFor = 0;
  /** Serialises dispatches so two gestures can never interleave their bridge calls. */
  private queue: Promise<void> = Promise.resolve();
  /** Whether T3.4's poll loop has been started (PLAN T6b.4 rule 10 — see `startPolling`). */
  private polling = false;

  constructor(deps: AppDeps) {
    this.deps = deps;
    this.state = deps.initial;
  }

  /**
   * Starts listening, then draws the first page. Does NOT start the poll loop — `startPolling` does.
   *
   * That order matters. Subscribing after the first render meant a first render that THREW skipped
   * the subscription and the tick timer entirely — a blank screen that could never receive another
   * event, the worst shape of the §6 rule 5 violation. The queue serialises dispatches, so the
   * `RENDER` below is still the first thing handled even if a gesture arrives in between.
   */
  async start(): Promise<void> {
    this.unsubscribe = this.deps.bridge.onEvenHubEvent((event) => {
      const uiEvent = InputRouter.map(event);
      // §7 / T3.3: the source is logged and nothing more — ring and temple behave identically.
      if (uiEvent !== 'IGNORED') console.log(`QuotaLens: ${uiEvent} (${InputRouter.sourceLabel(event)})`);
      void this.dispatch(uiEvent);
    });
    // M6 D5: the only signal that the glasses are back after a BLE loss. Logged in full — the
    // status carries no secret and M6 needs to see what the host actually sends around a
    // disconnect. `RECONNECTED` is a no-op unless the machine is DISCONNECTED.
    this.unsubscribeStatus =
      this.deps.bridge.onDeviceStatusChanged?.((status) => {
        console.log(`QuotaLens: device status ${status.connectType}`);
        if (status.isConnected()) void this.dispatch('RECONNECTED');
      }) ?? null;
    this.tickTimer = setInterval(() => void this.dispatch('TICK'), TICK_MS);
    // As an event, so a refused or thrown first page is retried like any other lost render.
    await this.dispatch('RENDER');
  }

  /**
   * Start T3.4's poll loop. Separate from `start()` because the boot has one more thing to do first.
   *
   * PLAN T6b.4 rule 10 puts the first glasses page in front of the hydrate, so at `start()` the
   * shared store is still the browser mirror — and on the Even App that mirror is either EMPTY (the
   * packaged build: the poller would read `relayUrl: ''`, fetch nothing, and arm the 30-second
   * UNCONFIGURED retry, so the first real request waits half a minute over a reachable relay) or
   * STALE (a sideloaded build repointed since: one request to yesterday's endpoint, whose answer is
   * then cached over the new one's). Both were the 2026-09-10 codex finding.
   *
   * So the boot starts the loop after the hydrate has filled the store (`boot.ts`), and the first
   * fetch goes out immediately with the URL the host is actually holding.
   */
  startPolling(): void {
    // Once. `startThenHydrate` is the only caller, but a second loop would double the request rate
    // against the relay and is invisible until someone reads the daemon's log.
    if (this.polling) return;
    // …and never after the exit: the boot awaits the hydrate, and the user can confirm the system
    // exit dialog while it is running. `stop()` has then torn the app down, and starting the poll
    // loop now would keep requests, cache writes and bridge storage work going behind a page that no
    // longer exists (2026-09-10 codex review probe: `phase EXITING, pollStarts 1`).
    if (this.current.phase === 'EXITING') return;
    this.polling = true;
    this.deps.poller?.start((outcome) => void this.deliver(outcome));
  }

  /**
   * Hand a poll outcome to the machine (T3.4).
   *
   * The state is not touched here — it is folded in inside `handle`, on the dispatch queue, so the
   * payload lands in the same serialised order as everything else and a failed redraw can roll it
   * back to what the glasses are still showing.
   */
  deliver(outcome: PollOutcome): Promise<void> {
    this.latest = outcome;
    return this.dispatch('DATA');
  }

  /**
   * Serialised, and each event's failure is contained to that event.
   *
   * Chaining with `.then()` alone left the queue promise rejected for good: every later dispatch
   * inherited the rejection and its handler never ran, so one flaky bridge call turned into an app
   * that still had a page on the glasses, still received events, and answered none of them — with
   * cleanup unreachable too. The `catch` here is what keeps the next gesture, and the teardown,
   * alive. The caller is `void`ed from the event listener, so this must never reject.
   *
   * ponytail: this contains a REJECTED bridge call, not a hung one. A call that never settles still
   * stalls the queue; the glasses-ui skill warns a flaky BLE hop can hang ~30s. A per-call deadline
   * belongs with T3.4's real fetch, where there is measured latency to size it against — picking a
   * timeout here would be a guess.
   */
  dispatch(event: AppEvent, refreshToken?: number): Promise<void> {
    const run = this.queue.then(() => this.handle(event, refreshToken)).catch((error: unknown) => {
      console.error(`QuotaLens: dispatching ${event} failed —`, error);
    });
    this.queue = run;
    return run;
  }

  /**
   * The redraw is the commit point.
   *
   * The state has to be advanced before rendering — the effect draws `next`, not the state the
   * event arrived in. But if that draw does not land, the glasses are still showing the OLD state
   * while the machine holds the new one, and the machine is what interprets the next gesture. In
   * the menu that is a wrong action, not just a stale pixel: the cursor visibly sits on
   * `Token stats · soon` while the machine has moved to `Exit`, so the next tap quits the app.
   *
   * So a failed render rolls the state back to what the glasses are still showing. The two agree
   * again, the gesture is simply lost, and the next gesture (or the next tick) retries it. Timers
   * armed earlier in the same batch are harmless afterwards: `REFRESH_DONE` and `NOTICE_EXPIRED`
   * both no-op unless the notice they belong to is still set.
   */
  private async handle(incoming: AppEvent, refreshToken?: number): Promise<void> {
    // Checked HERE, at the head of the queue, not where the completion was created: between those
    // two moments a second Refresh can be queued and run, and then this one is answering for a
    // request nobody is waiting on — it would take down a notice that went up 500ms ago and break
    // §7 V7's floor. The token travels with the dispatch, so a retry is checked on the same terms.
    if (incoming === 'REFRESH_DONE' && refreshToken !== undefined && refreshToken !== this.refreshGeneration) {
      console.log('QuotaLens: a superseded REFRESH_DONE reached the queue and was dropped');
      return;
    }
    // Until a render confirms what the glasses show, an action gesture buys the repair redraw
    // instead of its action: the page comes back in sync (the visible feedback §6 rule 5 owes the
    // gesture) and the user presses again, exactly as they do for any other rolled-back gesture.
    // Not in the exit phases: there a gesture is already answered as the cancel, which redraws the
    // page the dialog covered — it IS the resync, so freezing it into a `RENDER` (which those
    // phases ignore by design) would take away the one input that can put the page back.
    const frozen =
      this.screenUnknown && ACTION_EVENTS.has(incoming) && !isExitDialogPhase(this.state.phase);
    if (frozen) console.log(`QuotaLens: ${incoming} resynced the screen instead of acting on an unconfirmed one`);
    const event: AppEvent = frozen ? 'RENDER' : incoming;
    const shown = this.state;
    const { next, effects } = reduce(this.withLatestData(this.state, event), event, this.deps.clock());
    this.state = next;
    try {
      for (const effect of this.plan(effects, shown)) {
        if (await this.apply(effect)) continue;
        console.error(`QuotaLens: ${effect.kind} refused for ${event}; state rolled back to what is on screen`);
        this.state = shown;
        this.scheduleRetry(event);
        return;
      }
      this.retryDelayMs = null; // a render landed, so the next failure starts from the base delay
      // An owed exit event is a claim about ONE dialog: `EXIT_CANCELLED` says "the user dismissed
      // it and the redraw was lost", `EXIT_REFUSED` says "the host never got it". Once anything has
      // drawn from a state outside those phases, both claims are settled — and an unsettled one
      // would fire later against whatever dialog is up THEN, dismissing a request the user had
      // just made (measured: state left `EXIT_OFFERED` with no input, one extra rebuild).
      if (!isExitDialogPhase(this.state.phase)) {
        this.pendingRetries.delete('EXIT_CANCELLED');
        this.pendingRetries.delete('EXIT_REFUSED');
      }
    } catch (error) {
      // A bridge call that throws is the same situation as one that returns `false`: the glasses
      // did not take the change. `dispatch` also catches, but only to keep the queue alive — the
      // rollback has to happen here, where the pre-event state is still in hand.
      console.error(`QuotaLens: ${event} threw mid-effect; state rolled back to what is on screen —`, error);
      this.state = shown;
      this.scheduleRetry(event);
    }
  }

  /**
   * Fold the latest poll outcome into the state a `DATA` event is about to be reduced against.
   *
   * `reduce` stays pure and keeps its `(state, event, now)` shape: the outcome is data, not a
   * decision, and the decision it feeds — LIVE or STALE — is made by §3 inside the reducer. The
   * relay URL never crosses over; `PollOutcome.settings` is the two display fields only (§6).
   */
  private withLatestData(state: AppState, event: AppEvent): AppState {
    if (event !== 'DATA' || this.latest === null) return state;
    return {
      ...state,
      payload: this.latest.payload,
      errorCode: this.latest.errorCode,
      settings: this.latest.settings,
      unconfigured: this.latest.unconfigured,
    };
  }

  /**
   * Turn a `patch` into a `mount` when the page's shape changed.
   *
   * `textContainerUpgrade` can only rewrite the text of containers that are already there, at the
   * geometry they were mounted with (screens/tool.ts says as much and leaves this call to T3.4).
   * New data can change that shape: §3 hides a row whose window is null (the owner's Codex account
   * has no 5h window, so its card is one row), and §7 V2's `Connecting…` card is a different
   * container set entirely. Patching across either one would upgrade containers that no longer
   * match — the SDK fails those silently, leaving a half-old page.
   *
   * The comparison is structural rather than a rule about payload fields: it asks the screens
   * themselves what they would build, so a future row or a card that resizes is covered without
   * anyone remembering to add it here.
   */
  private plan(effects: readonly Effect[], shown: AppState): Effect[] {
    return effects.map((effect) => {
      if (effect.kind !== 'patch') return effect;
      return this.relayout(effect.screen, shown) ? { kind: 'mount', screen: effect.screen } : effect;
    });
  }

  private relayout(id: ScreenId, shown: AppState): boolean {
    const screen = this.deps.screens[id];
    const before = screen.buildContainers(screenInputOf(shown));
    const after = screen.buildContainers(screenInputOf(this.state));
    if (before.length !== after.length) return true;
    return before.some((spec, i) => !sameBox(spec, after[i]));
  }

  /**
   * Re-dispatch an event whose render was lost, backing off 1s → 30s so a disconnected bridge is
   * not hammered once a second. Only one retry is ever outstanding: a later failure replaces it,
   * and the delay resets as soon as any render lands.
   */
  private scheduleRetry(event: AppEvent): void {
    // A timeout leaves the screen in an unknown condition — the abandoned call may still have
    // painted before it was invalidated — so it always earns a repair redraw, even for a gesture
    // that would otherwise just be dropped. `RENDER` redraws the state we rolled back to, which
    // is what puts the glasses and the machine back in agreement.
    // A retryable event is re-delivered AS ITSELF, never swapped for a bare `RENDER`. Substituting
    // one throws the event's meaning away: a timed-out `REFRESH_DONE` becomes "redraw the state we
    // rolled back to", which still carries `refreshing…` — and nothing is left to take it down, so
    // the notice sits there hiding the §3 status. Its own redraw repairs the screen anyway.
    // `RENDER` is only for the case with no event worth re-delivering: a gesture, which is dropped,
    // except after a timeout, where the screen is unknown and has to be repainted regardless.
    // The flag is NOT cleared here: scheduling a repair is not the same as having drawn one. It
    // stays up until a `mount` actually lands, which is what makes the freeze in `handle` cover
    // the whole window rather than only the instant of the timeout.
    // A lost draw in `EXIT_OFFERED` is always the cancel — it is the only thing that draws there —
    // and it is owed however it was lost, not only after a timeout. Keying this off `screenUnknown`
    // covered the deadline and missed the other two ways a render fails: a `false` and a throw both
    // left nothing owed, and the machine sat in a phase that ignores `TICK` and `RENDER`, so the
    // staleness clock stopped until the user happened to press something (measured: an hour of
    // `TICK`s with no update, against a control that goes STALE on time).
    //
    // Unlike an ordinary rolled-back gesture, this one may not be dropped: the dismissal ALREADY
    // HAPPENED, in the host's dialog, outside anything we control. That makes it a completion
    // event like `REFRESH_DONE`, not a request — and a bare `RENDER` cannot stand in for it, since
    // `EXIT_OFFERED` ignores those by design (in `EXIT_REQUESTED` nothing has been cancelled yet,
    // so a stray one must never dismiss a dialog the user has not touched).
    const toRetry: AppEvent | null = RETRYABLE.has(event)
      ? event
      : this.state.phase === 'EXIT_OFFERED'
        ? 'EXIT_CANCELLED'
        : this.screenUnknown
          ? 'RENDER'
          : null;
    if (toRetry === null || this.state.phase === 'EXITING') return;
    // Every event still owed a retry is kept, not just the most recent one. A single slot meant a
    // later failing `RENDER` silently cancelled the `REFRESH_DONE` that had not been re-delivered
    // yet — and that is the stranded `refreshing…` again, by a third route. The set is bounded by
    // `RETRYABLE`, so at most three entries can ever be outstanding.
    // A `REFRESH_DONE` that has to be re-delivered remembers WHICH Refresh it completes. The
    // generation check at dispatch time cannot cover the retry: by the time the timer fires, a
    // newer Refresh may own the notice, and taking it down 500ms in breaks §7 V7 all the same.
    if (toRetry === 'REFRESH_DONE') this.refreshOwedFor = this.refreshGeneration;
    this.pendingRetries.add(toRetry);
    this.retryDelayMs = Math.min(
      this.retryDelayMs === null ? this.deps.retryMs ?? RETRY_BASE_MS : this.retryDelayMs * 2,
      RETRY_MAX_MS,
    );
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      const owed = [...this.pendingRetries];
      this.pendingRetries.clear();
      for (const pending of owed) {
        // Re-delivered with the generation it belongs to; `handle` drops it at the head of the
        // queue if a newer Refresh has taken the notice over by then. Dropping it is not losing a
        // completion event — it is refusing to answer for a request nobody is waiting on, and the
        // newer Refresh has its own completion coming.
        void this.dispatch(pending, pending === 'REFRESH_DONE' ? this.refreshOwedFor : undefined);
      }
    }, this.retryDelayMs);
  }

  /**
   * The page is ours again: resume drawing, and repaint if the pause skipped anything. The repaint
   * is queued rather than done here, so whatever event lifted the pause draws its own consequence
   * first; it only runs at all if a write was actually skipped.
   */
  /** `false` means the glasses did not take the change — see the rollback in `handle`. */
  private async apply(effect: Effect): Promise<boolean> {
    switch (effect.kind) {
      case 'mount':
      case 'patch':
        return this.render(effect);
      case 'refresh': {
        // Only the NEWEST Refresh may take the notice down. Without this, a first request that
        // outlives its own one-second floor comes back after a second Refresh has raised a fresh
        // `refreshing…` and clears it on the spot — the §7 V7 floor, violated by the completion of
        // a request the user has already superseded.
        const generation = (this.refreshGeneration += 1);
        // §7 V7: the notice comes down when the fetch ends or after the one-second floor, whichever
        // is later — "whether swallowed by the 10-second debounce or the daemon 60-second throttle, show it for at least 1 second". Both halves are
        // needed: without the floor a swallowed refresh flickers, and without waiting for the fetch
        // a slow one would clear `refreshing…` while the request is still out.
        //
        // Not awaited: the refresh travels its own path to the daemon, and blocking the dispatch
        // queue on it would freeze input and the staleness tick for the length of a network call.
        // `poll.ts` never rejects, but the `catch` is kept anyway — a rejection here would mean
        // `REFRESH_DONE` is never dispatched and the notice stays up forever, hiding §3's status.
        const fetched = (this.deps.poller?.refresh() ?? Promise.resolve()).catch((error: unknown) => {
          console.error('QuotaLens: the refresh failed —', error);
        });
        if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
        const floor = new Promise<void>((resolve) => {
          this.refreshTimer = setTimeout(resolve, REFRESH_NOTICE_MIN_MS);
        });
        void Promise.all([fetched, floor]).then(() => this.dispatch('REFRESH_DONE', generation));
        return true;
      }
      case 'flush':
        // Cheap and idempotent: `poll.ts` writes the cache on every successful poll, so this only
        // matters when the host migrates us between two of them.
        this.deps.poller?.flush();
        return true;
      case 'noticeTimer':
        if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
        this.noticeTimer = setTimeout(() => void this.dispatch('NOTICE_EXPIRED'), effect.ms);
        return true;
      case 'exit':
        // Nothing is torn down first: `shutDownPageContainer(1)` only OFFERS the system dialog and
        // the user may cancel it. Unsubscribing here would leave a live page that ignores input.
        //
        // Not awaited, and deliberately not `bounded`: the request is fire-and-forget, so there is
        // nothing to wait FOR — and a deadline answered a question it cannot answer, reporting
        // "sent" when it had only stopped waiting. The answer comes back as an EVENT instead, so
        // it lands on the same queue as everything else and the machine, not a flag, decides what
        // it means. `EXIT_REQUESTED` already blocks a second request: this effect is only produced
        // on the way into that phase.
        //
        // It still goes through the renderer's queue: this is the App's only bridge call of its
        // own and it travels the same serial link as the renders (measured in-flight 2 when it did
        // not, against 1 on the normal path).
        void this.deps.renderer.enqueue(() => this.deps.bridge.shutDownPageContainer(1)).then(
          (offered) => {
            if (!offered) console.error('QuotaLens: the host refused the exit request');
            void this.dispatch(offered ? 'EXIT_OFFERED' : 'EXIT_REFUSED');
          },
          (error: unknown) => {
            console.error('QuotaLens: the exit request threw —', error);
            void this.dispatch('EXIT_REFUSED');
          },
        );
        return true;
      case 'cleanup':
        this.stop();
        return true;
      case 'suspend':
        // The page is gone; nothing that was in flight may land on it, and the next mount has to
        // create the page anew. Everything else stays up: the poller, the tick, both subscriptions.
        this.deps.renderer.pageLost();
        this.pendingRetries.clear();
        this.screenUnknown = false;
        return true;
      case 'ack':
        console.log(`QuotaLens: ${effect.reason}`);
        return true;
    }
  }

  /**
   * A bounded wait around one bridge call.
   *
   * Every event is serialised onto one queue, so a call that never settles takes the whole app
   * with it — input, the staleness tick, and the teardown that is supposed to be the way out.
   * The BLE link makes that a real shape of failure rather than a hypothetical one: a flaky hop
   * can stall for tens of seconds (glasses-ui skill). There is no way to cancel the call, so the
   * deadline only stops US waiting; a late result is discarded, and because a timed-out render
   * counts as failed, a `RENDER` retry follows and repaints whatever the late call may have drawn.
   */
  /** A call we abandoned has now finished; redraw so its write cannot be the last one on screen. */
  private repairAfterLateWrite(): void {
    if (this.state.phase === 'EXITING') return;
    void this.dispatch('RENDER');
  }

  private async bounded<T>(what: string, work: Promise<T>, onTimeout: T, writes: boolean): Promise<T> {
    const ms = this.deps.renderTimeoutMs ?? BRIDGE_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<T>((resolve) => {
      timer = setTimeout(() => {
        console.error(`QuotaLens: ${what} did not answer within ${ms}ms; giving up on this attempt`);
        // Everything below repairs a page this call may have WRITTEN. A `shutDownPageContainer`
        // writes nothing — it asks the host for the exit dialog — so a late answer to it has
        // nothing to repair, and repairing anyway rebuilt a page that was on its way out. The
        // `EXITING` guard does not save that: the confirmation reaches the host, not us, and the
        // simulator never sends `SYSTEM_EXIT` at all (§8). So the distinction is the parameter,
        // not a phase check.
        if (!writes) {
          resolve(onTimeout);
          return;
        }
        // Abandoning the WAIT is not abandoning the WORK. Until the renderer is told, the call is
        // still on its way and a multi-container patch is still issuing the rest of its batch.
        this.deps.renderer.invalidate();
        this.screenUnknown = true;
        // `invalidate()` stops calls that have not been ISSUED yet. The one we just gave up on is
        // already with the bridge, and whatever it writes lands whenever it lands — possibly after
        // the repair redraw scheduled below has already run. So repair again once it has actually
        // finished: at that point nothing else can arrive from it, which makes this the fixed point
        // rather than another race.
        void work.then(
          () => this.repairAfterLateWrite(),
          () => this.repairAfterLateWrite(),
        );
        resolve(onTimeout);
      }, ms);
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async render(effect: { kind: 'mount' | 'patch'; screen: ScreenId }): Promise<boolean> {
    const screen = this.deps.screens[effect.screen];
    const input = screenInputOf(this.state);
    if (effect.kind === 'mount') {
      // A failed mount leaves the glasses blank, which §6 rule 5 forbids outright — so it is loud.
      const ok = await this.bounded(`mount "${screen.id}"`, this.deps.renderer.mount(screen, input), false, true);
      if (!ok) console.error(`QuotaLens: failed to mount "${screen.id}"`);
      // A landed mount repaints every container, so this is the one thing that can say the glasses
      // and the machine agree again. A `patch` cannot: it only rewrites the containers that
      // changed, and would leave a wrong PAGE underneath it.
      if (ok) this.screenUnknown = false;
      return ok;
    }
    return this.bounded(`patch "${screen.id}"`, this.deps.renderer.patch(screen.patch(input)), false, true);
  }

  /** Releases the subscriptions and every timer. Only reached via SYSTEM_EXIT. */
  stop(): void {
    // Before anything else: a render abandoned earlier is still mid-batch, and the exit guard in
    // `reduce` cannot see it because those writes come from work already in flight, not from a
    // new dispatch. This is what stops containers being written after the page is torn down.
    this.deps.renderer.invalidate();
    // Before the timers: a poll still in flight would otherwise deliver into a torn-down app. It
    // could not draw — `reduce` acks everything in `EXITING` — but the request would still be out
    // over a link the host is closing.
    this.deps.poller?.stop();
    this.pendingRetries.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeStatus?.();
    this.unsubscribeStatus = null;
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    this.noticeTimer = null;
    this.refreshTimer = null;
    this.retryTimer = null;
    this.tickTimer = null;
  }

  /** Test/debug accessor; the state itself is only ever replaced through `reduce`. */
  get current(): AppState {
    return this.state;
  }
}
