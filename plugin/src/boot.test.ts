// Fixed +10:00 zone, as in the other plugin tests: the §7 fixtures are all `+10:00`.
process.env.TZ = 'Australia/Brisbane';

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { StartUpPageCreateResult, type EvenAppBridge } from '@evenrealities/even_hub_sdk';
import { parseUsagePayload, type UsagePayload } from '@quotalens/shared';
import { App, initialState, type AppBridge, type ScreenId } from './app.ts';
import { startThenHydrate, type PayloadSink, type SettingsSink } from './boot.ts';
import { DEMO_NOW, DEMO_PAYLOAD } from './fixtures.ts';
import {
  CACHE_KEY,
  CONNECTING_RETRY_MS,
  Poller,
  readCachedPayload,
  type DataPoller,
  type PollOutcome,
} from './poll.ts';
import { Renderer, type Screen } from './render.ts';
import { menuScreen } from './screens/menu.ts';
import { allScreen } from './screens/tool.ts';
import { SettingsController, type SavedRow } from './settings-page.ts';
import {
  DEFAULT_STORED,
  displaySettings,
  installStore,
  loadSettings,
  mergeSettingsBlobs,
  SETTINGS_KEY,
  useStorage,
  type BridgeStoreDeps,
  type StorageBridge,
  type StorageLike,
} from './settings.ts';

const SCREENS: Record<ScreenId, Screen> = { all: allScreen, menu: menuScreen };
const RELAY = 'http://127.0.0.1:8787';

/**
 * Two copies of the same account, an hour apart on §3's own ordering field, for the case where the
 * browser mirror is AHEAD of the Even App: the last session's final polls landed after the store's
 * debounced host write, or the host write failed. Both go through the contract's validator, as
 * `fixtures.ts` requires of every fixture.
 */
const NEWER_PAYLOAD = parseUsagePayload({ ...DEMO_PAYLOAD, generatedAt: '2026-09-07T12:04:00+10:00' });
const OLDER_PAYLOAD = parseUsagePayload({
  ...DEMO_PAYLOAD,
  generatedAt: '2026-09-07T11:04:00+10:00',
  // A visibly different number, so an assertion failure says WHICH copy reached the glasses.
  claude: { ...DEMO_PAYLOAD.claude, fiveHour: { usedPct: 40, resetsAt: '2026-09-07T14:20:00+10:00' } },
});

/** The browser mirror, which on the packaged app's first launch is empty (PLAN M6 D12). */
function fakeBrowserStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

/**
 * One object standing in for the whole Even App bridge: the glasses half the `Renderer` and the
 * `App` use, and the storage half the `BridgeStore` uses. They are the same host, over the same
 * serial link, which is the entire point of rule 8 — and of rule 10's ordering.
 */
function fakeHost(
  held: Record<string, string> = {},
  options: { stallReads?: boolean; holdFirstCreate?: boolean } = {},
) {
  const values = new Map(Object.entries(held));
  const counts = { creates: 0, rebuilds: 0, upgrades: 0, reads: 0, writes: 0 };
  /** Rule 13's scenario: the first page create is merely SLOW — held until the test releases it. */
  let releaseCreate: () => void = () => undefined;
  const heldCreate = new Promise<void>((resolve) => void (releaseCreate = resolve));
  const bridge = {
    onEvenHubEvent: () => () => undefined,
    shutDownPageContainer: async () => true,
    createStartUpPageContainer: async () => {
      counts.creates += 1;
      if (options.holdFirstCreate === true && counts.creates === 1) await heldCreate;
      return StartUpPageCreateResult.success;
    },
    rebuildPageContainer: async () => {
      counts.rebuilds += 1;
      return true;
    },
    textContainerUpgrade: async () => {
      counts.upgrades += 1;
      return true;
    },
    getLocalStorage: (key: string) => {
      counts.reads += 1;
      // The failure mode rule 10 is about: the host accepted the read and answers nothing, ever.
      // No `catch` rescues it, and it sits on the queue the first mount has to get through.
      if (options.stallReads === true) return new Promise<string>(() => undefined);
      return Promise.resolve(values.get(key) ?? '');
    },
    setLocalStorage: async (key: string, value: string) => {
      counts.writes += 1;
      values.set(key, value);
      return true;
    },
  };
  return {
    counts,
    values,
    releaseCreate: () => releaseCreate(),
    storage: bridge as StorageBridge,
    glasses: bridge as unknown as EvenAppBridge,
    app: bridge as unknown as AppBridge,
  };
}

