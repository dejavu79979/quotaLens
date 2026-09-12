// Fixed +10:00 zone, for the same reason as screens.test.ts: the §7 fixtures are all `+10:00`.
process.env.TZ = 'Australia/Brisbane';

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { UsagePayload } from '@quotalens/shared';
import {
  initialState,
  reduce,
  screenIdOf,
  screenInputOf,
  type AppEvent,
  type AppState,
  type Effect,
  type Phase,
  type ScreenId,
} from './app.ts';
import { CLAUDE_ONLY_PAYLOAD, DEMO_NOW, DEMO_PAYLOAD, NO_DATA_PAYLOAD } from './fixtures.ts';
import type { UiEvent } from './input.ts';
import { validatePage, type Screen } from './render.ts';
import { COMING_SOON, MENU_INDEX, menuItems, menuScreen } from './screens/menu.ts';
import { allScreen, ONE_PAGE, REFRESHING } from './screens/tool.ts';

const SCREENS: Record<ScreenId, Screen> = { all: allScreen, menu: menuScreen };

/**
 * One tool's section row — the line §3's per-tool `ok`/`stale Xm` verdict lives on after M6b. Found
 * by its label rather than by index, so a change in row counts cannot make this read another tool.
 */
function sectionValue(state: AppState, tool: 'claude' | 'codex'): string {
  const specs = allScreen.buildContainers(screenInputOf(state));
  // §7 "dim section rows" (2026-09-10): the section rows live in the two dim containers now, and the
  // primary pair leaves those lines empty — so this reads `secLabels`/`secStatus`, not the card.
  const labels = specs.find((s) => s.name === 'secLabels')?.content.split('\n') ?? [];
  const values = specs.find((s) => s.name === 'secStatus')?.content.split('\n') ?? [];
  const row = labels.indexOf(tool === 'claude' ? 'CLAUDE' : 'CODEX');
  assert.ok(row >= 0, `the ${tool} section is not on the page at all`);
  return values[row];
}

/**
 * The G1 fixture: Claude was fetched 21s before `DEMO_NOW`, Codex 23m before it. §10.3(a) after M6b
 * needs EVERY drawn tool past its own threshold for STALE, so this state is LIVE — one fresh section
 * is enough, even though the CODEX section row itself says `stale 23m`.
 */
const live = () => initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW });
/**
 * The same payload twenty minutes later: 12:24 is past Claude's 20-minute threshold as well as
 * Codex's 10-minute one, so every drawn section is stale and so is the machine.
 */
const STALE_NOW = new Date('2026-09-07T12:24:00+10:00');
const stale = () => initialState({ payload: DEMO_PAYLOAD, now: STALE_NOW });
const connecting = () => initialState({ payload: null, now: DEMO_NOW, errorCode: 'net err' });
const unconfigured = () => initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW, unconfigured: true });
const menu = (): AppState => ({ ...live(), phase: 'MENU', cursor: MENU_INDEX.refresh });

/** The exit request is in flight: the dialog is not up yet, so nothing here is a cancel. */
const exitRequested = (): AppState => ({ ...live(), phase: 'EXIT_REQUESTED', exitFrom: 'root' });
/** The host has it and the dialog is up: an input can only mean the user dismissed it. */
const exitOffered = (): AppState => ({ ...live(), phase: 'EXIT_OFFERED', exitFrom: 'root' });

/** The glasses are gone (BLE loss): no page exists, so nothing may draw until they are back. */
const disconnected = (): AppState => ({ ...live(), phase: 'DISCONNECTED' });

const STATES: Record<Exclude<Phase, 'EXITING'>, () => AppState> = {
  UNCONFIGURED: unconfigured,
  CONNECTING: connecting,
  LIVE: live,
  STALE: stale,
  MENU: menu,
  EXIT_REQUESTED: exitRequested,
  EXIT_OFFERED: exitOffered,
  DISCONNECTED: disconnected,
};

/** The six inputs PLAN §6 allows, in the shape `InputRouter` hands them over. */
const INPUTS: UiEvent[] = [
  'SCROLL_TOP',
  'SCROLL_BOTTOM',
  'CLICK',
  'DOUBLE_CLICK',
  'LONG_PRESS',
  'LONG_PRESS_RELEASE',
];

/**
 * `now` defaults to the state's OWN clock rather than to `DEMO_NOW`: after M6b a fixture is made
 * stale by moving the clock, not by choosing a tool, so a fixed default would silently re-derive
 * every `stale()` case back to LIVE.
 */
function step(state: AppState, event: AppEvent, now: Date = state.now) {
  return reduce(state, event, now);
}

// ---- the fixtures are what they claim to be ---------------------------------

test('each phase fixture really starts in that phase', () => {
  // Without this the table below could be four copies of the same LIVE state and still pass.
  for (const [phase, build] of Object.entries(STATES)) {
    assert.equal(build().phase, phase);
  }
});

// ---- §6 rule 5: every input, in every state, produces feedback ----------------

