// Fixed +10:00 zone, as in the other plugin tests: the §7 fixtures are all `+10:00`.
process.env.TZ = 'Australia/Brisbane';

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { OsEventTypeList } from '@evenrealities/even_hub_sdk';
import { staleThresholdMin, type UsagePayload } from '@quotalens/shared';
import {
  App,
  initialState,
  NOTICE_MS,
  REFRESH_NOTICE_MIN_MS,
  screenIdOf,
  screenInputOf,
  type AppBridge,
  type AppState,
  type ScreenId,
} from './app.ts';
import { DEMO_NOW, DEMO_PAYLOAD } from './fixtures.ts';
import type { DataPoller, PollOutcome } from './poll.ts';
import {
  DEFAULT_SETTINGS,
  MAX_CONTENT_CHARS,
  Renderer,
  type PageRenderer,
  type Screen,
  type ScreenInput,
  type TextUpdate,
} from './render.ts';
import { COMING_SOON, MENU_INDEX, menuScreen } from './screens/menu.ts';
import { allScreen, REFRESHING } from './screens/tool.ts';

const SCREENS: Record<ScreenId, Screen> = { all: allScreen, menu: menuScreen };

/**
 * Records what was drawn, and can be told to fail the next render — the two ways a bridge call
 * fails are different and both matter: `mount` REPORTS failure by returning `false`, and it can
 * also throw outright.
 */
class FakeRenderer implements PageRenderer {
  readonly mounted: ScreenId[] = [];
  readonly patched: number[] = [];
  failNextMount = false;
  refuseNextMount = false;
  refuseNextPatch = false;

  async mount(screen: Screen, _input: ScreenInput): Promise<boolean> {
    if (this.failNextMount) {
      this.failNextMount = false;
      throw new Error('bridge went away mid-render');
    }
    if (this.refuseNextMount) {
      this.refuseNextMount = false;
      return false; // what the SDK does when the page is rejected — no exception, just `false`
    }
    this.mounted.push(screen.id);
    return true;
  }

  async patch(updates: TextUpdate[]): Promise<boolean> {
    if (this.refuseNextPatch) {
      this.refuseNextPatch = false;
      return false;
    }
    this.patched.push(updates.length);
    return true;
  }

  invalidateCount = 0;
  invalidate(): void {
    this.invalidateCount += 1;
    this.epoch += 1;
  }

  pageLostCount = 0;
  pageLost(): void {
    this.pageLostCount += 1;
    this.invalidate();
  }

  /** ponytail: pass-through. The real chain is what the R2 tests below exercise, on `Renderer`. */
  enqueue<T>(call: () => Promise<T>): Promise<T> {
    return call();
  }

  protected epoch = 0;
}

class FakeBridge implements AppBridge {
  shutdownCalls: number[] = [];
  listener: ((event: unknown) => void) | null = null;

  onEvenHubEvent = ((listener: (event: never) => void) => {
    this.listener = listener as (event: unknown) => void;
    return () => {
      this.listener = null;
    };
  }) as AppBridge['onEvenHubEvent'];

  shutDownPageContainer = (async (mode?: number) => {
    this.shutdownCalls.push(mode ?? 0);
    return true;
  }) as AppBridge['shutDownPageContainer'];
}

/** T3.4: records what the app asked the relay layer to do, without a network or a clock. */
class FakePoller implements DataPoller {
  deliver: ((outcome: PollOutcome) => void) | null = null;
  refreshes = 0;
  flushes = 0;
  stops = 0;
  starts = 0;

  start(deliver: (outcome: PollOutcome) => void): void {
    this.starts += 1;
    this.deliver = deliver;
  }
  /** As `poll.ts` behaves when the 10-second debounce swallows the press: settles at once. */
  async refresh(): Promise<void> {
    this.refreshes += 1;
  }
  flush(): void {
    this.flushes += 1;
  }
  stop(): void {
    this.stops += 1;
  }
}

function makeApp(
  options: {
    payload?: UsagePayload | null;
    clock?: () => Date;
    poller?: DataPoller;
    retryMs?: number;
    unconfigured?: boolean;
  } = {},
) {
  const renderer = new FakeRenderer();
  const bridge = new FakeBridge();
  const clock = options.clock ?? (() => DEMO_NOW);
  const app = new App({
    bridge,
    renderer,
    screens: SCREENS,
    clock,
    poller: options.poller,
    retryMs: options.retryMs,
    initial: initialState({
      payload: options.payload === undefined ? DEMO_PAYLOAD : options.payload,
      now: clock(),
      unconfigured: options.unconfigured,
    }),
  });
  return { app, renderer, bridge };
}

/**
 * Every dispatch is chained onto one promise so gestures cannot interleave their bridge calls.
 * Chaining with `.then()` alone means a single rejection poisons that promise for good: every
 * later dispatch inherits the rejection and its handler never runs. The app then looks alive —
 * the page is still up, events still arrive — but nothing responds, and cleanup cannot run either.
 */
test('one failed render does not stop the app answering the next gesture', async (t) => {
  const { app, renderer } = makeApp();
  t.after(() => app.stop()); // the 30s staleness interval would otherwise hold the test runner open
  await app.start();
  assert.deepEqual(renderer.mounted, ['all']);

  renderer.failNextMount = true;
  // M6b: a tap is Refresh. Raising `refreshing…` adds the footer status container, so the redraw is
  // upgraded from a patch to a mount by `App.plan` — which is the mount that throws here.
  await app.dispatch('CLICK');
  assert.deepEqual(renderer.mounted, ['all'], 'the failing mount should not have been recorded');

  // The queue has to have survived it.
  await app.dispatch('LONG_PRESS');
  assert.deepEqual(renderer.mounted, ['all', 'menu'], 'the app stopped responding after one failure');
  assert.equal(app.current.phase, 'MENU');
});

test('cleanup still runs after a failed render', async (t) => {
  const { app, renderer } = makeApp();
  t.after(() => app.stop());
  await app.start();

  renderer.failNextMount = true;
  await app.dispatch('CLICK');

  await app.dispatch('SYSTEM_EXIT');
  assert.equal(app.current.phase, 'EXITING');
  // `stop()` clears the subscription; a poisoned queue would have skipped it entirely.
  await app.dispatch('LONG_PRESS');
  assert.equal(app.current.phase, 'EXITING', 'a gesture after teardown must not revive the app');
});

test('T6b.4 rule 10 — an exit confirmed during the hydrate keeps the poll loop from ever starting', async (t) => {
  // Codex review probe on d4b8c03: `startThenHydrate` calls `startPolling()` after the hydrate,
  // and the user can confirm the system exit dialog while the hydrate is running. `stop()` had torn
  // the app down; the poller then started anyway (`phase EXITING, pollStarts 1`) and kept requests,
  // cache writes and bridge storage going behind a page that no longer existed.
  const poller = new FakePoller();
  const { app } = makeApp({ poller });
  t.after(() => app.stop());
  await app.start();
  assert.equal(poller.starts, 0, 'start() must not start the poll loop (rule 10)');

  await app.dispatch('SYSTEM_EXIT');
  assert.equal(app.current.phase, 'EXITING');
  app.startPolling(); // what the boot does once the hydrate returns
  assert.equal(poller.starts, 0, 'the poll loop started after the exit');
});

test('a dispatch that fails still settles, so callers are never left hanging', async (t) => {
  const { app, renderer } = makeApp();
  t.after(() => app.stop());
  await app.start();
  renderer.failNextMount = true;
  // Rejecting here would surface as an unhandled rejection in the event listener, which uses
  // `void this.dispatch(...)` and has nobody to catch it.
  await assert.doesNotReject(() => app.dispatch('CLICK'));
});

test('the exit request reaches the bridge as the system dialog, and does not tear down', async (t) => {
  const { app, renderer, bridge } = makeApp();
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('DOUBLE_CLICK');
  assert.deepEqual(bridge.shutdownCalls, [1], 'exit must offer the system dialog, mode 1');
  assert.notEqual(app.current.phase, 'EXITING', 'the request alone must not end the app');
  assert.ok(bridge.listener !== null, 'the app must still be listening while the dialog is up');

  await settle(10); // the host takes the request; EXIT_OFFERED comes back as an event
  assert.equal(app.current.phase, 'EXIT_OFFERED');

  // The user cancels. The tap is consumed as the cancel and redraws the page the dialog covered…
  await app.dispatch('CLICK');
  assert.deepEqual(renderer.mounted, ['all', 'all'], 'the cancel did not redraw the page');
  assert.equal(app.current.statusNotice, null, 'the cancelling tap also fired a Refresh');
  // …and the next gesture works normally, so a cancelled exit costs one gesture, not the app.
  await app.dispatch('CLICK');
  assert.equal(app.current.statusNotice, REFRESHING, 'the tap after the cancel did nothing');
  assert.deepEqual(renderer.mounted, ['all', 'all', 'all']);
});

// ---- the screen and the machine must agree on what is selected ---------------

/**
 * The cursor is what tells the next tap which menu entry the user meant. If the state advances but
 * the redraw does not land, the glasses keep showing the old highlight while the machine has moved
 * on — and the next tap runs a different entry than the one under the cursor. With `Exit` sitting
 * next to `Token stats`, that is a tap on "coming soon" that quits the app.
 */
async function menuAt(cursor: number) {
  const { app, renderer, bridge } = makeApp();
  await app.start();
  await app.dispatch('LONG_PRESS'); // menu opens on Refresh now (index 0)
  for (let i = 0; i < cursor; i += 1) await app.dispatch('SCROLL_BOTTOM');
  assert.equal(app.current.cursor, cursor);
  return { app, renderer, bridge };
}