/** T3.4's poller, minus the network — `adopted` is rule 10's hand-off of a hydrated cache. */
class FakePoller implements DataPoller {
  readonly adopted: UsagePayload[] = [];
  started = 0;
  /** Rule 13: off-schedule polls asked for after a late host answer, with the URL seen at the time. */
  readonly poked: string[] = [];
  /** What the store held when the loop was started: rule 10 says the hydrate has already run. */
  relayAtStart: string | null = null;

  start(_deliver: (outcome: PollOutcome) => void): void {
    this.started += 1;
    this.relayAtStart = loadSettings().relayUrl;
  }
  poke(): void {
    this.poked.push(loadSettings().relayUrl);
  }
  adopt(payload: UsagePayload): void {
    this.adopted.push(payload);
  }
  async refresh(): Promise<void> {}
  flush(): void {}
  stop(): void {}
}

/**
 * Timers as data, as in `poll.test.ts`: nothing here fires unless a test fires it.
 *
 * That is the whole assertion of the "not 30 s later" test below — the CONNECTING retry is the only
 * thing that would issue a second request, so a request that arrives while every timer is still
 * pending is one the boot itself issued.
 */
function fakeTimers() {
  const pending = new Map<number, { ms: number; fn: () => void }>();
  let nextId = 1;
  return {
    /** Every delay still outstanding, so a test can say which loop the poller is on. */
    delays: (): number[] => [...pending.values()].map((timer) => timer.ms),
    set: (fn: () => void, ms: number): unknown => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { ms, fn });
      return id;
    },
    clear: (handle: unknown): void => void pending.delete(handle as number),
  };
}