/**
 * `ack` reports an event that was consumed on purpose but changes nothing on screen. §10.3(a)
 * allows exactly two such cells: the tail of a long press (anywhere), and a long press while the
 * menu is already open. Anywhere else, an ack-only outcome means an input went unanswered.
 */
function ackIsAllowed(phase: Phase, event: UiEvent): boolean {
  if (event === 'LONG_PRESS_RELEASE') return true;
  // While the exit request is in flight the screen belongs to the host, not to us: the app has
  // asked for the system dialog and cannot draw over it, and it cannot know whether the page is
  // even still there. The visible answer to the gesture is the dialog itself. This is the one
  // window where §6 rule 5 is satisfied by something the app did not draw — and it is bounded, by
  // construction: the request always answers, and `EXIT_OFFERED` below is back to normal rules.
  if (phase === 'EXIT_REQUESTED') return true;
  // No page on the glasses at all (they are showing the Dashboard); a gesture cannot have come
  // from us and there is nothing to draw its feedback on. The visible answer is the reconnect.
  if (phase === 'DISCONNECTED') return true;
  return phase === 'MENU' && event === 'LONG_PRESS';
}

function isVisible(effect: Effect): boolean {
  return effect.kind !== 'ack';
}

for (const [phase, build] of Object.entries(STATES)) {
  for (const event of INPUTS) {
    test(`§6 rule 5 — ${phase} × ${event} produces feedback`, () => {
      const { effects } = step(build(), event);
      assert.ok(
        effects.length > 0,
        `${phase} × ${event}: no effects at all — this input would do nothing and say nothing`,
      );
      if (!ackIsAllowed(phase as Phase, event)) {
        assert.ok(
          effects.some(isVisible),
          `${phase} × ${event}: only acknowledged (${effects.map((e) => e.kind).join(', ')}), nothing visible changed`,
        );
      }
    });
  }
}

test('§6 rule 5 — no input leaves the glasses blank', () => {
  for (const [phase, build] of Object.entries(STATES)) {
    for (const event of INPUTS) {
      const { next } = step(build(), event);
      const specs = SCREENS[screenIdOf(next)].buildContainers(screenInputOf(next));
      assert.deepEqual(validatePage(specs), [], `${phase} × ${event}: illegal page`);
      assert.ok(specs.length > 0, `${phase} × ${event}: page has no containers`);
      assert.ok(
        specs.every((s) => s.content.trim().length > 0),
        `${phase} × ${event}: a container ended up empty`,
      );
    }
  }
});

// ---- the merged root page (§10.3(a) CONNECTING / LIVE / STALE, M6b) ----------

test('§7 V9 — a swipe answers in the footer and turns no page, from every root phase', () => {
  for (const build of [connecting, live, stale, unconfigured]) {
    for (const event of ['SCROLL_TOP', 'SCROLL_BOTTOM'] as const) {
      const before = build();
      const { next, effects } = step(before, event);
      assert.equal(next.phase, before.phase, `${event} moved the machine off ${before.phase}`);
      assert.equal(next.notice, ONE_PAGE, `${event}: no §7 V9 notice`);
      assert.deepEqual(effects, [{ kind: 'patch', screen: 'all' }, { kind: 'noticeTimer', ms: 2000 }], event);
      // The notice really is on the footer's LEFT, at primary brightness (§7 V9).
      const specs = allScreen.buildContainers(screenInputOf(next));
      assert.equal(specs.find((s) => s.name === 'ftrLeft')?.content, 'one page · hold menu');
      assert.equal(specs.find((s) => s.name === 'ftrLeft')?.brightness, 4);
    }
  }
});

test('§7 V9 — the notice comes down after two seconds and the hint comes back', () => {
  const swiped = step(live(), 'SCROLL_TOP').next;
  const expired = step(swiped, 'NOTICE_EXPIRED');
  assert.equal(expired.next.notice, null);
  assert.deepEqual(expired.effects, [{ kind: 'patch', screen: 'all' }]);
  assert.equal(
    allScreen.buildContainers(screenInputOf(expired.next)).find((s) => s.name === 'ftrLeft')?.content,
    'tap refresh · hold menu',
  );
});

test('a late V9 timer cannot wipe a refreshing… raised after the swipe (§7 V7)', () => {
  // The V9 timer is armed for two seconds; a Refresh pressed inside that window raises the STATUS
  // notice, and the expiring timer takes down only the left slot it belongs to.
  const swiped = step(live(), 'SCROLL_TOP').next;
  const refreshed = step(swiped, 'CLICK').next;
  assert.equal(refreshed.statusNotice, REFRESHING);
  assert.equal(refreshed.notice, ONE_PAGE, 'the tap wiped the swipe answer it had nothing to do with');
  const late = step(refreshed, 'NOTICE_EXPIRED');
  assert.equal(late.next.statusNotice, REFRESHING, 'the V9 timer took the V7 notice down with it');
  assert.equal(late.next.notice, null);
  assert.deepEqual(late.effects, [{ kind: 'patch', screen: 'all' }]);
});