for (const [label, arm] of [
  ['a refused redraw', (r: FakeRenderer) => (r.refuseNextMount = true)],
  ['a thrown redraw', (r: FakeRenderer) => (r.failNextMount = true)],
] as const) {
  test(`${label} leaves the cursor where the glasses still show it`, async (t) => {
    const { app, renderer } = await menuAt(MENU_INDEX.tokenStats);
    t.after(() => app.stop());

    arm(renderer);
    await app.dispatch('SCROLL_BOTTOM'); // would move to Exit, but the redraw does not land
    assert.equal(
      app.current.cursor,
      MENU_INDEX.tokenStats,
      'the machine moved the cursor the glasses never drew',
    );
  });

  test(`${label} means the next tap runs the entry that is actually on screen`, async (t) => {
    const { app, renderer, bridge } = await menuAt(MENU_INDEX.tokenStats);
    t.after(() => app.stop());

    arm(renderer);
    await app.dispatch('SCROLL_BOTTOM');
    await app.dispatch('CLICK');

    assert.deepEqual(bridge.shutdownCalls, [], 'tapped Token stats and got the exit instead');
    assert.equal(app.current.notice, COMING_SOON, '§7 V5 should have answered in the footer');
  });
}

test('a refused patch does not advance the machine past what the glasses show', async (t) => {
  const clock = { now: DEMO_NOW };
  const renderer = new FakeRenderer();
  const app = new App({
    bridge: new FakeBridge(),
    renderer,
    screens: SCREENS,
    clock: () => clock.now,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();
  assert.equal(app.current.phase, 'LIVE');

  // One millisecond past Claude's 20-minute threshold: the tick moves LIVE → STALE and redraws the
  // footer through `patch`. If that redraw is refused, the footer still says `ok`, so the machine
  // must stay on LIVE rather than believing a `stale 20m` nobody can see.
  clock.now = new Date(Date.parse(DEMO_PAYLOAD.claude.fetchedAt!) + 20 * 60_000 + 1);
  renderer.refuseNextPatch = true;
  await app.dispatch('TICK');
  assert.equal(app.current.phase, 'LIVE', 'the phase moved without the footer moving with it');

  // With the redraw landing, the same tick does move it.
  await app.dispatch('TICK');
  assert.equal(app.current.phase, 'STALE');
});

// ---- a lost render has to be retried, not just rolled back -------------------

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Rolling the state back keeps the machine and the glasses agreeing, but on its own it just drops
 * the work. For a USER gesture that is right — nothing changed on screen, and they press again.
 * For everything else there is nobody to press again, so the retry has to be the app's job.
 */
function makeRetryApp(overrides: { payload?: typeof DEMO_PAYLOAD } = {}) {
  const clock = { now: DEMO_NOW };
  const renderer = new FakeRenderer();
  const bridge = new FakeBridge();
  const app = new App({
    bridge,
    renderer,
    screens: SCREENS,
    clock: () => clock.now,
    retryMs: 5, // the real one backs off from a second; tests must not sleep for it
    initial: initialState({ payload: overrides.payload ?? DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  return { app, renderer, bridge, clock };
}

test('a refused first page is retried until it lands — the glasses never stay blank', async (t) => {
  const { app, renderer } = makeRetryApp();
  t.after(() => app.stop());

  renderer.refuseNextMount = true;
  await app.start();
  assert.deepEqual(renderer.mounted, [], 'the first mount was refused, as arranged');

  await settle(60);
  assert.deepEqual(renderer.mounted, ['all'], 'nothing ever redrew the first page');
});

test('a thrown first page still leaves the app listening, and retries', async (t) => {
  const { app, renderer, bridge } = makeRetryApp();
  t.after(() => app.stop());

  renderer.failNextMount = true;
  await app.start();
  // Subscribing after the first render meant a throw skipped the subscription and the tick timer
  // entirely: a blank screen that could never receive an event again.
  assert.ok(bridge.listener !== null, 'the app stopped listening because the first render threw');

  await settle(60);
  assert.deepEqual(renderer.mounted, ['all']);
});

test('a refused REFRESH_DONE redraw does not strand refreshing… forever (§7 V7)', async (t) => {
  const { app, renderer } = makeRetryApp();
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('LONG_PRESS');
  await app.dispatch('CLICK'); // Refresh now → notice goes up, one-shot timer armed
  assert.equal(app.current.statusNotice, REFRESHING);

  // After M6b the REFRESH_DONE redraw is a MOUNT, not a patch: taking `refreshing…` down removes the
  // footer status container altogether (§7 "merged page" leaves that column blank), and a container set
  // that changes is exactly what `App.plan` upgrades. Armed here rather than before the CLICK so it
  // is the completion's redraw that is refused, not the menu coming down.
  renderer.refuseNextMount = true;
  // No assertion on the moment in between: the refusal rolls the notice back and the retry brings
  // it down again milliseconds later, so reading that window is a race. The end state is the
  // contract — and it discriminates, because `refuseNextPatch` fires once: with no retry at all,
  // `refreshing…` stays up for good, which is exactly what this asserted before the fix.
  await settle(REFRESH_NOTICE_MIN_MS + 250);
  assert.equal(app.current.statusNotice, null, 'refreshing… is stuck: it now hides the real §3 status');
});

test('a refused NOTICE_EXPIRED redraw does not strand coming in v2 (§7 V5)', async (t) => {
  const { app, renderer } = makeRetryApp();
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('LONG_PRESS');
  // One step down is `Token stats · soon` now that `Switch to …` is gone (M6b).
  await app.dispatch('SCROLL_BOTTOM');
  assert.equal(app.current.cursor, MENU_INDEX.tokenStats);
  await app.dispatch('CLICK'); // Token stats → COMING_SOON, 2s one-shot timer
  assert.equal(app.current.notice, COMING_SOON);

  renderer.refuseNextMount = true;
  await settle(NOTICE_MS + 60);
  await settle(120);
  assert.equal(app.current.notice, null, 'coming in v2 never came back down');
});

// ---- a bridge that never answers, and a retry that outlives the app ----------

/** A renderer whose next mount never settles, the way a dropped BLE hop behaves. */
class HangingRenderer extends FakeRenderer {
  hangNextMount = false;
  /** Holds the queue open long enough for a timer to fire behind an event already queued. */
  slowMountMs = 0;
  /** Answers only after the caller's deadline has passed — the "late completion" case. */
  lateMountMs = 0;
  /** Same, for the patch path: a tool page's redraw is a patch, not a mount. */
  latePatchMs = 0;

  override async patch(updates: TextUpdate[]): Promise<boolean> {
    if (this.latePatchMs > 0) {
      const wait = this.latePatchMs;
      this.latePatchMs = 0;
      const epoch = this.epoch;
      await new Promise((r) => setTimeout(r, wait));
      if (this.epoch !== epoch) return false;
    }
    return super.patch(updates);
  }

  override async mount(screen: Screen, input: ScreenInput): Promise<boolean> {
    if (this.hangNextMount) {
      this.hangNextMount = false;
      return new Promise<boolean>(() => {}); // never resolves, never rejects
    }
    if (this.lateMountMs > 0) {
      const wait = this.lateMountMs;
      this.lateMountMs = 0;
      const epoch = this.epoch;
      await new Promise((r) => setTimeout(r, wait));
      // The real Renderer discards its result once invalidated; the fake has to do the same or the
      // test would be measuring a renderer nobody ships.
      if (this.epoch !== epoch) return false;
    }
    if (this.slowMountMs > 0) await new Promise((r) => setTimeout(r, this.slowMountMs));
    return super.mount(screen, input);
  }
}

test('a bridge call that never answers does not freeze input or teardown', async (t) => {
  const renderer = new HangingRenderer();
  const bridge = new FakeBridge();
  const app = new App({
    bridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    renderTimeoutMs: 20, // the real deadline is seconds; the test must not wait for it
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  renderer.hangNextMount = true;
  // Without a deadline this await never returns, and every later event queues behind it forever.
  await app.dispatch('LONG_PRESS');

  // Input still works…
  await app.dispatch('CLICK');
  assert.notEqual(app.current.phase, undefined);
  // …and so does the teardown, which is the one that must never be unreachable.
  await app.dispatch('SYSTEM_EXIT');
  assert.equal(app.current.phase, 'EXITING');
  assert.equal(bridge.listener, null, 'cleanup never ran: the app is still subscribed');
});

/**
 * `stop()` clears the retry TIMER, so an armed retry is harmless. The one that gets through is a
 * retry whose timer already fired while the queue was busy: by then it is a dispatch sitting in
 * the queue, and nothing can recall it. It has to be refused at the moment it runs instead —
 * otherwise the order is mount → unsubscribe → mount, repainting a page the app no longer owns.
 */
test('a retry already queued when the app exits does not redraw afterwards', async (t) => {
  const renderer = new HangingRenderer();
  const bridge = new FakeBridge();
  const app = new App({
    bridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 50,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());

  renderer.refuseNextMount = true;
  await app.start(); // first page refused → a RENDER retry is armed for t+50ms

  // Occupy the queue past that 50ms, so the retry lands in the queue rather than staying a timer.
  renderer.slowMountMs = 150;
  const slow = app.dispatch('CLICK');
  await settle(10);
  const exiting = app.dispatch('SYSTEM_EXIT'); // queued behind the slow render, ahead of the retry
  await slow;
  await exiting;
  assert.equal(bridge.listener, null, 'the app should have been torn down by now');

  const drawnAtExit = renderer.mounted.length;
  await settle(150); // the queued retry runs here
  assert.equal(
    renderer.mounted.length,
    drawnAtExit,
    'a queued retry drew a page after the app had been torn down',
  );
});

// ---- a call we stopped waiting for must stop working too --------------------

test('a render abandoned at the deadline cannot paint over the page that replaced it', async (t) => {
  // The reproduction from the review: open the menu, let that mount blow the deadline, move on,
  // and the late arrival repaints the menu while the machine is on a tool page. The next tap then
  // acts on a screen the user is not looking at.
  const renderer = new HangingRenderer();
  const bridge = new FakeBridge();
  const app = new App({
    bridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    renderTimeoutMs: 20,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  const drawnBefore = renderer.mounted.length;
  renderer.lateMountMs = 80; // answers long after the 20ms deadline
  await app.dispatch('LONG_PRESS');
  assert.notEqual(app.current.phase, 'MENU', 'a timed-out mount must not be treated as drawn');
  assert.equal(renderer.invalidateCount, 1, 'the abandoned call was never invalidated');

  await settle(200); // the late mount resolves, and the repair redraw runs
  // The assertion has to be that a repair redraw HAPPENED, not that the fake ended up consistent:
  // the call we gave up on was already on its way to the glasses and may well have painted the
  // menu. Nothing this side of the bridge can observe that, so the only defence is to redraw the
  // state we rolled back to — unconditionally, including for a gesture that is otherwise dropped.
  assert.ok(
    renderer.mounted.length > drawnBefore,
    'nothing redrew after the timeout: a late paint would be left on screen',
  );
  assert.equal(
    renderer.mounted.at(-1),
    screenIdOf(app.current),
    'the glasses are left showing a page the machine is not on',
  );
});

test('the real Renderer stops writing containers once the app has exited', async (t) => {
  // Not a fake renderer: the batch loop inside `Renderer.patch` is the thing under test. A
  // deadline on the whole batch never stopped the loop, so the remaining upgrades went out after
  // SYSTEM_EXIT had already torn the page down.
  const upgrades: string[] = [];
  let releaseFirst: (() => void) | null = null;
  const bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async (c: { containerName?: string }) => {
      upgrades.push(c.containerName ?? '?');
      if (upgrades.length === 1) await new Promise<void>((r) => (releaseFirst = r));
      return true;
    },
  } as unknown as ConstructorParameters<typeof Renderer>[0];

  const renderer = new Renderer(bridge);
  await renderer.mount(allScreen, {
    payload: DEMO_PAYLOAD,
    now: DEMO_NOW,
    settings: DEFAULT_SETTINGS,
    errorCode: null,
    cursor: 0,
    notice: null,
  });

  const batch = renderer.patch(allScreen.patch({
    payload: DEMO_PAYLOAD,
    now: DEMO_NOW,
    settings: DEFAULT_SETTINGS,
    errorCode: null,
    cursor: 0,
    notice: null,
  }));
  await settle(20); // the first upgrade is in flight and stuck
  assert.equal(upgrades.length, 1);

  renderer.invalidate(); // what the app does on a deadline, and again on teardown
  releaseFirst!();
  assert.equal(await batch, false, 'an abandoned batch must not report success');
  await settle(20);
  assert.deepEqual(upgrades.length, 1, 'the batch kept writing containers after being abandoned');
  t.diagnostic(`upgrades issued: ${upgrades.join(', ')}`);
});

test('a late write is followed by another repair, so it cannot be the last thing on screen', async (t) => {
  const renderer = new HangingRenderer();
  const app = new App({
    bridge: new FakeBridge(),
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    renderTimeoutMs: 20,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  const drawnBefore = renderer.mounted.length;
  renderer.lateMountMs = 90;
  await app.dispatch('LONG_PRESS');

  await settle(60); // the first repair runs while the abandoned call is still out there
  const afterFirstRepair = renderer.mounted.length;
  assert.ok(afterFirstRepair > drawnBefore, 'the timeout repair never ran');

  await settle(200); // the abandoned call finishes here — its write would land after that repair
  assert.ok(
    renderer.mounted.length > afterFirstRepair,
    'nothing redrew after the abandoned call finished: its write would be left on screen',
  );
  assert.equal(renderer.mounted.at(-1), screenIdOf(app.current));
});

test('a first page that succeeds late is not created twice', async () => {
  // `createStartUpPageContainer` is one-shot. Losing the fact that it succeeded — because the
  // render that made the call was abandoned — sends the next mount back to the startup API
  // instead of `rebuildPageContainer`, and a host that refuses the second one blanks the glasses.
  let creates = 0;
  let rebuilds = 0;
  let releaseCreate: (() => void) | null = null;
  const bridge = {
    createStartUpPageContainer: async () => {
      creates += 1;
      await new Promise<void>((r) => (releaseCreate = r));
      return 0; // StartUpPageCreateResult.success — the device DID create the page
    },
    rebuildPageContainer: async () => {
      rebuilds += 1;
      return true;
    },
    textContainerUpgrade: async () => true,
  } as unknown as ConstructorParameters<typeof Renderer>[0];

  const renderer = new Renderer(bridge);
  const input: ScreenInput = {
    payload: DEMO_PAYLOAD,
    now: DEMO_NOW,
    settings: DEFAULT_SETTINGS,
    errorCode: null,
    cursor: 0,
    notice: null,
  };

  const first = renderer.mount(allScreen, input);
  await settle(20);
  renderer.invalidate(); // the caller's deadline fired while the create was still out
  releaseCreate!();
  assert.equal(await first, false, 'an abandoned mount must not claim success');

  assert.equal(await renderer.mount(allScreen, input), true);
  assert.equal(creates, 1, `the startup API was called ${creates} times`);
  assert.equal(rebuilds, 1, 'the second mount should have rebuilt, not created');
});

test('a retry never issues a second startup call while the first is still out', async () => {
  // `createStartUpPageContainer` is one-shot and bridge calls must not overlap. The repair render
  // scheduled by a deadline arrives while the first create is still in flight, and `created`
  // cannot have flipped yet — so the naive check fires another one, and another.
  let creates = 0;
  let pending = 0;
  let peakPending = 0;
  let release: (() => void) | null = null;
  const bridge = {
    createStartUpPageContainer: async () => {
      creates += 1;
      pending += 1;
      peakPending = Math.max(peakPending, pending);
      await new Promise<void>((r) => (release = r));
      pending -= 1;
      return 0;
    },
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async () => true,
  } as unknown as ConstructorParameters<typeof Renderer>[0];

  const renderer = new Renderer(bridge);
  const input: ScreenInput = {
    payload: DEMO_PAYLOAD,
    now: DEMO_NOW,
    settings: DEFAULT_SETTINGS,
    errorCode: null,
    cursor: 0,
    notice: null,
  };

  const first = renderer.mount(allScreen, input);
  await settle(10);
  const second = renderer.mount(allScreen, input); // the repair render, arriving mid-flight
  const third = renderer.mount(allScreen, input);
  await settle(10);
  assert.equal(peakPending, 1, `${peakPending} startup calls were in flight at once`);

  release!();
  await Promise.all([first, second, third]);
  assert.equal(creates, 1, `the one-shot startup API was called ${creates} times`);
});

test('a timed-out completion event is re-delivered as itself, not as a bare redraw', async (t) => {
  // Swapping the event for `RENDER` loses its meaning: the redraw draws the rolled-back state,
  // which still carries `refreshing…`, and nothing is left to take it down. That is the §7 V7
  // notice stranded again, reached through the timeout path this time.
  const renderer = new HangingRenderer();
  const app = new App({
    bridge: new FakeBridge(),
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    renderTimeoutMs: 25,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('LONG_PRESS');
  await app.dispatch('CLICK'); // Refresh now → refreshing… goes up
  assert.equal(app.current.statusNotice, REFRESHING);

  // REFRESH_DONE's redraw is a mount after M6b (the status container goes away with the notice),
  // and this one blows the deadline.
  renderer.lateMountMs = 60;
  await settle(REFRESH_NOTICE_MIN_MS + 400);
  assert.equal(app.current.statusNotice, null, 'refreshing… survived the timeout and now hides the §3 status');
});

test('a joiner does not issue its own startup call after the app has exited', async () => {
  // The joiner wakes when the first create answers. If that answer was a FAILURE and the app has
  // been torn down meanwhile, falling through to `if (!created)` sends another startup call at a
  // page that is already gone.
  let creates = 0;
  let release: ((v: number) => void) | null = null;
  const bridge = {
    createStartUpPageContainer: async () => {
      creates += 1;
      return new Promise<number>((r) => (release = r));
    },
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async () => true,
  } as unknown as ConstructorParameters<typeof Renderer>[0];

  const renderer = new Renderer(bridge);
  const input: ScreenInput = {
    payload: DEMO_PAYLOAD,
    now: DEMO_NOW,
    settings: DEFAULT_SETTINGS,
    errorCode: null,
    cursor: 0,
    notice: null,
  };

  const first = renderer.mount(allScreen, input);
  await settle(10);
  const joiner = renderer.mount(allScreen, input);
  await settle(10);

  renderer.invalidate(); // the app exits while both are waiting
  release!(1); // and the create comes back FAILED (1 = invalid)
  assert.equal(await first, false);
  assert.equal(await joiner, false);
  await settle(20);
  assert.equal(creates, 1, `the startup API was called ${creates} times, the second after teardown`);
});

// ---- R1 / R2: what the timeout window is allowed to do ----------------------

test('an action gesture is frozen until a render confirms the screen again (R1)', async (t) => {
  // The reproduction: a bridge call blows its deadline, so the machine rolls back — but the call is
  // still on its way and may paint. In that window the glasses can show a page the machine is not
  // on, and a tap runs whatever the MACHINE has under the cursor. With `Exit` there, the tap quits.
  const renderer = new HangingRenderer();
  const bridge = new FakeBridge();
  const app = new App({
    bridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 500, // the scheduled repair must not land before the tap; this test is that window
    renderTimeoutMs: 20,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('LONG_PRESS'); // menu opens on Refresh now
  for (let i = 0; i < MENU_INDEX.exit; i += 1) await app.dispatch('SCROLL_BOTTOM');
  assert.equal(app.current.cursor, MENU_INDEX.exit);

  renderer.lateMountMs = 200; // the next redraw blows the deadline and answers long afterwards
  await app.dispatch('SCROLL_TOP');
  assert.equal(app.current.cursor, MENU_INDEX.exit, 'the rollback is the premise of this test');

  const drawn = renderer.mounted.length;
  await app.dispatch('CLICK');
  assert.deepEqual(bridge.shutdownCalls, [], 'a tap on an unconfirmed screen ran Exit');
  assert.ok(renderer.mounted.length > drawn, 'the frozen gesture left no visible feedback at all');

  // And the freeze lifts as soon as that redraw lands — it is a resync, not a dead app.
  await app.dispatch('CLICK');
  assert.deepEqual(bridge.shutdownCalls, [1], 'the screen is confirmed again; the tap must work');
});

test('the real Renderer never has two bridge calls in flight at once (R2)', async () => {
  // `invalidate()` stops calls that have not been ISSUED. The one the deadline gave up on is
  // already with the bridge, so the repair render used to go out alongside it (probe:
  // `BRIDGE_OVERLAP=true`). The glasses-ui skill warns concurrent calls can drop the BLE link.
  let inFlight = 0;
  let peak = 0;
  let release: (() => void) | null = null;
  const enter = () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
  };
  const bridge = {
    createStartUpPageContainer: async () => {
      enter();
      inFlight -= 1;
      return 0;
    },
    rebuildPageContainer: async () => {
      enter();
      if (release === null) await new Promise<void>((r) => (release = r));
      inFlight -= 1;
      return true;
    },
    textContainerUpgrade: async () => true,
  } as unknown as ConstructorParameters<typeof Renderer>[0];

  const renderer = new Renderer(bridge);
  const input: ScreenInput = {
    payload: DEMO_PAYLOAD,
    now: DEMO_NOW,
    settings: DEFAULT_SETTINGS,
    errorCode: null,
    cursor: 0,
    notice: null,
  };

  await renderer.mount(allScreen, input); // the one-shot create
  const stuck = renderer.mount(allScreen, input); // a rebuild that hangs, as a flaky hop does
  await settle(10);
  renderer.invalidate(); // the caller's deadline fired; the call itself is still out there
  const repair = renderer.mount(allScreen, input); // …and the repair render arrives
  await settle(10);
  assert.equal(peak, 1, `${peak} bridge calls were in flight at once`);

  release!();
  await Promise.all([stuck, repair]);
  assert.equal(peak, 1, `${peak} bridge calls overlapped once the stuck one finished`);
});

test('a shutdown still in flight does not overlap the next redraw (R2)', async (t) => {
  // The App makes exactly one bridge call of its own. Issued straight at the bridge it skipped the
  // renderer's queue, so an exit request that stalled past its deadline was still on the link when
  // the next swipe's rebuild went out — the same overlap, through the one call that was not a
  // render. Real App, real Renderer, one bridge underneath both, as the review's probe had it.
  let inFlight = 0;
  let peak = 0;
  let releaseShutdown: (() => void) | null = null;
  const enter = () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
  };
  const bridge = {
    createStartUpPageContainer: async () => {
      enter();
      inFlight -= 1;
      return 0;
    },
    rebuildPageContainer: async () => {
      enter();
      inFlight -= 1;
      return true;
    },
    textContainerUpgrade: async () => {
      enter();
      inFlight -= 1;
      return true;
    },
    shutDownPageContainer: async () => {
      enter();
      await new Promise<void>((r) => (releaseShutdown = r));
      inFlight -= 1;
      return true;
    },
    onEvenHubEvent: () => () => {},
  };

  const renderer = new Renderer(bridge as unknown as ConstructorParameters<typeof Renderer>[0]);
  const app = new App({
    bridge: bridge as unknown as AppBridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    renderTimeoutMs: 20,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => {
    releaseShutdown?.(); // never leave the chain holding a promise that cannot settle
    app.stop();
  });
  await app.start();

  await app.dispatch('DOUBLE_CLICK'); // the exit request stalls; the deadline gives up on waiting
  await app.dispatch('SCROLL_BOTTOM'); // …and this rebuild used to go out alongside it
  assert.equal(peak, 1, `${peak} bridge calls were in flight at once`);

  releaseShutdown!();
  await settle(30);
  assert.equal(peak, 1, `${peak} bridge calls overlapped once the shutdown finished`);
});

test('a shutdown that answers after its deadline does not redraw the page (R2 follow-up)', async (t) => {
  // The repair machinery exists for calls that WRITE to the glasses. A shutdown writes nothing —
  // it asks the host for the exit dialog — so treating its late answer like a late paint rebuilt a
  // page the user had just confirmed away. `EXITING` does not guard it: the confirmation goes to
  // the host, and simulator 0.9.5 never sends `SYSTEM_EXIT` back at all (§8).
  let rebuilds = 0;
  let releaseShutdown: (() => void) | null = null;
  const bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => {
      rebuilds += 1;
      return true;
    },
    textContainerUpgrade: async () => true,
    shutDownPageContainer: async () => {
      await new Promise<void>((r) => (releaseShutdown = r));
      return true;
    },
    onEvenHubEvent: () => () => {},
  };

  const renderer = new Renderer(bridge as unknown as ConstructorParameters<typeof Renderer>[0]);
  const app = new App({
    bridge: bridge as unknown as AppBridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    renderTimeoutMs: 20,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => {
    releaseShutdown?.();
    app.stop();
  });
  await app.start();
  assert.equal(rebuilds, 0, 'the first page is a create, not a rebuild');

  await app.dispatch('DOUBLE_CLICK'); // the request stalls past the deadline
  releaseShutdown!(); // the user confirms; the host answers late
  await settle(60);
  assert.equal(rebuilds, 0, 'a late shutdown answer rebuilt a page that is on its way out');
});

test('nothing draws by itself while an exit request is outstanding, and a cancel resumes it', async (t) => {
  // The exit request cannot tear the app down — the user may cancel — but the timers behind it are
  // attached to no gesture at all: a pending retry rebuilt the page and a refresh completion
  // patched it, both after the user had confirmed the exit. There is no confirmation event to wait
  // for (simulator 0.9.5 never sends `SYSTEM_EXIT`, §8), so the page's own next event is the signal.
  let rebuilds = 0;
  let upgrades = 0;
  const bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => {
      rebuilds += 1;
      return true;
    },
    textContainerUpgrade: async () => {
      upgrades += 1;
      return true;
    },
    shutDownPageContainer: async () => true,
    onEvenHubEvent: () => () => {},
  };

  const renderer = new Renderer(bridge as unknown as ConstructorParameters<typeof Renderer>[0]);
  const app = new App({
    bridge: bridge as unknown as AppBridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('LONG_PRESS'); // menu
  await app.dispatch('CLICK'); // Refresh now → refreshing… up, REFRESH_DONE armed behind it
  assert.equal(app.current.statusNotice, REFRESHING);
  const drawnAtExit = rebuilds;

  await app.dispatch('DOUBLE_CLICK'); // the exit request; the user confirms, the page goes away
  await settle(REFRESH_NOTICE_MIN_MS + 200);
  assert.equal(upgrades, 0, 'the refresh completion patched a page that had been torn down');
  assert.equal(rebuilds, drawnAtExit, 'something rebuilt a page that had been torn down');
  assert.equal(app.current.statusNotice, null, 'the machine must still be up to date underneath');

  // …and if the dialog was CANCELLED instead, the page is still ours: the next gesture draws, and
  // the repaint the pause skipped comes with it.
  await app.dispatch('CLICK');
  await settle(20);
  assert.ok(rebuilds > drawnAtExit, 'the app stopped drawing for good after a cancelled exit');
});

test('a gesture already queued when the exit went out is not mistaken for a cancel', async (t) => {
  // Two taps delivered back to back: the second is in the queue before the first has even issued
  // the shutdown, so the person could not have seen the dialog. Counting it as a cancel drew on a
  // page that was being torn down — `["shutdown", "rebuild"]` through the real event listener.
  const calls: string[] = [];
  let listener: ((event: unknown) => void) | null = null;
  const bridge = {
    createStartUpPageContainer: async () => {
      calls.push('create');
      return 0;
    },
    rebuildPageContainer: async () => {
      calls.push('rebuild');
      return true;
    },
    textContainerUpgrade: async () => {
      calls.push('upgrade');
      return true;
    },
    shutDownPageContainer: async () => {
      calls.push('shutdown');
      return true;
    },
    onEvenHubEvent: (l: (event: unknown) => void) => {
      listener = l;
      return () => {
        listener = null;
      };
    },
  };

  const renderer = new Renderer(bridge as unknown as ConstructorParameters<typeof Renderer>[0]);
  const app = new App({
    bridge: bridge as unknown as AppBridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();
  assert.deepEqual(calls, ['create']);

  // Delivered the way the SDK delivers them — both before either is handled. `eventType` is absent
  // for a plain click (protobuf omits zero values, §10.3(a) constraint 2).
  listener!({ sysEvent: { eventType: OsEventTypeList.DOUBLE_CLICK_EVENT } });
  listener!({ sysEvent: {} });
  await settle(60);

  assert.deepEqual(calls, ['create', 'shutdown'], 'a tap made before the dialog resumed drawing');
});

test('an exit request the host refuses leaves the page drawing, not frozen', async (t) => {
  // The pause waits for a cancel that can only come from the live page. If the request never
  // reached the host there is nothing to cancel and nothing to confirm — so waiting means the
  // glasses keep the picture they had at the moment of the tap, for good.
  let rebuilds = 0;
  const bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => {
      rebuilds += 1;
      return true;
    },
    textContainerUpgrade: async () => true,
    shutDownPageContainer: async () => false, // the host refused it
    onEvenHubEvent: () => () => {},
  };

  const renderer = new Renderer(bridge as unknown as ConstructorParameters<typeof Renderer>[0]);
  const app = new App({
    bridge: bridge as unknown as AppBridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('DOUBLE_CLICK');
  await settle(10); // the refusal comes back as EXIT_REFUSED, on the same queue as everything else
  assert.equal(app.current.phase, 'LIVE', 'the app is stuck waiting for a dialog that never opened');
  assert.equal(rebuilds, 1, 'the refusal left the page frozen instead of redrawing it');

  // …and the page answers gestures again, because it never stopped being ours.
  await app.dispatch('CLICK');
  assert.equal(app.current.statusNotice, REFRESHING, 'the tap after the refusal did nothing');
});

test('gestures queued behind the exit request move nothing at all', async (t) => {
  // The old design let these keep reducing while their redraws were skipped, so the machine could
  // walk into the menu and onto `Exit` with a tool page still on the glasses — and the first tap
  // after a cancelled dialog ran an entry nobody had seen. `EXIT_REQUESTED` answers them instead:
  // no draw, and no state move either, so there is no unseen page to act on later.
  let shutdowns = 0;
  let rebuilds = 0;
  const bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => {
      rebuilds += 1;
      return true;
    },
    textContainerUpgrade: async () => true,
    shutDownPageContainer: async () => {
      shutdowns += 1;
      return true;
    },
    onEvenHubEvent: () => () => {},
  };

  const renderer = new Renderer(bridge as unknown as ConstructorParameters<typeof Renderer>[0]);
  const app = new App({
    bridge: bridge as unknown as AppBridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  // All three land in the queue before the first has even issued the shutdown.
  void app.dispatch('DOUBLE_CLICK');
  void app.dispatch('LONG_PRESS');
  void app.dispatch('SCROLL_TOP');
  await settle(40);
  assert.equal(shutdowns, 1, 'the exit request itself');
  assert.equal(app.current.phase, 'EXIT_OFFERED', 'the host has the request by now');
  assert.equal(app.current.cursor, 0, 'a queued gesture moved the cursor with nothing drawing it');
  assert.equal(app.current.exitFrom, 'root', 'a queued long press moved the machine into the menu');

  const drawnBefore = rebuilds;
  await app.dispatch('CLICK'); // the user cancelled the dialog and taps
  assert.equal(shutdowns, 1, 'the tap ran an Exit that was never on screen');
  assert.ok(rebuilds > drawnBefore, 'the cancel left no visible feedback at all');
  assert.equal(app.current.phase, 'LIVE', 'the cancel must land back on the page it covered');

  // The page is back in sync, so the next tap acts normally.
  await app.dispatch('CLICK');
  assert.equal(app.current.statusNotice, REFRESHING, 'the tap after the cancel did nothing');
});

test('input arriving while the exit request is still in flight is not a cancel', async (t) => {
  // There is no dialog to cancel until the host has the request. A tap made in that window came
  // from the old page, and treating it as a cancel drew again after the host tore the page down:
  // `shutdown` → teardown → `rebuild`. The tap here lands well past `renderTimeoutMs`, because a
  // deadline used to answer this question by reporting "sent" when it had only stopped waiting.
  const calls: string[] = [];
  let releaseShutdown: (() => void) | null = null;
  const bridge = {
    createStartUpPageContainer: async () => {
      calls.push('create');
      return 0;
    },
    rebuildPageContainer: async () => {
      calls.push('rebuild');
      return true;
    },
    textContainerUpgrade: async () => {
      calls.push('upgrade');
      return true;
    },
    shutDownPageContainer: async () => {
      calls.push('shutdown');
      await new Promise<void>((r) => (releaseShutdown = r));
      return true;
    },
    onEvenHubEvent: () => () => {},
  };

  const renderer = new Renderer(bridge as unknown as ConstructorParameters<typeof Renderer>[0]);
  const app = new App({
    bridge: bridge as unknown as AppBridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    renderTimeoutMs: 20,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => {
    releaseShutdown?.();
    app.stop();
  });
  await app.start();

  const exiting = app.dispatch('DOUBLE_CLICK');
  await settle(40); // past the render deadline, and the host still has not answered
  const tapped = app.dispatch('CLICK'); // …and this comes from the page that is on its way out
  releaseShutdown!();
  await exiting;
  await tapped;
  await settle(20);
  assert.deepEqual(calls, ['create', 'shutdown'], 'an in-flight tap resumed drawing after teardown');

  // Once the host has it, a tap IS the cancel — the page is still there and drawing resumes.
  await app.dispatch('CLICK');
  await settle(20);
  assert.ok(calls.includes('rebuild'), 'a tap after the dialog was up never brought the page back');
});

test('a second exit request is never sent while one is outstanding', async (t) => {
  // Two answers cannot be told apart. The first one opened the cancel window while the second
  // request was still on its way, so the next tap redrew a page the host had already torn down:
  // `shutdown` → `shutdown` → `rebuild`.
  let shutdowns = 0;
  let rebuilds = 0;
  let release: (() => void) | null = null;
  const bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => {
      rebuilds += 1;
      return true;
    },
    textContainerUpgrade: async () => true,
    shutDownPageContainer: async () => {
      shutdowns += 1;
      await new Promise<void>((r) => (release = r));
      return true;
    },
    onEvenHubEvent: () => () => {},
  };

  const renderer = new Renderer(bridge as unknown as ConstructorParameters<typeof Renderer>[0]);
  const app = new App({
    bridge: bridge as unknown as AppBridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => {
    release?.();
    app.stop();
  });
  await app.start();

  void app.dispatch('DOUBLE_CLICK');
  void app.dispatch('DOUBLE_CLICK'); // the user taps again because nothing has visibly happened
  await settle(20);
  assert.equal(shutdowns, 1, 'the app asked the host to exit twice; the answers are ambiguous');

  release!(); // the host has it and the dialog is up
  await settle(20);
  const drawnBefore = rebuilds;
  await app.dispatch('CLICK'); // …and this one IS a cancel
  await settle(20);
  assert.ok(rebuilds > drawnBefore, 'a cancel after a single request must resume drawing');
});

test('a cancel whose redraw is lost repairs itself, and the gestures stay alive meanwhile', async (t) => {
  // The cancel is the only thing that draws in `EXIT_OFFERED`, so when its redraw times out the
  // machine rolls back INTO that phase with the screen unknown. Owing a bare `RENDER` there owes
  // nothing — the phase ignores it by design — and freezing the next tap into one took away the
  // only input that could have put the page back: tap, double-tap and long-press all went dead.
  const renderer = new HangingRenderer();
  const app = new App({
    bridge: new FakeBridge(),
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    renderTimeoutMs: 20,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('DOUBLE_CLICK');
  await settle(10);
  assert.equal(app.current.phase, 'EXIT_OFFERED', 'the host has the request by now');

  renderer.lateMountMs = 80; // the cancel's redraw blows the deadline and answers much later
  await app.dispatch('CLICK'); // the user dismisses the dialog
  assert.equal(app.current.phase, 'EXIT_OFFERED', 'a lost redraw must roll the cancel back');

  await settle(300);
  assert.equal(app.current.phase, 'LIVE', 'nothing ever put the page back: the app is stuck');
  assert.equal(renderer.mounted.at(-1), 'all');
});

for (const gesture of ['CLICK', 'DOUBLE_CLICK', 'LONG_PRESS'] as const) {
  test(`${gesture} still works after a cancel whose redraw timed out`, async (t) => {
    // Every one of the three ACTION gestures was frozen into a `RENDER` that the exit phases
    // ignore, so all three went dead until a swipe happened to come along. In `EXIT_OFFERED` a
    // gesture already IS the resync — it is answered as the cancel, which redraws the covered page.
    const renderer = new HangingRenderer();
    const app = new App({
      bridge: new FakeBridge(),
      renderer,
      screens: SCREENS,
      clock: () => DEMO_NOW,
      retryMs: 5000, // the automatic retry must not be what saves this test
      renderTimeoutMs: 20,
      initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
    });
    t.after(() => app.stop());
    await app.start();

    await app.dispatch('DOUBLE_CLICK');
    await settle(10);
    assert.equal(app.current.phase, 'EXIT_OFFERED');

    renderer.lateMountMs = 60;
    await app.dispatch('CLICK'); // the cancel, whose redraw is lost
    assert.equal(app.current.phase, 'EXIT_OFFERED', 'the premise: the cancel was rolled back');

    const drawnBefore = renderer.mounted.length;
    await app.dispatch(gesture); // the user tries again, with the gesture under test
    assert.equal(app.current.phase, 'LIVE', `${gesture} was frozen into a redraw nothing answers`);
    assert.ok(renderer.mounted.length > drawnBefore, `${gesture} left no visible feedback`);
  });
}

test('an owed cancel never carries over to the NEXT exit dialog', async (t) => {
  // `EXIT_CANCELLED` is a claim about one dialog. Left owed after the page had already come back,
  // it fired against the next request instead — dismissing a dialog the user had just asked for,
  // with no input of their own, and redrawing the page underneath it.
  const renderer = new HangingRenderer();
  const app = new App({
    bridge: new FakeBridge(),
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 400, // long enough that the recovery below happens first, short enough to fire later
    renderTimeoutMs: 20,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('DOUBLE_CLICK');
  await settle(10);
  renderer.lateMountMs = 60;
  await app.dispatch('CLICK'); // the cancel, whose redraw is lost → a cancel is now owed
  assert.equal(app.current.phase, 'EXIT_OFFERED');

  await app.dispatch('CLICK'); // the user taps again and the page comes back
  assert.equal(app.current.phase, 'LIVE', 'the premise: the cancel has already been paid');

  // A second exit request, while that first retry is still armed.
  await app.dispatch('DOUBLE_CLICK');
  await settle(10);
  assert.equal(app.current.phase, 'EXIT_OFFERED');
  const drawnAtDialog = renderer.mounted.length;

  await settle(500); // the stale retry fires in here
  assert.equal(app.current.phase, 'EXIT_OFFERED', 'a stale retry dismissed the new dialog');
  assert.equal(renderer.mounted.length, drawnAtDialog, 'something redrew the page under the dialog');
});

for (const [label, arm] of [
  ['a refused redraw', (r: FakeRenderer) => (r.refuseNextMount = true)],
  ['a thrown redraw', (r: FakeRenderer) => (r.failNextMount = true)],
] as const) {
  test(`a cancel lost to ${label} is still owed, so the page keeps updating`, async (t) => {
    // The dismissal already happened, in the host's dialog — it is a completion event, not a
    // request, so it may not be dropped the way a rolled-back gesture is. Owing it only after a
    // TIMEOUT left these two paths owing nothing, and the machine sat in a phase that ignores
    // `TICK`: the staleness clock stopped until the user happened to press something.
    const clock = { now: DEMO_NOW };
    const renderer = new FakeRenderer();
    const app = new App({
      bridge: new FakeBridge(),
      renderer,
      screens: SCREENS,
      clock: () => clock.now,
      retryMs: 5,
      initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
    });
    t.after(() => app.stop());
    await app.start();

    await app.dispatch('DOUBLE_CLICK');
    await settle(10);
    assert.equal(app.current.phase, 'EXIT_OFFERED');

    arm(renderer);
    await app.dispatch('CLICK'); // the user dismisses the dialog; the redraw does not land
    assert.equal(app.current.phase, 'EXIT_OFFERED', 'the premise: the cancel was rolled back');

    await settle(80); // the owed cancel is re-delivered here
    assert.equal(app.current.phase, 'LIVE', 'the cancel was dropped and the page never came back');

    // And the clock is running again: one minute past Claude's 20-minute threshold.
    clock.now = new Date(Date.parse(DEMO_PAYLOAD.claude.fetchedAt!) + 20 * 60_000 + 1);
    await app.dispatch('TICK');
    assert.equal(app.current.phase, 'STALE', 'staleness stopped updating after the lost cancel');
  });
}

test('a later failed retry does not cancel a completion event still owed one', async (t) => {
  // One retry slot meant the newest failure evicted the oldest. A `RENDER` that fails after a
  // `REFRESH_DONE` that failed would drop the completion event, and `refreshing…` never comes down.
  const renderer = new HangingRenderer();
  const app = new App({
    bridge: new FakeBridge(),
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 40,
    renderTimeoutMs: 25,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('LONG_PRESS');
  await app.dispatch('CLICK'); // Refresh now → refreshing… up, REFRESH_DONE armed
  assert.equal(app.current.statusNotice, REFRESHING);

  renderer.lateMountMs = 60; // REFRESH_DONE's redraw times out → REFRESH_DONE owed a retry
  renderer.refuseNextMount = true; // …and the repair RENDER fails too, owing a second retry
  await settle(REFRESH_NOTICE_MIN_MS + 600);

  assert.equal(app.current.statusNotice, null, 'the completion event was dropped; refreshing… is stuck');
});

// ---- T3.4: the poll outcome reaching the machine ------------------------------

const NO_ERROR = (payload: UsagePayload | null): PollOutcome => ({
  payload,
  errorCode: null,
  settings: DEFAULT_SETTINGS,
  unconfigured: false,
});

/**
 * What the footer status column would say in this state, or `null` when it is not built at all —
 * after M6b it holds only §7 V2 and §7 V7, so most of the time there is no such container.
 */
function footerRight(state: AppState): string | null {
  const specs = SCREENS[screenIdOf(state)].buildContainers(screenInputOf(state));
  return specs.find((s) => s.name === 'ftrRight')?.content ?? null;
}

/**
 * One tool's section row, which is where §3's `ok`/`stale Xm` lives after M6b. Found by its label
 * rather than by index, so a change in row counts cannot make this read the wrong line.
 */
function sectionValue(state: AppState, tool: 'claude' | 'codex'): string {
  const specs = allScreen.buildContainers(screenInputOf(state));
  // §7 "dim section rows" (2026-09-10): the section rows are in the two dim containers now.
  const labels = specs.find((s) => s.name === 'secLabels')?.content.split('\n') ?? [];
  const values = specs.find((s) => s.name === 'secStatus')?.content.split('\n') ?? [];
  const row = labels.indexOf(tool === 'claude' ? 'CLAUDE' : 'CODEX');
  assert.ok(row >= 0, `the ${tool} section is not on the page at all`);
  return values[row];
}

test('the first page does not start the poll loop; `startPolling` does', async (t) => {
  // PLAN T6b.4 rule 10, the 2026-09-10 codex finding: `start()` used to paint the first page AND
  // start the poller, so the first request was built from the not-yet-hydrated browser mirror.
  // The boot (`boot.ts`) starts the loop after the hydrate; the split is what makes that possible.
  const poller = new FakePoller();
  const { app } = makeApp({ poller });
  t.after(() => app.stop());

  await app.start();
  assert.equal(poller.deliver, null, 'the poll loop was started in front of the hydrate');

  app.startPolling();
  assert.ok(poller.deliver !== null, 'the poller was never started, so nothing would ever arrive');
});

test('the poll loop is started once, however often the boot asks', async (t) => {
  // Two loops would double the request rate against the relay, and nothing on the glasses would say
  // so — the second loop's deliveries look exactly like the first's.
  const poller = new FakePoller();
  const { app } = makeApp({ poller });
  t.after(() => app.stop());
  await app.start();

  app.startPolling();
  app.startPolling();
  assert.equal(poller.starts, 1, 'a second poll loop is running against the relay');
});

test('a failed poll keeps the last good payload on screen with the §3 staleness label', async (t) => {
  // §3's threshold for Claude is `max(2 × 5, 15 + 5)` = 20 minutes, and it comes from
  // `staleThresholdMin` — asserted here so that hardcoding a number in the plugin would fail.
  assert.equal(staleThresholdMin('claude', DEFAULT_SETTINGS.pollIntervalMin), 20);
  // The fixture was fetched at 12:03:41, so 12:23:42 is one second past that threshold.
  const now = new Date('2026-09-07T12:23:42+10:00');
  const poller = new FakePoller();
  const { app, renderer } = makeApp({ poller, clock: () => now });
  t.after(() => app.stop());
  await app.start();

  // The relay is down: `poll.ts` re-delivers the last good payload with a §7 V2 code beside it.
  await app.deliver({
    payload: DEMO_PAYLOAD,
    errorCode: 'net err',
    settings: DEFAULT_SETTINGS,
    unconfigured: false,
  });

  assert.deepEqual(app.current.payload, DEMO_PAYLOAD, 'a failed poll cleared the screen');
  // Both sections are past their own thresholds by now, which is what M6b's STALE requires.
  assert.equal(app.current.phase, 'STALE');
  assert.equal(sectionValue(app.current, 'claude'), '12:03 · stale 20m', 'the section row is not the §3 label');
  assert.equal(footerRight(app.current), null, '§7 V2 codes are for CONNECTING only');
  assert.ok(renderer.patched.length > 0, 'the failure was not drawn at all');
});

test('a single section crossing its own threshold is patched onto the glasses (§3)', async (t) => {
  // The reviewer's reproduction (2026-09-10), end to end: Codex was fetched exactly one threshold ago
  // (11:54 + 10 min = 12:04) while Claude is 19 seconds old, so half a minute later only the CODEX
  // section has crossed. The PHASE cannot see that — one fresh section keeps the page LIVE — so a
  // tick guarded on the phase produced no effect at all and the row went on saying `ok`.
  const codexAtThreshold: UsagePayload = {
    ...DEMO_PAYLOAD,
    codex: { ...DEMO_PAYLOAD.codex, fetchedAt: '2026-09-07T11:54:00+10:00' },
  };
  const clock = { now: DEMO_NOW };
  const { app, renderer } = makeApp({ payload: codexAtThreshold, clock: () => clock.now });
  t.after(() => app.stop());
  await app.start();
  assert.equal(app.current.phase, 'LIVE');
  assert.equal(sectionValue(app.current, 'codex'), '11:54 · ok', 'the premise: still inside the threshold');
  const patchedBefore = renderer.patched.length;

  clock.now = new Date(DEMO_NOW.getTime() + 30_000);
  await app.dispatch('TICK');
  assert.equal(app.current.phase, 'LIVE', 'one fresh section still keeps the whole page LIVE');
  assert.ok(renderer.patched.length > patchedBefore, 'the new verdict never reached the glasses');
  assert.equal(sectionValue(app.current, 'codex'), '11:54 · stale 10m');
  assert.equal(sectionValue(app.current, 'claude'), '12:03 · ok');

  // …and the next tick, with nothing new to say, costs no bridge call at all.
  const patchedAfter = renderer.patched.length;
  await app.dispatch('TICK');
  assert.equal(renderer.patched.length, patchedAfter, 'an unchanged page was redrawn anyway');
});

test('the staleness label follows the interval the poller reports, not a copy of it', async (t) => {
  // Ten-minute polling raises Codex's threshold from 10 to 20 minutes (§3's table), so the same
  // 23-minute-old fixture that reads `stale 23m` at 5 min still reads `stale 23m` at 10 — but a
  // 15-minute-old one flips. Assert the boundary the shared constant defines.
  assert.equal(staleThresholdMin('codex', 5), 10);
  assert.equal(staleThresholdMin('codex', 10), 20);
  const now = new Date('2026-09-07T11:56:00+10:00'); // 15m after Codex's 11:41 fetchedAt
  const { app } = makeApp({ payload: DEMO_PAYLOAD, clock: () => now, poller: new FakePoller() });
  t.after(() => app.stop());
  await app.start();
  assert.equal(sectionValue(app.current, 'codex'), '11:41 · stale 15m');

  await app.deliver({
    payload: DEMO_PAYLOAD,
    errorCode: null,
    settings: { pollIntervalMin: 10 },
    unconfigured: false,
  });
  assert.equal(sectionValue(app.current, 'codex'), '11:41 · ok', 'the app kept its own copy of the interval');
  assert.equal(app.current.phase, 'LIVE');
});

test('the first payload after CONNECTING is rebuilt, not patched', async (t) => {
  // §7 V2's card is a single `Connecting…` container; the data card is two, at a different height.
  // `textContainerUpgrade` cannot add a container, so patching here would leave the old page up.
  const { app, renderer } = makeApp({ payload: null, poller: new FakePoller() });
  t.after(() => app.stop());
  await app.start();
  assert.equal(app.current.phase, 'CONNECTING');

  await app.deliver(NO_ERROR(DEMO_PAYLOAD));
  assert.deepEqual(renderer.mounted, ['all', 'all'], 'the new page was never built');
  assert.deepEqual(renderer.patched, [], 'a patch cannot create the value column');
  assert.equal(app.current.phase, 'LIVE');
});

test('poll outcomes move through UNCONFIGURED, CONNECTING and LIVE with structural mounts', async (t) => {
  const { app, renderer } = makeApp({ payload: DEMO_PAYLOAD, unconfigured: true });
  t.after(() => app.stop());
  await app.start();
  assert.equal(app.current.phase, 'UNCONFIGURED', 'a cached payload overrode the missing relay');

  await app.deliver(NO_ERROR(DEMO_PAYLOAD));
  assert.equal(app.current.phase, 'LIVE');

  await app.deliver({ ...NO_ERROR(DEMO_PAYLOAD), unconfigured: true });
  assert.equal(app.current.phase, 'UNCONFIGURED');

  await app.deliver(NO_ERROR(null));
  assert.equal(app.current.phase, 'CONNECTING');
  assert.deepEqual(renderer.mounted, ['all', 'all', 'all', 'all']);
  assert.deepEqual(renderer.patched, [], 'a phase with a different container shape was patched');
});

test('data that changes the card’s row count is rebuilt, not patched', async (t) => {
  const { app, renderer } = makeApp({ poller: new FakePoller() });
  t.after(() => app.stop());
  await app.start();

  // §3: a null window hides its row, which shortens the card — geometry, not text.
  const twoRows: UsagePayload = {
    ...DEMO_PAYLOAD,
    claude: { ...DEMO_PAYLOAD.claude, weeklySonnet: null },
  };
  await app.deliver(NO_ERROR(twoRows));
  assert.deepEqual(renderer.mounted, ['all', 'all']);
  assert.deepEqual(renderer.patched, [], 'the card was patched at the wrong height');
});

test('data that only changes the numbers takes the flicker-free path', async (t) => {
  const { app, renderer } = makeApp({ poller: new FakePoller() });
  t.after(() => app.stop());
  await app.start();

  const newer: UsagePayload = {
    ...DEMO_PAYLOAD,
    claude: { ...DEMO_PAYLOAD.claude, fiveHour: { usedPct: 64, resetsAt: '2026-09-07T14:20:00+10:00' } },
  };
  await app.deliver(NO_ERROR(newer));
  assert.deepEqual(renderer.mounted, ['all'], 'a rebuild flickers the whole page for one number');
  assert.equal(renderer.patched.length, 1);
});

test('a lost redraw rolls the new data back, and the retry brings it in again', async (t) => {
  const { app, renderer } = makeApp({ payload: null, poller: new FakePoller(), retryMs: 5 });
  t.after(() => app.stop());
  await app.start();

  renderer.refuseNextMount = true;
  await app.deliver(NO_ERROR(DEMO_PAYLOAD));
  assert.equal(app.current.payload, null, 'the machine holds data the glasses never drew');
  assert.equal(app.current.phase, 'CONNECTING');

  await settle(40);
  assert.deepEqual(app.current.payload, DEMO_PAYLOAD, 'the payload was dropped for a whole interval');
  assert.equal(app.current.phase, 'LIVE');
});

test('the menu is not redrawn by a poll, and leaving it recomputes §3 from the new data', async (t) => {
  const now = new Date('2026-09-07T12:23:42+10:00'); // past Claude's 20m threshold
  const { app, renderer } = makeApp({ poller: new FakePoller(), clock: () => now });
  t.after(() => app.stop());
  await app.start();
  await app.dispatch('LONG_PRESS');
  const drawn = renderer.mounted.length;

  await app.deliver(NO_ERROR(DEMO_PAYLOAD));
  assert.equal(renderer.mounted.length, drawn, 'the menu was rebuilt for data it does not show');
  assert.equal(app.current.phase, 'MENU');

  await app.dispatch('DOUBLE_CLICK'); // back to the tool page
  assert.equal(app.current.phase, 'STALE', 'the phase was not re-derived from the delivered payload');
});

// ---- T3.4: Refresh (§7 V7) -----------------------------------------------------

test('Refresh asks the poller, and the notice stays up for V7’s floor even when swallowed', async (t) => {
  const poller = new FakePoller(); // its `refresh()` settles immediately, as a debounced one does
  const { app } = makeApp({ poller });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('LONG_PRESS');
  await app.dispatch('CLICK'); // SELECT_Refresh
  assert.equal(poller.refreshes, 1, 'Refresh never reached the relay layer');
  assert.equal(app.current.statusNotice, REFRESHING, '§7 V7: the notice goes up on the press');

  await settle(REFRESH_NOTICE_MIN_MS / 2);
  assert.equal(app.current.statusNotice, REFRESHING, 'a swallowed refresh flickered — that reads as no feedback');

  await settle(REFRESH_NOTICE_MIN_MS);
  assert.equal(app.current.statusNotice, null, 'refreshing… is stuck over the §3 status');
  // With the notice gone the status column has nothing left to say, so it is not built at all —
  // §3's verdict is in the section rows now (M6b).
  assert.equal(footerRight(app.current), null);
  assert.equal(sectionValue(app.current, 'claude'), '12:03 · ok');
});

test('a swipe 100 ms after a tap leaves refreshing… up for the whole of V7’s floor (§7 V7/V9)', async (t) => {
  // The reviewer's reproduction (2026-09-10): on the merged page a tap IS Refresh, and a swipe is
  // answered in the footer-LEFT slot. Sharing one notice field meant the swipe replaced
  // `refreshing…` 100ms in — the §7 V7 notice gone before its fetch ended and long before its
  // one-second floor, which is the "input with no feedback" §6 rule 5 forbids.
  const poller = new FakePoller();
  const { app } = makeApp({ poller });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('CLICK'); // §7 "merged page": a tap on the root page is Refresh now
  assert.equal(app.current.statusNotice, REFRESHING, '§7 V7: the notice goes up on the press');
  await settle(100);

  await app.dispatch('SCROLL_TOP'); // §7 V9 answers on the LEFT; the right slot is not its business
  assert.equal(app.current.statusNotice, REFRESHING, 'the swipe took the refresh notice down');
  assert.equal(footerRight(app.current), REFRESHING, 'V7 is no longer in the footer status column');

  await settle(REFRESH_NOTICE_MIN_MS / 2);
  assert.equal(app.current.statusNotice, REFRESHING, '§7 V7’s one-second floor was cut short by the swipe');

  await settle(REFRESH_NOTICE_MIN_MS);
  assert.equal(app.current.statusNotice, null, 'refreshing… is stuck over the §3 status');
  assert.equal(footerRight(app.current), null);
});

test('a Refresh that takes its time keeps the notice up until the fetch ends', async (t) => {
  class SlowPoller extends FakePoller {
    release: () => void = () => undefined;
    override refresh(): Promise<void> {
      this.refreshes += 1;
      return new Promise<void>((resolve) => (this.release = resolve));
    }
  }
  const poller = new SlowPoller();
  const { app } = makeApp({ poller });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('LONG_PRESS');
  await app.dispatch('CLICK');
  await settle(REFRESH_NOTICE_MIN_MS + 100);
  assert.equal(app.current.statusNotice, REFRESHING, 'the notice came down while the fetch was still out');

  poller.release();
  await settle(50);
  assert.equal(app.current.statusNotice, null);
});

// ---- T3.4: background / teardown ----------------------------------------------

test('leaving the foreground writes the cache the migrated WebView will boot from', async (t) => {
  const poller = new FakePoller();
  const { app } = makeApp({ poller });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('FOREGROUND_EXIT');
  assert.equal(poller.flushes, 1, 'nothing was persisted before the host took the page away');
  assert.notEqual(app.current.phase, 'EXITING', 'going to the background is not an exit');
});

test('coming back to the foreground re-derives §3 before it redraws', async (t) => {
  // M6 D4: ten minutes in the background can cross Claude's 20-minute threshold, and the 30-second
  // TICK that would notice is up to half a minute away — long enough to draw a `stale` footer out
  // of a machine that still calls itself LIVE.
  let now = new Date('2026-09-07T12:04:00+10:00');
  const { app } = makeApp({ poller: new FakePoller(), clock: () => now });
  t.after(() => app.stop());
  await app.start();
  assert.equal(app.current.phase, 'LIVE');

  now = new Date('2026-09-07T12:24:00+10:00');
  await app.dispatch('FOREGROUND_ENTER');
  assert.equal(app.current.phase, 'STALE');
  assert.equal(sectionValue(app.current, 'claude'), '12:03 · stale 20m');
});

// ---- M6 D5 (2026-09-09): BLE loss suspends; the glasses coming back rebuilds -------

test('a BLE loss keeps the app alive — subscribed, polling, ticking — and forgets the page', async (t) => {
  // Measured on device: `ABNORMAL_EXIT` arrives when the link drops and the host shows the
  // Dashboard, but this WebView is still running. Tearing down here (the old behaviour) left
  // nothing that could ever put the page back; the owner had to close and reopen the app.
  const poller = new FakePoller();
  const { app, renderer, bridge } = makeApp({ poller });
  t.after(() => app.stop());
  await app.start();
  const drawn = renderer.mounted.length;

  await app.dispatch('ABNORMAL_EXIT');
  assert.equal(app.current.phase, 'DISCONNECTED');
  assert.equal(renderer.pageLostCount, 1, 'the renderer was not told the page is gone');
  assert.equal(poller.stops, 0, 'the poller was stopped: the cache would go stale while disconnected');
  assert.ok(bridge.listener !== null, 'unsubscribed: nothing could ever hear the glasses again');

  // Nothing draws while there is no page…
  await app.dispatch('CLICK');
  await app.dispatch('FOREGROUND_ENTER');
  await app.deliver(NO_ERROR(DEMO_PAYLOAD));
  assert.equal(renderer.mounted.length, drawn, 'something drew on a page that does not exist');
  assert.equal(renderer.patched.length, 0);
  assert.equal(app.current.phase, 'DISCONNECTED');

  // …and the reconnect rebuilds it, from the state the poller kept current meanwhile.
  await app.dispatch('RECONNECTED');
  assert.equal(app.current.phase, 'LIVE');
  assert.equal(renderer.mounted.at(-1), 'all', 'the page was not rebuilt on reconnect');
  await app.dispatch('CLICK');
  assert.equal(app.current.statusNotice, REFRESHING, 'input is dead after the reconnect');
});

test('the device-status subscription turns Connected into RECONNECTED, and only that', async (t) => {
  type Status = { connectType: string; isConnected(): boolean };
  // A holder rather than a `let`: TS narrows a closure-assigned `let` to its initial null.
  const status: { listener: ((s: Status) => void) | null } = { listener: null };
  const bridge = new FakeBridge() as FakeBridge & AppBridge;
  bridge.onDeviceStatusChanged = ((cb: (s: never) => void) => {
    status.listener = cb as unknown as (s: Status) => void;
    return () => {
      status.listener = null;
    };
  }) as AppBridge['onDeviceStatusChanged'];
  const statusListener = () => status.listener;
  const renderer = new FakeRenderer();
  const app = new App({
    bridge,
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();
  assert.ok(statusListener() !== null, 'the app never subscribed to device status');
  const drawn = renderer.mounted.length;

  // Connected while the page is still ours: nothing happens.
  statusListener()!({ connectType: 'connected', isConnected: () => true });
  await settle(10);
  assert.equal(renderer.mounted.length, drawn, 'a status blip rebuilt a page that was fine');

  await app.dispatch('ABNORMAL_EXIT');
  statusListener()!({ connectType: 'disconnected', isConnected: () => false });
  await settle(10);
  assert.equal(app.current.phase, 'DISCONNECTED', 'a non-Connected status must not rebuild');
  statusListener()!({ connectType: 'connected', isConnected: () => true });
  await settle(10);
  assert.equal(app.current.phase, 'LIVE');
  assert.equal(renderer.mounted.length, drawn + 1);

  app.stop();
  assert.equal(statusListener(), null, 'teardown left the device-status subscription behind');
});

test('the real Renderer creates the page AGAIN after a BLE loss instead of rebuilding nothing', async () => {
  // `createStartUpPageContainer` is one-shot per page — and after `ABNORMAL_EXIT` there is no page.
  // A `rebuildPageContainer` at that point addresses a page the host has already destroyed.
  let creates = 0;
  let rebuilds = 0;
  const bridge = {
    createStartUpPageContainer: async () => {
      creates += 1;
      return 0;
    },
    rebuildPageContainer: async () => {
      rebuilds += 1;
      return true;
    },
    textContainerUpgrade: async () => true,
  } as unknown as ConstructorParameters<typeof Renderer>[0];
  const renderer = new Renderer(bridge);
  const input: ScreenInput = {
    payload: DEMO_PAYLOAD,
    now: DEMO_NOW,
    settings: DEFAULT_SETTINGS,
    errorCode: null,
    cursor: 0,
    notice: null,
  };
  assert.equal(await renderer.mount(allScreen, input), true);
  assert.equal(await renderer.mount(allScreen, input), true);
  assert.deepEqual([creates, rebuilds], [1, 1], 'the premise: create once, then rebuild');

  renderer.pageLost();
  assert.equal(await renderer.mount(allScreen, input), true);
  assert.deepEqual([creates, rebuilds], [2, 1], 'after the page is lost the next mount must CREATE');
  assert.equal(await renderer.mount(allScreen, input), true);
  assert.deepEqual([creates, rebuilds], [2, 2], 'and later mounts rebuild the new page');
});

test('a create still in flight when the page is lost does not mark the lost page as created', async () => {
  let release: ((v: number) => void) | null = null;
  let creates = 0;
  let rebuilds = 0;
  const bridge = {
    createStartUpPageContainer: async () => {
      creates += 1;
      // Only the FIRST create is held open; the reconnect's create answers at once.
      return creates === 1 ? new Promise<number>((r) => (release = r)) : 0;
    },
    rebuildPageContainer: async () => {
      rebuilds += 1;
      return true;
    },
    textContainerUpgrade: async () => true,
  } as unknown as ConstructorParameters<typeof Renderer>[0];
  const renderer = new Renderer(bridge);
  const input: ScreenInput = {
    payload: DEMO_PAYLOAD,
    now: DEMO_NOW,
    settings: DEFAULT_SETTINGS,
    errorCode: null,
    cursor: 0,
    notice: null,
  };
  const first = renderer.mount(allScreen, input);
  await settle(10);
  renderer.pageLost(); // the link drops while the create is still out
  release!(0); // …and the create answers "success" for a page that is already gone
  assert.equal(await first, false);

  assert.equal(await renderer.mount(allScreen, input), true);
  assert.deepEqual([creates, rebuilds], [2, 0], 'the reconnect mount rebuilt a page that never existed');
});

test('a confirmed exit stops the poller', async (t) => {
  const poller = new FakePoller();
  const { app } = makeApp({ poller });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('SYSTEM_EXIT');
  assert.equal(app.current.phase, 'EXITING');
  assert.equal(poller.stops, 1, 'the poll loop outlived the page it draws on');
});

test('an older Refresh cannot take down the notice a newer one just raised (§7 V7)', async (t) => {
  // The first request outlives its own one-second floor, so by the time it answers a second
  // Refresh has raised a fresh `refreshing…`. Letting the old completion through cleared that
  // notice on the spot — the §7 V7 floor broken by a request the user had already superseded.
  let release: (() => void) | null = null;
  const poller = {
    start: () => undefined,
    refresh: () =>
      release === null ? new Promise<void>((r) => (release = r)) : Promise.resolve(),
    flush: () => undefined,
    stop: () => undefined,
  };
  const renderer = new FakeRenderer();
  const app = new App({
    bridge: new FakeBridge(),
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    poller,
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => {
    release?.();
    app.stop();
  });
  await app.start();

  await app.dispatch('LONG_PRESS');
  await app.dispatch('CLICK'); // Refresh #1 — its request hangs past the one-second floor
  assert.equal(app.current.statusNotice, REFRESHING);
  await settle(REFRESH_NOTICE_MIN_MS + 50); // floor #1 has now elapsed, the request has not

  await app.dispatch('LONG_PRESS');
  await app.dispatch('CLICK'); // Refresh #2 — a fresh notice, and a fresh floor
  assert.equal(app.current.statusNotice, REFRESHING);

  release!(); // …and #1 finally answers
  await settle(60);
  assert.equal(app.current.statusNotice, REFRESHING, 'the older Refresh took down the newer notice');

  await settle(REFRESH_NOTICE_MIN_MS);
  assert.equal(app.current.statusNotice, null, 'the newer Refresh never took its own notice down');
});

test('a patch is bounded exactly like a mount — the guarantee is about bridge calls, not about mounts', async (t) => {
  // PLAN 10.3(a) says every container's content passes through `displayText()`. `mount` did;
  // `patch` handed `update.content` straight to the bridge. The screens keep their text short, so
  // nothing was visibly wrong — but the invariant was a claim rather than a guarantee, and a
  // `textContainerUpgrade` has to survive the NEXT rebuild, where the cap is 1000, not 2000.
  const seen: string[] = [];
  const bridge = {
    createStartUpPageContainer: async () => 0,
    rebuildPageContainer: async () => true,
    textContainerUpgrade: async (c: { content?: string }) => {
      seen.push(c.content ?? '');
      return true;
    },
  } as unknown as ConstructorParameters<typeof Renderer>[0];

  const renderer = new Renderer(bridge);
  t.after(() => renderer.invalidate());
  await renderer.patch([
    { id: 1, name: 'card', content: 'x'.repeat(MAX_CONTENT_CHARS + 400) },
    { id: 2, name: 'cardVals', content: 'a\tb\rc' },
    { id: 3, name: 'rows', content: '5h\nWeek' },
  ]);

  assert.equal(seen[0]?.length, MAX_CONTENT_CHARS, 'an over-long patch reached the bridge');
  assert.equal(seen[1], 'a b c', 'control characters reached the bridge');
  assert.equal(seen[2], '5h\nWeek', 'line breaks are the row mechanism and must survive');
});

test('a superseded REFRESH_DONE is dropped at the head of the queue, not merely when created', async (t) => {
  // Checking the generation where the completion is CREATED is not enough: the dispatch then sits
  // in the queue, and a second Refresh queued ahead of it runs first. The completion arrives having
  // already passed its check, and takes down a notice that went up moments ago — §7 V7's floor
  // broken by a request nobody is waiting on. The check has to happen when the event RUNS.
  const renderer = new HangingRenderer();
  const app = new App({
    bridge: new FakeBridge(),
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 5,
    poller: { start: () => undefined, refresh: async () => undefined, flush: () => undefined, stop: () => undefined },
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('LONG_PRESS');
  await app.dispatch('CLICK'); // Refresh #1 — its completion is due in one second
  assert.equal(app.current.statusNotice, REFRESHING);

  // Hold the queue past that second, so #1's completion has to wait behind what follows.
  renderer.slowMountMs = 1400;
  const held = app.dispatch('LONG_PRESS');
  await settle(20); // the slow mount has started; later mounts must not inherit the delay
  renderer.slowMountMs = 0;
  const second = app.dispatch('CLICK'); // Refresh #2 — queued AHEAD of #1's completion

  await held;
  await second;
  await settle(50);
  assert.equal(app.current.statusNotice, REFRESHING, '#1 completed for a Refresh nobody was waiting on');

  await settle(REFRESH_NOTICE_MIN_MS);
  assert.equal(app.current.statusNotice, null, '#2 never took its own notice down');
});

test('a superseded REFRESH_DONE is dropped rather than retried onto a newer notice (§7 V7)', async (t) => {
  // The generation check at dispatch time is not enough: `REFRESH_DONE` is retryable, so a
  // completion whose redraw failed comes back on a timer — and by then a second Refresh may own
  // the notice. Reproduced as the notice going `null` 500ms into a fresh Refresh.
  const renderer = new FakeRenderer();
  const app = new App({
    bridge: new FakeBridge(),
    renderer,
    screens: SCREENS,
    clock: () => DEMO_NOW,
    retryMs: 150, // long enough to still be armed when Refresh #2 starts, short enough to fire inside its floor
    poller: { start: () => undefined, refresh: async () => undefined, flush: () => undefined, stop: () => undefined },
    initial: initialState({ payload: DEMO_PAYLOAD, now: DEMO_NOW }),
  });
  t.after(() => app.stop());
  await app.start();

  await app.dispatch('LONG_PRESS');
  await app.dispatch('CLICK'); // Refresh #1
  // Refresh #1's completion redraw will not land. Armed AFTER the click: taking the notice down is a
  // mount after M6b (the status container goes with it), and the click's own redraw is a mount too.
  renderer.refuseNextMount = true;
  await settle(REFRESH_NOTICE_MIN_MS + 60); // its REFRESH_DONE fails and is owed a retry
  assert.equal(app.current.statusNotice, REFRESHING, 'the premise: #1 could not take its notice down');

  await app.dispatch('LONG_PRESS');
  await app.dispatch('CLICK'); // Refresh #2 — a new generation owns the notice now
  await settle(400); // the stale retry fires in here, 600ms before #2's floor is up
  assert.equal(app.current.statusNotice, REFRESHING, 'a superseded completion took down the new notice');

  await settle(REFRESH_NOTICE_MIN_MS);
  assert.equal(app.current.statusNotice, null, '#2 never took its own notice down');
});