/** The real `Poller` over a recorded network, so the URL it fetches is the URL it read. */
function recordingPoller(timers: ReturnType<typeof fakeTimers>) {
  const requests: string[] = [];
  const poller = new Poller({
    clock: () => DEMO_NOW,
    setTimer: timers.set,
    clearTimer: timers.clear,
    fetchImpl: (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(JSON.stringify(DEMO_PAYLOAD), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  });
  return { poller, requests };
}

/**
 * The real `Poller` over a network that never answers, recording what it hands the app.
 *
 * T3.4's failure contract is the whole point: a failed fetch delivers `lastGood`, so `delivered`
 * says exactly which payload the poller had adopted when the first request went out.
 */
class FailingPoller extends Poller {
  readonly delivered: PollOutcome[] = [];

  override start(deliver: (outcome: PollOutcome) => void): void {
    super.start((outcome) => {
      this.delivered.push(outcome);
      deliver(outcome);
    });
  }
}

function failingPoller(timers: ReturnType<typeof fakeTimers>): FailingPoller {
  return new FailingPoller({
    clock: () => DEMO_NOW,
    setTimer: timers.set,
    clearTimer: timers.clear,
    // What a browser hands back for an unreachable host: a rejected promise, not a `!response.ok`.
    fetchImpl: (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch,
  });
}

async function captureErrorsAsync<T>(body: () => Promise<T>): Promise<{ result: T; logged: string }> {
  const real = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    return { result: await body(), logged: lines.join('\n') };
  } finally {
    console.error = real;
  }
}

/**
 * The phone-side page, without a DOM: the real `SettingsController` over a recording view, which is
 * what `mountSettingsPage` hands `main.ts`. Mounted on the browser mirror, exactly as `main.ts` does
 * before `waitForEvenAppBridge()` has resolved.
 */
function fakeSettingsPage(storage: StorageLike) {
  // `SavedRow` covers the blank row too: a commit with a newer one behind it paints `null` rather
  // than leaving a stale `Saved` up (PLAN T6b.4 spec item 3).
  const painted = { relay: [] as string[], poll: [] as number[], saved: [] as SavedRow[] };
  const controller = new SettingsController(
    {
      showRelay: (text) => void painted.relay.push(text),
      showPollInterval: (min) => void painted.poll.push(min),
      showTestRow: () => undefined,
      showSaved: (outcome) => void painted.saved.push(outcome),
    },
    { storage },
  );
  controller.start();
  return { controller, painted };
}

/**
 * `main.ts` in miniature, in the order rule 10 fixes: renderer → store → app → first page → hydrate
 * → apply → START POLLING.
 *
 * The poller arrives as a factory because `main.ts` builds it after the store is installed and
 * before the hydrate: the real `Poller` captures the shared store at construction, and the point of
 * rule 10 is that it is only STARTED once the hydrate has filled it.
 */
function bootRigWith<P extends DataPoller & PayloadSink>(
  host: ReturnType<typeof fakeHost>,
  mirror: ReturnType<typeof fakeBrowserStorage>,
  makePoller: () => P,
  deps: BridgeStoreDeps = {},
) {
  // `installStore` is idempotent by design (`qa-live.ts` installs before `main.ts` does), so each rig
  // starts from no shared store — otherwise a previous test's host answers this test's reads.
  useStorage(null);
  const renderer = new Renderer(host.glasses);
  const store = installStore(host.storage, mirror, {
    // Rule 8, exactly as `main.ts` wires it: the store's host calls ride the renderer's queue — the
    // glasses-ui skill serialises EVERY bridge call — which is what makes a slow first render delay
    // the hydrate's reads (rule 13's scenario) rather than run alongside them.
    enqueue: (call) => renderer.enqueue(call),
    callTimeoutMs: 20,
    hydrateTimeoutMs: 60,
    debounceMs: 1,
    ...deps,
  });
  const poller = makePoller();
  const app = new App({
    bridge: host.app,
    renderer,
    screens: SCREENS,
    poller,
    // The app's own bound on a bridge call, scaled to the test like the store's deadlines above: a
    // first create the host holds (rule 13's scenario) must release `app.start()` in milliseconds.
    renderTimeoutMs: 40,
    clock: () => DEMO_NOW,
    initial: initialState({
      // Read through the store BEFORE the hydrate: the browser mirror is all there is, which is
      // what the first page is drawn from.
      payload: readCachedPayload(),
      now: DEMO_NOW,
      settings: displaySettings(loadSettings()),
      unconfigured: loadSettings().relayUrl === '',
    }),
  });
  const boot = (page?: SettingsSink | null): Promise<boolean> =>
    startThenHydrate({ app, store, keys: [SETTINGS_KEY, CACHE_KEY], live: { poller }, page });
  return { renderer, store, poller, app, boot };
}

/** The rig every test that does not care about the network uses. */
function bootRig(
  host: ReturnType<typeof fakeHost>,
  mirror: ReturnType<typeof fakeBrowserStorage>,
  deps: BridgeStoreDeps = {},
) {
  return bootRigWith(host, mirror, () => new FakePoller(), deps);
}

test('T6b.4 rule 10 — a host store that never answers still leaves a page on the glasses', { timeout: 4000 }, async () => {
  // The 2026-09-10 codex review probe: `hydrateReturned: true, painted: false`. The hydrate's own
  // deadline released the WAIT, so boot carried on — but the abandoned read still held the renderer's
  // queue, and the first `createStartUpPageContainer` was behind it. Nothing was ever drawn.
  const host = fakeHost({}, { stallReads: true });
  const rig = bootRig(host, fakeBrowserStorage());
  try {
    const { result: applied, logged } = await captureErrorsAsync(rig.boot);

    assert.equal(host.counts.creates, 1, 'the glasses got no page: the first mount waited on the host store');
    // One ask per key and no retries: rule 8's storage queue abandons the stalled read and goes on
    // to the next key, and rule 7's whole-hydrate deadline stops it there. (This used to assert
    // exactly ONE read — the second was stuck behind the first for good, which is the deadlock the
    // rule 8 rewrite removed, so it is now an upper bound rather than a pin on the blockage.)
    assert.ok(
      host.counts.reads >= 1 && host.counts.reads <= 2,
      `a stalled read was re-asked or overlapped: ${host.counts.reads} reads for 2 keys`,
    );
    assert.equal(rig.app.current.phase, 'UNCONFIGURED', 'an empty relay must draw §7 V10 on the first page');
    assert.equal(applied, false, 'a hydrate that learned nothing must not redraw');
    // Rule 6/7: a key that never answered is UNKNOWN, which reads as absent rather than as `''`.
    assert.deepEqual(loadSettings(rig.store), DEFAULT_STORED);
    assert.ok(logged.includes('did not answer'), `the timeout should be logged: ${logged}`);
  } finally {
    // Unconditional: a failure here can leave the app in its mount-retry loop, which holds the file.
    rig.app.stop();
    useStorage(null);
  }
});

test('T6b.4 rule 13 — a first render slower than the hydrate does not cost the session its saved settings', { timeout: 4000 }, async () => {
  // Codex review probe on 88e4b44, with the production wiring (storage on the renderer's queue):
  // the first page create is merely slow — longer than the hydrate's bound — so the reads behind it
  // are issued only after the hydrate returned UNKNOWN; their answers were discarded, and the
  // poller ran the whole session on an empty browser mirror. The late answer is the host's truth
  // for a key nobody touched, so it is adopted, the page is re-synced, and a poll goes out with it.
  const saved = JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 });
  const host = fakeHost({ [SETTINGS_KEY]: saved }, { holdFirstCreate: true });
  const rig = bootRig(host, fakeBrowserStorage());
  let resyncs = 0;
  const page: SettingsSink = { resync: () => void (resyncs += 1) };
  try {
    const { logged } = await captureErrorsAsync(async () => {
      const booting = rig.boot(page);
      // The create is held past the hydrate's deadline: boot goes on with UNKNOWN keys.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await booting;
      assert.equal(host.counts.reads, 0, 'a read went out past the render still with the host');
      assert.equal(loadSettings().relayUrl, '', 'the hydrate answered before the host could');
      assert.equal(rig.poller.relayAtStart, '', 'the loop started before the host answered');
      // Now the glasses answer. The queued reads go out, late, and the store must not drop them.
      host.releaseCreate();
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    assert.match(logged, /did not answer in time/);
    assert.equal(loadSettings().relayUrl, RELAY, 'the late host answer was discarded (rule 13)');
    assert.ok(resyncs >= 2, `the settings page was not re-synced after the late answer (${resyncs})`);
    assert.deepEqual(rig.poller.poked, [RELAY], 'no poll went out with the URL that arrived late');
  } finally {
    rig.app.stop();
    useStorage(null);
  }
});

test('T6b.4 rule 8 — a host storage call that never answers does not hold the glasses queue', { timeout: 4000 }, async () => {
  // The 2026-09-10 fifth-round codex finding: storage rode the renderer's chain, and a
  // `getLocalStorage` the host accepted and never answered sat at the head of it — every later
  // redraw, exit call and input acknowledgement queued behind a call that would never settle. Rule
  // 10 saved the FIRST page; everything after it was frozen (§6 rule 5). The queues are separate now.
  const host = fakeHost({}, { stallReads: true });
  const rig = bootRig(host, fakeBrowserStorage());
  try {
    await captureErrorsAsync(rig.boot);
    assert.equal(host.counts.creates, 1, 'the first page never went up');

    // The abandoned read is still with the host. A redraw issued now must reach the glasses anyway.
    const redraw = rig.app
      .deliver({
        payload: DEMO_PAYLOAD,
        errorCode: null,
        settings: displaySettings(DEFAULT_STORED),
        unconfigured: false,
      })
      .then(() => 'painted');
    const outcome = await Promise.race([
      redraw,
      new Promise<string>((resolve) => void setTimeout(() => resolve('stuck'), 250)),
    ]);

    assert.equal(outcome, 'painted', 'the redraw was queued behind a host storage call that never answered');
    assert.ok(host.counts.rebuilds + host.counts.upgrades > 0, 'nothing new ever reached the glasses');
  } finally {
    // Unconditional: when this test FAILS the app is in the retry loop the deadlock produces, and
    // leaving it running holds the whole file open (measured: 31 mount timeouts and still going).
    rig.app.stop();
    useStorage(null);
  }
});

test('T6b.4 rule 10 — the cache the host was holding is applied after the first page', { timeout: 4000 }, async () => {
  // The packaged app's normal launch: browser storage was cleared by the Even App, so the first page
  // is §7 V10 UNCONFIGURED, and everything durable arrives from the host a moment later. It has to
  // reach the glasses through the path a poll already uses, or the owner stares at the setup card
  // until the next fetch lands.
  const host = fakeHost({
    [CACHE_KEY]: JSON.stringify(DEMO_PAYLOAD),
    [SETTINGS_KEY]: JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 10 }),
  });
  try {
    const rig = bootRig(host, fakeBrowserStorage());
    assert.equal(rig.app.current.payload, null, 'the browser mirror was supposed to be empty');
    assert.equal(rig.app.current.phase, 'UNCONFIGURED', 'the empty mirror did not produce the setup page');

    const applied = await rig.boot();

    assert.equal(applied, true, 'the hydrated payload was never applied');
    assert.deepEqual(rig.app.current.payload, DEMO_PAYLOAD, 'the app state does not carry the hydrated payload');
    assert.equal(rig.app.current.phase, 'LIVE', 'the phase was not re-derived from §3 against the new payload');
    assert.equal(rig.app.current.settings.pollIntervalMin, 10, 'the hydrated interval never reached the state');
    assert.equal(host.counts.creates, 1, 'the one-shot page create must still have happened exactly once');
    assert.ok(
      host.counts.rebuilds + host.counts.upgrades > 0,
      'the glasses were never re-drawn with the hydrated payload',
    );
    // T3.4: the poller's `lastGood` is what every failed fetch re-delivers. It is handed the payload
    // the boot put on the glasses, which is not always the one in the store (the browser mirror can
    // hold a NEWER cache than the host), so without this hand-off a later failure would draw
    // backwards.
    assert.deepEqual(rig.poller.adopted, [DEMO_PAYLOAD], 'the poller was left without a last-good payload');
    // Rule 10's other half: the loop is started after the hydrate, so it reads the hydrated URL.
    assert.equal(rig.poller.started, 1, 'the poll loop was never started');
    assert.equal(rig.poller.relayAtStart, RELAY, 'the poller was started before the hydrate filled the store');
    rig.app.stop();
  } finally {
    useStorage(null);
  }
});