test('§7 V7 / V9 — a swipe right after a tap does not take refreshing… down', () => {
  // The reviewer's reproduction (2026-09-10): a tap raises `refreshing…` in the footer STATUS column
  // and a swipe 100ms later answers in the footer-LEFT slot. They are two slots with two lifetimes:
  // raising the left one must not clear the right one, or §7 V7's notice vanishes before its fetch
  // has ended and before its one-second floor is up.
  const tapped = step(live(), 'CLICK').next;
  assert.equal(tapped.statusNotice, REFRESHING, 'the premise: the tap is a Refresh (§7 "merged page")');

  const swiped = step(tapped, 'SCROLL_TOP', new Date(tapped.now.getTime() + 100));
  assert.equal(swiped.next.statusNotice, REFRESHING, '§7 V7: the swipe took the refresh notice down');
  assert.equal(swiped.next.notice, ONE_PAGE, '§7 V9: the swipe still answers on the left');
  const specs = allScreen.buildContainers(screenInputOf(swiped.next));
  assert.equal(specs.find((s) => s.name === 'ftrRight')?.content, REFRESHING, 'V7 lost its slot');
  assert.equal(specs.find((s) => s.name === 'ftrLeft')?.content, ONE_PAGE, 'V9 lost its slot');

  // The V9 timer takes down the LEFT notice it belongs to, and only that…
  const expired = step(swiped.next, 'NOTICE_EXPIRED');
  assert.equal(expired.next.notice, null);
  assert.equal(expired.next.statusNotice, REFRESHING, 'the V9 timer cleared the V7 notice');
  // …and the fetch ending is what takes the status notice down (§7 V7).
  const done = step(expired.next, 'REFRESH_DONE');
  assert.equal(done.next.statusNotice, null);
  assert.equal(
    allScreen.buildContainers(screenInputOf(done.next)).find((s) => s.name === 'ftrRight'),
    undefined,
    'the status column has nothing left to say and must not be built at all',
  );
});

test('§7 "merged page" — a tap on the root page IS Refresh now, from every root phase', () => {
  for (const build of [connecting, live, stale]) {
    const before = build();
    const { next, effects } = step(before, 'CLICK');
    assert.equal(next.phase, before.phase, 'a Refresh does not move the phase by itself (§3)');
    assert.equal(next.statusNotice, REFRESHING, '§7 V7: the notice goes up on the press');
    assert.deepEqual(effects, [{ kind: 'refresh' }, { kind: 'patch', screen: 'all' }]);
    // …and the notice is in the footer STATUS column, exactly as the menu's entry puts it.
    const specs = allScreen.buildContainers(screenInputOf(next));
    assert.equal(specs.find((s) => s.name === 'ftrRight')?.content, REFRESHING);
  }
});

test('V10 — UNCONFIGURED overrides cache and tap only asks the owner to set the address', () => {
  const before = unconfigured();
  assert.equal(before.phase, 'UNCONFIGURED');
  assert.deepEqual(before.payload, DEMO_PAYLOAD, 'the fixture must prove that setup overrides cache');

  const tapped = step(before, 'CLICK');
  assert.equal(tapped.next.phase, 'UNCONFIGURED');
  assert.equal(tapped.next.notice, 'set the address first');
  assert.ok(!tapped.effects.some((effect) => effect.kind === 'refresh'), 'tap fetched without a relay');
  assert.deepEqual(tapped.effects, [
    { kind: 'patch', screen: 'all' },
    { kind: 'noticeTimer', ms: 2000 },
  ]);

  const expired = step(tapped.next, 'NOTICE_EXPIRED');
  assert.equal(expired.next.notice, null);
  assert.deepEqual(expired.effects, [{ kind: 'patch', screen: 'all' }]);
});

test('V10 — Refresh now leaves the menu without fetching while the relay is unconfigured', () => {
  const selected = step({ ...unconfigured(), phase: 'MENU', cursor: MENU_INDEX.refresh }, 'CLICK');
  assert.equal(selected.next.phase, 'UNCONFIGURED');
  assert.equal(selected.next.notice, 'set the address first');
  assert.ok(!selected.effects.some((effect) => effect.kind === 'refresh'));
  assert.deepEqual(selected.effects, [
    { kind: 'mount', screen: 'all' },
    { kind: 'noticeTimer', ms: 2000 },
  ]);
});

test('V10 — DATA moves between UNCONFIGURED and the ordinary root phases', () => {
  const connectingAgain = step({ ...unconfigured(), payload: null, unconfigured: false }, 'DATA');
  assert.equal(connectingAgain.next.phase, 'CONNECTING');
  const liveAgain = step({ ...unconfigured(), unconfigured: false }, 'DATA');
  assert.equal(liveAgain.next.phase, 'LIVE');
  const setupRequired = step({ ...live(), unconfigured: true }, 'DATA');
  assert.equal(setupRequired.next.phase, 'UNCONFIGURED');
  assert.deepEqual(setupRequired.effects, [{ kind: 'patch', screen: 'all' }]);
  assert.deepEqual(step(unconfigured(), 'TICK').effects, [], 'UNCONFIGURED has no stale labels to redraw');
});

test('the root tap and the menu entry are the same action (§7 "merged page")', () => {
  const fromRoot = step(live(), 'CLICK');
  const fromMenu = step(menu(), 'CLICK');
  assert.equal(fromRoot.next.statusNotice, fromMenu.next.statusNotice);
  assert.equal(fromRoot.next.notice, fromMenu.next.notice);
  assert.equal(fromRoot.next.phase, fromMenu.next.phase);
  // Same fetch request; only the redraw differs — leaving the menu replaces a whole page, so it has
  // to be a mount, while the root page only changes text and can take the flicker-free path.
  assert.deepEqual(fromRoot.effects[0], { kind: 'refresh' });
  assert.deepEqual(fromMenu.effects[0], { kind: 'refresh' });
  assert.deepEqual(fromMenu.effects[1], { kind: 'mount', screen: 'all' });
});

test('long press opens the menu on Refresh now, from every root phase', () => {
  for (const build of [unconfigured, connecting, live, stale]) {
    const { next, effects } = step(build(), 'LONG_PRESS');
    assert.equal(next.phase, 'MENU');
    assert.equal(next.cursor, MENU_INDEX.refresh);
    assert.deepEqual(effects, [{ kind: 'mount', screen: 'menu' }]);
  }
});

test('the long-press release changes nothing and is never treated as an unknown event', () => {
  // The exit phases are excluded on purpose: there the release is answered as the cancel (or as
  // "no dialog yet"), which is a change — see the exit-dialog tests below.
  for (const build of [unconfigured, connecting, live, stale, menu]) {
    const before = build();
    const { next, effects } = step(before, 'LONG_PRESS_RELEASE');
    assert.deepEqual(next, before);
    assert.equal(effects.length, 1);
    assert.equal(effects[0]?.kind, 'ack');
  }
});

test('double-tap on a root page hands the exit to the system and tears nothing down first', () => {
  for (const build of [unconfigured, connecting, live, stale]) {
    const { next, effects } = step(build(), 'DOUBLE_CLICK');
    // `shutDownPageContainer(1)` only offers the system dialog; the user can still cancel, so
    // neither a cleanup nor a move to EXITING belongs here — either would leave a live page that
    // no longer listens for input. See "requesting the exit does not end the app" below.
    assert.equal(next.phase, 'EXIT_REQUESTED', 'the wait for the dialog is a phase, not a flag');
    assert.equal(next.exitFrom, 'root');
    assert.deepEqual(effects, [{ kind: 'exit' }]);
  }
});

// ---- §3 / §10.3(a) after M6b: STALE means EVERY drawn tool is stale -----------

test('one fresh section keeps the page LIVE even while the other says stale', () => {
  // The G1 fixture: Claude 21s old, Codex 23m old. The CODEX section row says `stale 23m` and the
  // machine is still LIVE — that is the M6b rule, and it is what makes the two verdicts independent.
  const state = live();
  assert.equal(state.phase, 'LIVE');
  // Read by section label rather than by row index: §7 "section gap" puts a blank row between the two
  // sections, so a fixed index would move with the layout.
  assert.equal(sectionValue(state, 'claude'), '12:03 · ok');
  assert.equal(sectionValue(state, 'codex'), '11:41 · stale 23m');
});

test('STALE is reached only when the LAST drawn section crosses its threshold', () => {
  const base = live();
  // Codex crossed at 11:51; Claude's 20-minute threshold expires at 12:23:41. One millisecond
  // before that the page is still LIVE, and one millisecond after it is STALE.
  const beforeCrossing = new Date(Date.parse(DEMO_PAYLOAD.claude.fetchedAt!) + 20 * 60_000);
  assert.equal(step(base, 'TICK', beforeCrossing).next.phase, 'LIVE');
  // Nothing changed, nothing redrawn — five seconds on, every section still says what it said. (The
  // 12:23:41 tick above is NOT that case: Codex's counter has moved from `stale 23m` to `stale 42m`
  // by then, and §3 owes that section a redraw whatever the phase is doing.)
  assert.deepEqual(step(base, 'TICK', new Date(DEMO_NOW.getTime() + 5_000)).effects, []);

  const afterCrossing = new Date(beforeCrossing.getTime() + 1);
  const crossed = step(base, 'TICK', afterCrossing);
  assert.equal(crossed.next.phase, 'STALE');
  assert.deepEqual(crossed.effects, [{ kind: 'patch', screen: 'all' }]);
  // And the sections agree — the phase and the labels come from the same §3 call.
  assert.equal(sectionValue(crossed.next, 'claude'), '12:03 · stale 20m');
});