test('T6b.4 rule 10 — the first request goes to the URL the hydrate found, never the mirror’s', { timeout: 4000 }, async () => {
  // The 2026-09-10 codex finding: `App.start()` painted the first page AND started the poll loop, so
  // the first request was built from the browser mirror — which on a sideloaded build that has since
  // been repointed still holds YESTERDAY's relay URL. One request to the old endpoint, and its answer
  // cached over the new one's.
  const stale = 'http://yesterday:8787';
  const host = fakeHost({ [SETTINGS_KEY]: JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 }) });
  const mirror = fakeBrowserStorage({
    [SETTINGS_KEY]: JSON.stringify({ relayUrl: stale, pollIntervalMin: 5 }),
  });
  const timers = fakeTimers();
  const network = { requests: [] as string[] };
  const rig = bootRigWith(host, mirror, () => {
    const built = recordingPoller(timers);
    network.requests = built.requests;
    return built.poller;
  });
  try {
    await rig.boot();
    await rig.poller.idle();
    // Drains the dispatch queue: the poller's delivery is `void`ed onto it, and tearing the app down
    // with that redraw still in flight would abandon a bridge call mid-mount.
    await rig.app.dispatch('TICK');

    assert.equal(network.requests.length, 1, `expected exactly one request, saw ${network.requests.length}`);
    assert.ok(
      !network.requests.some((url) => url.includes('yesterday')),
      'the poller fetched the stale mirror URL: it was started before the hydrate',
    );
    assert.equal(network.requests[0], `${RELAY}/usage.json`, 'the first request did not go to the hydrated endpoint');
  } finally {
    rig.poller.stop();
    rig.app.stop();
    useStorage(null);
  }
});