/**
 * Codex fetched exactly one threshold ago at `DEMO_NOW` (11:54 + 10 min = 12:04), while Claude is 19
 * seconds old. Half a minute later the CODEX section has crossed and the CLAUDE one has not — the
 * shape §3 makes possible and the phase alone cannot see.
 */
const CODEX_AT_THRESHOLD: UsagePayload = {
  ...DEMO_PAYLOAD,
  codex: { ...DEMO_PAYLOAD.codex, fetchedAt: '2026-09-07T11:54:00+10:00' },
};

test('§3 — one section crossing its own threshold redraws the page while the other stays fresh', () => {
  // The reviewer's reproduction (2026-09-10): Codex goes from 10m to 10m30s with Claude still fresh.
  // The phase does not move — one fresh section keeps the page LIVE — so a redraw guarded on the
  // PHASE draws nothing, and the CODEX row goes on saying `ok` after §3 says it is stale.
  const base = initialState({ payload: CODEX_AT_THRESHOLD, now: DEMO_NOW });
  assert.equal(base.phase, 'LIVE');
  assert.equal(sectionValue(base, 'codex'), '11:54 · ok', 'the premise: Codex is still inside its threshold');

  const crossed = step(base, 'TICK', new Date(DEMO_NOW.getTime() + 30_000));
  assert.equal(crossed.next.phase, 'LIVE', 'one fresh section still keeps the whole page LIVE');
  assert.deepEqual(
    crossed.effects,
    [{ kind: 'patch', screen: 'all' }],
    'the CODEX verdict changed and nothing redrew it: the row still says `ok` (§3)',
  );
  assert.equal(sectionValue(crossed.next, 'codex'), '11:54 · stale 10m');
  assert.equal(sectionValue(crossed.next, 'claude'), '12:03 · ok', 'the fresh section must not change');
});

test('§3 — the stale minute counter redraws when the LABEL moves, and not on every tick', () => {
  const crossed = step(
    initialState({ payload: CODEX_AT_THRESHOLD, now: DEMO_NOW }),
    'TICK',
    new Date(DEMO_NOW.getTime() + 30_000),
  ).next;

  // Twenty seconds later the age is 10m50s, which still reads `stale 10m`: nothing on the glasses
  // would change, so nothing is drawn — a bridge call every 30 s on a serial BLE link buys nothing.
  const sameLabel = step(crossed, 'TICK', new Date(DEMO_NOW.getTime() + 50_000));
  assert.deepEqual(sameLabel.effects, [], 'the same label was redrawn anyway');

  // …and the minute it rolls over to `stale 11m`, it is drawn.
  const nextMinute = step(crossed, 'TICK', new Date(DEMO_NOW.getTime() + 90_000));
  assert.deepEqual(nextMinute.effects, [{ kind: 'patch', screen: 'all' }]);
  assert.equal(sectionValue(nextMinute.next, 'codex'), '11:54 · stale 11m');
});

test('a tool that never fetched is not counted as stale — it is not drawn at all (§7 V1)', () => {
  // Codex `source:"none"`, Claude fresh: the only drawn section is fresh, so LIVE.
  const oneTool = initialState({ payload: CLAUDE_ONLY_PAYLOAD, now: DEMO_NOW });
  assert.equal(oneTool.phase, 'LIVE');
  // …and with the drawn one stale, the page is STALE on the strength of that single section.
  const later = step(oneTool, 'TICK', new Date('2026-09-07T12:30:00+10:00'));
  assert.equal(later.next.phase, 'STALE');

  // Neither tool drawn: nothing has a staleness, so the page is LIVE and says `No usage data`.
  const noData = initialState({ payload: NO_DATA_PAYLOAD, now: DEMO_NOW });
  assert.equal(noData.phase, 'LIVE');
  assert.equal(step(noData, 'TICK', new Date('2026-09-09T00:00:00+10:00')).next.phase, 'LIVE');
});

// ---- menu (§7 frame C2) ------------------------------------------------------

test('the menu is three entries after M6b, and Switch to … is gone', () => {
  assert.deepEqual(menuItems(), ['Refresh now', 'Token stats · soon', 'Exit']);
  assert.deepEqual(Object.keys(MENU_INDEX), ['refresh', 'tokenStats', 'exit']);
});

test('the cursor wraps in both directions and the menu is rebuilt, never patched', () => {
  let state = menu();
  for (const expected of [1, 2, 0]) {
    const { next, effects } = step(state, 'SCROLL_BOTTOM');
    assert.equal(next.cursor, expected);
    // Moving the cursor changes borderWidth/x/width, which textContainerUpgrade cannot do.
    assert.deepEqual(effects, [{ kind: 'mount', screen: 'menu' }]);
    state = next;
  }
  assert.equal(step(menu(), 'SCROLL_TOP').next.cursor, MENU_INDEX.exit);
});

test('§7 footer indicator follows the cursor', () => {
  const moved = step(menu(), 'SCROLL_BOTTOM').next;
  const specs = menuScreen.buildContainers(screenInputOf(moved));
  assert.equal(specs.find((s) => s.name === 'ftrRight')?.content, '2/3');
});

test('§7 V7 — Refresh now shows refreshing… immediately, then recomputes staleness', () => {
  const { next, effects } = step(menu(), 'CLICK');
  assert.equal(next.phase, 'LIVE', 'the menu closes back onto the merged page');
  assert.equal(next.statusNotice, REFRESHING);
  // The fetch is requested and the page carrying the notice goes up in the same transition.
  assert.deepEqual(effects, [{ kind: 'refresh' }, { kind: 'mount', screen: 'all' }]);
  const specs = allScreen.buildContainers(screenInputOf(next));
  assert.equal(specs.find((s) => s.name === 'ftrRight')?.content, REFRESHING);

  // When the fetch ends the notice comes down and the status column goes back to being blank —
  // §3's verdict lives in the section rows now, so there is nothing left for that column to show.
  const done = step(next, 'REFRESH_DONE');
  assert.equal(done.next.statusNotice, null);
  assert.equal(done.next.phase, 'LIVE');
  assert.deepEqual(done.effects, [{ kind: 'patch', screen: 'all' }]);
  const after = allScreen.buildContainers(screenInputOf(done.next));
  assert.equal(after.find((s) => s.name === 'ftrRight'), undefined);
  assert.equal(sectionValue(done.next, 'claude'), '12:03 · ok');
});

test('§7 V7 — a Refresh pressed while stale comes back to stale, not to LIVE', () => {
  // §10.3(a): FETCH_OK does not make a page live; only the age of the data does.
  const refreshed = step({ ...stale(), phase: 'MENU', cursor: MENU_INDEX.refresh }, 'CLICK').next;
  assert.equal(refreshed.phase, 'STALE');
  const done = step(refreshed, 'REFRESH_DONE');
  assert.equal(done.next.phase, 'STALE');
  assert.equal(sectionValue(done.next, 'claude'), '12:03 · stale 20m');
});

test('§7 V5 — Token stats answers in the footer, keeps the cursor, and stays in the menu', () => {
  const selected = step({ ...menu(), cursor: MENU_INDEX.tokenStats }, 'CLICK');
  assert.equal(selected.next.phase, 'MENU');
  assert.equal(selected.next.cursor, MENU_INDEX.tokenStats);
  assert.equal(selected.next.notice, COMING_SOON);
  assert.deepEqual(selected.effects, [
    { kind: 'mount', screen: 'menu' },
    { kind: 'noticeTimer', ms: 2000 },
  ]);
  const shown = menuScreen.buildContainers(screenInputOf(selected.next));
  // §7 V5 puts it on the LEFT of the footer, in place of the hint.
  assert.equal(shown.find((s) => s.name === 'ftrLeft')?.content, COMING_SOON);
  assert.equal(shown.find((s) => s.name === 'ftrRight')?.content, '2/3');

  const expired = step(selected.next, 'NOTICE_EXPIRED');
  assert.equal(expired.next.notice, null);
  assert.equal(expired.next.cursor, MENU_INDEX.tokenStats);
  assert.deepEqual(expired.effects, [{ kind: 'mount', screen: 'menu' }]);
  assert.equal(
    menuScreen.buildContainers(screenInputOf(expired.next)).find((s) => s.name === 'ftrLeft')?.content,
    '▲▼ move · tap select',
  );
});

test('a late notice timer cannot wipe a refreshing… raised after the menu closed', () => {
  const refreshing = step(menu(), 'CLICK').next;
  assert.equal(refreshing.notice, null, 'the menu’s own footer notice goes down with the menu (§7 V5)');
  const late = step(refreshing, 'NOTICE_EXPIRED');
  assert.equal(late.next.statusNotice, REFRESHING);
  assert.deepEqual(late.effects, [], 'there is no left notice to take down, so nothing is redrawn');
});

test('Exit from the menu goes through the system exit, like the root double-tap', () => {
  const { next, effects } = step({ ...menu(), cursor: MENU_INDEX.exit }, 'CLICK');
  // Also only a request — and `exitFrom` is what brings a cancelled dialog back to the menu the
  // user was looking at, with the cursor where they left it.
  assert.equal(next.phase, 'EXIT_REQUESTED');
  assert.equal(next.exitFrom, 'menu');
  assert.deepEqual(effects, [{ kind: 'exit' }]);
});

test('double-tap in the menu means back, and re-derives LIVE/STALE on the way out', () => {
  const back = step(menu(), 'DOUBLE_CLICK');
  assert.equal(back.next.phase, 'LIVE');
  assert.deepEqual(back.effects, [{ kind: 'mount', screen: 'all' }]);

  const fromStale = step({ ...stale(), phase: 'MENU', cursor: 0 }, 'DOUBLE_CLICK');
  assert.equal(fromStale.next.phase, 'STALE');
});