test('T6b.4 rule 10 — with an empty mirror the first fetch goes out at the hydrate, not 30 s later', { timeout: 4000 }, async () => {
  // The packaged app's normal launch (PLAN M6 D12): the mirror is empty, so a poller started before
  // the hydrate reads `relayUrl: ''`, issues NOTHING, and arms the §10.3(a) UNCONFIGURED retry — the
  // owner watches the setup card for thirty seconds over a relay that was reachable all along.
  const host = fakeHost({ [SETTINGS_KEY]: JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 }) });
  const timers = fakeTimers();
  const network = { requests: [] as string[] };
  const rig = bootRigWith(host, fakeBrowserStorage(), () => {
    const built = recordingPoller(timers);
    network.requests = built.requests;
    return built.poller;
  });
  try {
    await rig.boot();
    await rig.poller.idle();

    // Every timer is still pending, so this request cannot have come from a retry.
    assert.equal(
      network.requests.length,
      1,
      `the first fetch waited for a timer: requests=${network.requests.length}, pending=${timers.delays().join(',')}`,
    );
    // And the loop is now on the configured interval, not the CONNECTING self-loop: the first fetch
    // succeeded, so there is data on screen and nothing left to reconnect to.
    assert.ok(
      !timers.delays().includes(CONNECTING_RETRY_MS),
      `the CONNECTING retry is armed, so the boot fetched nothing: pending=${timers.delays().join(',')}`,
    );
    // …and the payload it answered with reaches the glasses through the normal `DATA` path. `TICK`
    // drains the dispatch queue: the poller's delivery is `void`ed, so there is nothing else to await.
    await rig.app.dispatch('TICK');
    assert.deepEqual(rig.app.current.payload, DEMO_PAYLOAD, 'the first poll never reached the screen');
  } finally {
    rig.poller.stop();
    rig.app.stop();
    useStorage(null);
  }
});

test('T6b.4 rule 10 — a hydrate that changes nothing still hands the poller the payload on screen', { timeout: 4000 }, async () => {
  // The 2026-09-10 codex finding, reproduced with the real store and the real poller. The browser
  // mirror holds a NEWER cache than the Even App — last session's final polls landed after the
  // store's debounced host write — so the first page is drawn from the mirror and the hydrate has
  // nothing to add: same settings, and a payload OLDER than the one already up. `startThenHydrate`
  // took its early return, which skipped the hand-over, and `Poller.start()` then loaded its
  // `lastGood` from the store — the host's older copy. The first failed fetch re-delivered THAT, and
  // the glasses went backwards in time over a fetch that never brought any data at all.
  const host = fakeHost({
    [CACHE_KEY]: JSON.stringify(OLDER_PAYLOAD),
    [SETTINGS_KEY]: JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 }),
  });
  const mirror = fakeBrowserStorage({
    [CACHE_KEY]: JSON.stringify(NEWER_PAYLOAD),
    [SETTINGS_KEY]: JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 }),
  });
  const timers = fakeTimers();
  const rig = bootRigWith(host, mirror, () => failingPoller(timers));
  try {
    assert.deepEqual(rig.app.current.payload, NEWER_PAYLOAD, 'the first page must be drawn from the mirror');

    const { result: applied } = await captureErrorsAsync(async () => {
      const outcome = await rig.boot();
      await rig.poller.idle();
      // Drains the dispatch queue: the poller's delivery is `void`ed onto it.
      await rig.app.dispatch('TICK');
      return outcome;
    });

    assert.equal(applied, false, 'nothing changed on the glasses, so the hydrate owed no redraw');
    assert.equal(rig.poller.delivered.length, 1, 'the first fetch was supposed to fail and deliver');
    assert.deepEqual(
      rig.poller.delivered[0]?.payload,
      NEWER_PAYLOAD,
      'the failed fetch re-delivered the host’s older cache: the poller never adopted what was on screen',
    );
    assert.deepEqual(rig.app.current.payload, NEWER_PAYLOAD, 'the glasses went back in time');
  } finally {
    rig.poller.stop();
    rig.app.stop();
    useStorage(null);
  }
});

test('T6b.4 rules 2/9 — the settings page is re-synced from the store after the hydrate', { timeout: 4000 }, async () => {
  // The 2026-09-10 codex finding, reproduced with the real store and the real controller: `main.ts`
  // handed the page the host-backed store BEFORE the hydrate (rule 10 put the first glasses page
  // first), so the page read an empty store and never looked again. On the packaged app — where the
  // browser mirror is empty and the relay URL only exists on the host — the field stayed blank after
  // a launch that had just hydrated the URL, and the next control the owner touched wrote that blank
  // back over it.
  const host = fakeHost({ [SETTINGS_KEY]: JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 10 }) });
  const mirror = fakeBrowserStorage();
  // The app's own timers are stopped in `finally`: a failing assertion here used to leave the TICK
  // interval running, and the test runner then hung instead of reporting the failure.
  const rig = bootRig(host, mirror);
  try {
    const page = fakeSettingsPage(mirror);
    // `main.ts` hands the store over before `startThenHydrate`, so this read finds nothing.
    page.controller.useStorage(rig.store);
    assert.equal(page.controller.settings.relayUrl, '', 'the mirror is empty, so the page starts blank');

    await rig.boot(page.controller);

    assert.equal(page.controller.settings.relayUrl, RELAY, 'the page never picked up the hydrated URL');
    assert.equal(page.painted.relay.at(-1), RELAY, 'the re-sync must repaint');
    assert.equal(page.painted.poll.at(-1), 10, 'the hydrated interval never reached the segments');
    assert.deepEqual(page.painted.saved, [], 'a re-sync is a repaint, not a save');
  } finally {
    rig.app.stop();
    useStorage(null);
  }
});