test('long press inside the menu is acknowledged, not re-opened', () => {
  const { next, effects } = step(menu(), 'LONG_PRESS');
  assert.equal(next.phase, 'MENU');
  assert.equal(effects.length, 1);
  assert.equal(effects[0]?.kind, 'ack');
});

// ---- lifecycle (§10.3(a) / handle-input) -------------------------------------

test('foreground enter re-renders whatever page is up', () => {
  assert.deepEqual(step(live(), 'FOREGROUND_ENTER').effects, [{ kind: 'mount', screen: 'all' }]);
  assert.deepEqual(step(menu(), 'FOREGROUND_ENTER').effects, [{ kind: 'mount', screen: 'menu' }]);
});

test('foreground exit flushes the payload cache and changes nothing else (T3.4)', () => {
  // The host migrates the plugin into a fresh headless WebView, which re-runs `main.ts` from
  // scratch: `localStorage` is the only thing that survives, so the cache is written before we go.
  // The phase does not move — going to the background is not an exit (§10.3(a): only SYSTEM_EXIT /
  // ABNORMAL_EXIT reach EXITING).
  const { next, effects } = step(live(), 'FOREGROUND_EXIT');
  assert.equal(next.phase, 'LIVE');
  assert.deepEqual(effects, [{ kind: 'flush' }]);
});

test('the confirmed system exit is the only path that tears anything down', () => {
  const { next, effects } = step(menu(), 'SYSTEM_EXIT');
  assert.equal(next.phase, 'EXITING');
  assert.deepEqual(effects, [{ kind: 'cleanup' }]);
});

// ---- BLE loss (M6 D5, 2026-09-09): the page is gone, the app is not ----------

test('ABNORMAL_EXIT suspends instead of exiting, from every phase', () => {
  for (const [phase, build] of Object.entries(STATES)) {
    if (phase === 'DISCONNECTED') continue;
    const { next, effects } = step(build(), 'ABNORMAL_EXIT');
    assert.equal(next.phase, 'DISCONNECTED', phase);
    assert.deepEqual(effects, [{ kind: 'suspend' }], phase);
    assert.equal(next.notice, null, phase);
    assert.equal(next.statusNotice, null, phase);
  }
});

test('while disconnected nothing draws: gestures, RENDER, FOREGROUND_ENTER, DATA and TICK all produce no mount/patch', () => {
  const events: AppEvent[] = [...INPUTS, 'RENDER', 'FOREGROUND_ENTER', 'DATA', 'TICK', 'REFRESH_DONE', 'NOTICE_EXPIRED', 'EXIT_OFFERED'];
  for (const event of events) {
    const { next, effects } = step(disconnected(), event);
    assert.equal(next.phase, 'DISCONNECTED', event);
    assert.ok(effects.every((e) => e.kind === 'ack'), `${event}: ${effects.map((e) => e.kind).join(',')}`);
  }
  // The cache is still written out on the way to the background.
  assert.deepEqual(step(disconnected(), 'FOREGROUND_EXIT').effects, [{ kind: 'flush' }]);
});

test('RECONNECTED rebuilds the root page from scratch with §3 recomputed; the menu is not restored', () => {
  // Disconnected out of the menu, with stale data: the page that comes back is the merged page, at
  // the phase the data's age dictates NOW, not the menu the user was in when the link dropped.
  const fromMenu = step({ ...stale(), phase: 'MENU', cursor: MENU_INDEX.exit }, 'ABNORMAL_EXIT').next;
  const back = step(fromMenu, 'RECONNECTED');
  assert.equal(back.next.phase, 'STALE');
  assert.equal(back.next.cursor, 0);
  assert.equal(back.next.exitFrom, 'root');
  assert.deepEqual(back.effects, [{ kind: 'mount', screen: 'all' }]);

  const fresh = step(step(live(), 'ABNORMAL_EXIT').next, 'RECONNECTED');
  assert.equal(fresh.next.phase, 'LIVE');
  const noData = step(step(connecting(), 'ABNORMAL_EXIT').next, 'RECONNECTED');
  assert.equal(noData.next.phase, 'CONNECTING');
});

test('RECONNECTED outside DISCONNECTED changes nothing (the page is still ours)', () => {
  for (const [phase, build] of Object.entries(STATES)) {
    if (phase === 'DISCONNECTED') continue;
    const { next, effects } = step(build(), 'RECONNECTED');
    assert.equal(next.phase, phase, phase);
    assert.deepEqual(effects, [], phase);
  }
});

test('SYSTEM_EXIT still ends the app from DISCONNECTED', () => {
  const { next, effects } = step(disconnected(), 'SYSTEM_EXIT');
  assert.equal(next.phase, 'EXITING');
  assert.deepEqual(effects, [{ kind: 'cleanup' }]);
});