test('T6b.4 rule 9 — a URL typed before the hydrate finished stays, and is the one written to the host', { timeout: 4000 }, async () => {
  // Rule 9 with the page in the loop: the owner pastes a URL while the glasses are still
  // disconnected, so it is in the browser mirror and not in the store the hydrate is about to fill.
  // The re-sync must not undo it — a hydrated value fills a field the owner has NOT touched.
  const typed = 'http://100.64.0.7:8787';
  const host = fakeHost({
    [SETTINGS_KEY]: JSON.stringify({ relayUrl: 'http://yesterday:8787', pollIntervalMin: 10 }),
  });
  const mirror = fakeBrowserStorage();
  let page: ReturnType<typeof fakeSettingsPage> | null = null;
  const rig = bootRig(host, mirror, {
    // What `main.ts` injects, verbatim: the key-level question and the field-level merge.
    wroteThisSession: (key) => key === SETTINGS_KEY && page?.controller.touched === true,
    mergeSession: (key, session, held) =>
      key === SETTINGS_KEY
        ? mergeSettingsBlobs(session, held, page?.controller.editedFields ?? [])
        : session,
  });
  try {
    page = fakeSettingsPage(mirror);
    await page.controller.editRelay(typed);
    page.controller.useStorage(rig.store);

    await rig.boot(page.controller);

    assert.equal(page.controller.settings.relayUrl, typed, 'the hydrate took back the URL just typed');
    assert.equal(page.painted.relay.at(-1), typed, 'the page is painting the wrong address');
    // Rule 9's granularity, re-pinned by the 2026-09-10 codex review: the merge is per FIELD, so the
    // only thing the session owns here is the URL it typed. The host's interval 10 fills the field
    // nobody touched, instead of losing to the default the page happened to be showing.
    assert.equal(
      page.controller.settings.pollIntervalMin,
      10,
      'a field the owner never touched must come from the host',
    );
    await rig.store.persist();
    assert.equal(
      JSON.parse(host.values.get(SETTINGS_KEY) as string).relayUrl,
      typed,
      'the typed URL was kept on the page but never written to the host',
    );
    assert.equal(
      JSON.parse(host.values.get(SETTINGS_KEY) as string).pollIntervalMin,
      10,
      'the untouched interval was overwritten in the Even App as well',
    );
  } finally {
    rig.app.stop();
    useStorage(null);
  }
});

test('T6b.4 rule 9 — an interval toggled before the hydrate finished keeps the host’s relay URL', { timeout: 4000 }, async () => {
  // The same finding in its destructive direction (2026-09-10 codex review). Browser mirror empty —
  // the packaged app clears it — the host holding the configured relay URL, and the owner presses a
  // poll-interval segment before the hydrate has answered. With rule 9 as one dirty KEY, the page's
  // blob (`relayUrl` still empty, because nothing had hydrated yet) went over the host's copy and
  // was written back to it: the URL gone from the store, the page and the Even App at once.
  const host = fakeHost({ [SETTINGS_KEY]: JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 10 }) });
  const mirror = fakeBrowserStorage();
  let page: ReturnType<typeof fakeSettingsPage> | null = null;
  const rig = bootRig(host, mirror, {
    wroteThisSession: (key) => key === SETTINGS_KEY && page?.controller.touched === true,
    mergeSession: (key, session, held) =>
      key === SETTINGS_KEY
        ? mergeSettingsBlobs(session, held, page?.controller.editedFields ?? [])
        : session,
  });
  try {
    page = fakeSettingsPage(mirror);
    await page.controller.setPollInterval(3);
    page.controller.useStorage(rig.store);
    assert.equal(page.controller.settings.relayUrl, '', 'the mirror is empty, so the page starts blank');

    await rig.boot(page.controller);

    const merged = { relayUrl: RELAY, pollIntervalMin: 3 };
    assert.equal(page.controller.settings.pollIntervalMin, 3, 'the press the owner made was undone');
    assert.equal(page.controller.settings.relayUrl, RELAY, 'the interval press wiped the hydrated URL');
    assert.equal(page.painted.relay.at(-1), RELAY, 'the page is not painting the merged address');
    assert.deepEqual(loadSettings(rig.store), merged, 'the store is what the poller reads');
    await rig.store.persist();
    assert.deepEqual(
      JSON.parse(host.values.get(SETTINGS_KEY) as string),
      merged,
      'the merged blob never reached the Even App',
    );
  } finally {
    rig.app.stop();
    useStorage(null);
  }
});