test('a gesture arriving after the exit was CONFIRMED is absorbed, not acted on', () => {
  // Reached only through SYSTEM_EXIT — the page is being torn down by then, so
  // there is nothing left to answer with. Before the confirmation the app must still respond,
  // which is what "requesting the exit does not end the app" covers.
  const exiting = step(live(), 'SYSTEM_EXIT').next;
  assert.equal(exiting.phase, 'EXITING');
  for (const event of INPUTS) {
    const { next, effects } = step(exiting, event);
    assert.equal(next.phase, 'EXITING', event);
    assert.ok(effects.every((e) => e.kind === 'ack'), event);
  }
});

// ---- staleness is time, not events (§3 / §10.3(a)) --------------------------

test('IMU and other non-input events change nothing', () => {
  const { next, effects } = step(live(), 'IGNORED');
  assert.deepEqual(next, live());
  assert.deepEqual(effects, []);
});

// ---- cancelling the system exit dialog --------------------------------------

/**
 * `shutDownPageContainer(1)` only OFFERS the exit; the user can still cancel, and then the app is
 * still on screen and still owns the input. Treating the gesture itself as the transition into
 * EXITING made every later gesture ack-only — the page stayed up and stopped answering.
 * EXITING therefore belongs to the CONFIRMED exit (SYSTEM_EXIT / ABNORMAL_EXIT) alone.
 */
test('requesting the exit does not end the app — a cancelled dialog leaves it usable', () => {
  for (const start of [live(), stale(), connecting(), unconfigured()]) {
    const requested = step(start, 'DOUBLE_CLICK');
    assert.deepEqual(requested.effects, [{ kind: 'exit' }], `${start.phase}: exit not offered`);
    assert.equal(requested.next.phase, 'EXIT_REQUESTED', `${start.phase}: gesture must not end the app`);

    // While the request is in flight nothing is a cancel: the dialog is not up, so a tap here came
    // from the page that is on its way out.
    const tooEarly = step(requested.next, 'CLICK');
    assert.equal(tooEarly.next.phase, 'EXIT_REQUESTED', `${start.phase}: acted before the dialog existed`);
    assert.ok(tooEarly.effects.every((e) => e.kind === 'ack'), `${start.phase}: drew over the dialog`);

    // Once the host has it, a tap is the user dismissing it: back to the page it covered, redrawn.
    const offered = step(requested.next, 'EXIT_OFFERED').next;
    const cancelled = step(offered, 'CLICK');
    assert.equal(cancelled.next.phase, start.phase, `${start.phase}: wrong page after a cancel`);
    assert.deepEqual(cancelled.effects, [{ kind: 'mount', screen: 'all' }]);
    // The tap is consumed AS the cancel: it must not also fire a Refresh, because the page it would
    // have acted on has been behind the dialog the whole time.
    assert.equal(cancelled.next.statusNotice, null, `${start.phase}: acted on an unseen page`);

    // …and the NEXT tap works normally, so a cancelled exit costs one gesture, not the app.
    const after = step(cancelled.next, 'CLICK');
    if (start.phase === 'UNCONFIGURED') {
      assert.equal(after.next.notice, 'set the address first');
      assert.ok(!after.effects.some((effect) => effect.kind === 'refresh'));
    } else {
      assert.equal(after.next.statusNotice, REFRESHING);
      assert.deepEqual(after.effects[0], { kind: 'refresh' });
    }
  }
});

test('Exit from the menu is also only a request, and a cancel leaves the menu usable', () => {
  const requested = step({ ...menu(), cursor: MENU_INDEX.exit }, 'CLICK');
  assert.deepEqual(requested.effects, [{ kind: 'exit' }]);
  assert.equal(requested.next.phase, 'EXIT_REQUESTED');

  const offered = step(requested.next, 'EXIT_OFFERED').next;
  const cancelled = step(offered, 'SCROLL_TOP');
  // Back to the menu, not to the merged page, and with the cursor still on Exit: the user is
  // returned to what the dialog was covering. The swipe is the cancel, so the cursor does not move.
  assert.equal(cancelled.next.phase, 'MENU');
  assert.equal(cancelled.next.cursor, MENU_INDEX.exit);
  assert.deepEqual(cancelled.effects, [{ kind: 'mount', screen: 'menu' }]);
  // The menu answers normally again from the next gesture on.
  assert.equal(step(cancelled.next, 'SCROLL_TOP').next.cursor, MENU_INDEX.tokenStats);
});

test('only the confirmed exit tears down; a BLE loss during the dialog suspends instead', () => {
  const confirmed = step(step(live(), 'DOUBLE_CLICK').next, 'SYSTEM_EXIT');
  assert.equal(confirmed.next.phase, 'EXITING');
  assert.deepEqual(confirmed.effects, [{ kind: 'cleanup' }]);
  const dropped = step(step(live(), 'DOUBLE_CLICK').next, 'ABNORMAL_EXIT');
  assert.equal(dropped.next.phase, 'DISCONNECTED');
  assert.deepEqual(dropped.effects, [{ kind: 'suspend' }]);
});
