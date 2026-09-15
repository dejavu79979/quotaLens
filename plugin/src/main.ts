// QuotaLens plugin — entry point, and the only file that knows both halves exist.
//
// The plugin is one page with two faces: the phone's WebView shows T3.5's settings form, and the
// same instance drives the glasses through the SDK bridge. They meet here and nowhere else — the
// settings page writes `localStorage`, T3.4's poller reads it back, and neither imports the other.
import './settings-page.css';
import { waitForEvenAppBridge } from '@evenrealities/even_hub_sdk';
import { App, initialState, type ScreenId } from './app.ts';
import { startThenHydrate } from './boot.ts';
import {
  CLAUDE_ONLY_PAYLOAD,
  CODEX_ONLY_PAYLOAD,
  DEMO_NOW,
  DEMO_PAYLOAD,
  EXTREME_PAYLOAD,
  NO_DATA_PAYLOAD,
} from './fixtures.ts';
import { detectLocale, LOCALES, setLocale } from './i18n.ts';
import { CACHE_KEY, Poller, readCachedPayload } from './poll.ts';
import { Renderer, type Screen } from './render.ts';
import { menuScreen } from './screens/menu.ts';
import { allScreen } from './screens/tool.ts';
import { mountSettingsPage } from './settings-page.ts';
import {
  displaySettings,
  installStore,
  loadSettings,
  mergeSettingsBlobs,
  safeStorage,
  SETTINGS_KEY,
} from './settings.ts';

const SCREENS: Record<ScreenId, Screen> = {
  all: allScreen,
  menu: menuScreen,
};

const params = new URLSearchParams(window.location.search);
setLocale(detectLocale(navigator.languages ?? [navigator.language]));
if (import.meta.env.DEV) {
  const override = params.get('lang');
  const locale = LOCALES.find((candidate) => candidate === override);
  if (locale !== undefined) setLocale(locale);
}

// The phone face goes up FIRST, before anything can block on the bridge. `waitForEvenAppBridge()`
// is a top-level await that never resolves when the glasses are not connected — and "not connected
// yet" is exactly when the owner opens this page, because the settings form is where they paste the
// relay URL in the first place. It mounts on browser storage and is handed the Even App store below
// once that exists (T6b.4): until then it can read yesterday's mirrored values and honestly says so.
const phoneRoot = document.getElementById('app');
let poller: Poller | undefined;
const settingsPage =
  phoneRoot === null ? null : mountSettingsPage(phoneRoot, { onRelaySaved: () => poller?.poke() });

// ponytail: dev-only fixture switch, kept past T3.4 for one reason — `source:"none"` (§7 V1) and a
// pinned §7 reference day cannot be produced by a live daemon, and M5's screenshots need them. Live
// data is the default and the only path the acceptance criteria run through; nothing else in the
// app may read `location.search`.
//
// `import.meta.env.DEV` is the gate (M3 QA non-blocking finding, closed in M5): without it the
// packaged build would let anyone put the glasses on fake numbers with a query parameter. Vite
// replaces the constant at build time, so a release build cannot reach the fixture branch at all.
// The fixture DATA is still in the bundle (`FIXTURES` references it unconditionally) — measured, not
// assumed: `grep 2026-09-07T12:03:41 dist/assets/*.js` still hits. That is dead weight, not a way in.
const fixture = import.meta.env.DEV ? params.get('state') : null;
// M6b adds three: the 3+3 worst case (frame G2, eight rows) and the two one-tool cases (F1'/F1''),
// none of which a live daemon can be made to produce on demand either.
const FIXTURES = {
  demo: DEMO_PAYLOAD,
  extreme: EXTREME_PAYLOAD,
  claudeonly: CLAUDE_ONLY_PAYLOAD,
  codexonly: CODEX_ONLY_PAYLOAD,
  nodata: NO_DATA_PAYLOAD,
  connecting: null,
  unconfigured: null,
} as const;
const usingFixture = fixture !== null && fixture in FIXTURES;

const bridge = await waitForEvenAppBridge();

// The glasses side, and the owner of THE bridge queue: PLAN T6b.4 rule 8 puts the host storage
// calls on this same chain (glasses-ui skill: "serialize all bridge calls, not just images";
// "`setLocalStorage` shares the same BLE link"). A storage call that misses its deadline releases
// the chain (the skill's own `Promise.race` cap), which is what keeps one unanswered
// `getLocalStorage` from freezing every redraw, exit call and input acknowledgement (§6 rule 5).
const renderer = new Renderer(bridge);

// PLAN T6b.4: browser storage in the Even App's WebView does not survive the app being closed
// (official `device-features` skill; PLAN M6 D12 caught it on the device), so both keys are written
// through to the host store and read back from it at launch.
//
// NOT hydrated here (rule 10): the hydrate happens inside `startThenHydrate` below, AFTER the first
// page is on the glasses. Until it answers, every read through this store falls through to the
// browser mirror, which is what the first page is drawn from.
const store = installStore(bridge, safeStorage(), {
  // Rule 8: one bridge queue for renders and storage alike.
  enqueue: (call) => renderer.enqueue(call),
  // Rule 9: whatever the owner typed while the page was still on browser storage outranks the host's
  // older copy — and is written to the host rather than thrown away at hydrate. Asked per key while
  // the hydrate runs, so a keystroke that lands during it counts too.
  wroteThisSession: (key) => key === SETTINGS_KEY && settingsPage?.touched === true,
  // …and rule 9 is per FIELD, which the key-level answer above cannot express: the settings are one
  // key with two fields, so one press on the interval segments used to carry the page's empty
  // `relayUrl` over a configured one (2026-09-10 codex review). The page knows which fields it has
  // edited, read live because the press can land inside the hydrate. `CACHE_KEY` is deliberately
  // absent — one §3 payload, no fields to splice, so the whole-key default is right for it.
  mergeSession: (key, session, held) =>
    key === SETTINGS_KEY
      ? mergeSettingsBlobs(session, held, settingsPage?.editedFields ?? [])
      : session,
});
// The page reads through the shared store from here on. It is still EMPTY at this point — rule 10
// hydrates behind the first glasses page — so this hand-over is not the read that matters; the
// re-sync passed to `startThenHydrate` below is (rules 2/9).
settingsPage?.useStorage(store);
// Rule 14: the row's `Saved` follows the host's durable copy, not the last ack — a late write can
// put an older value back after the ack, and the repair can itself be refused.
store.onDurability((key, durable) => {
  if (key === SETTINGS_KEY) settingsPage?.durabilityChanged(durable);
});

// PLAN T3.4: the cache is the FIRST thing on the glasses — drawn before any fetch, so a launch with
// data behind it never shows `Connecting…`. `initialState` derives LIVE/STALE from §3 on the spot,
// which is the diagram's `BOOT → SHOW_CACHED → LIVE|STALE` with nothing observable in between.
//
// Read before the hydrate (rule 10), so this is the browser mirror's copy: on the packaged app that
// is often nothing, and the host's copy arrives a moment later through `startThenHydrate`.
const payload = usingFixture ? FIXTURES[fixture as keyof typeof FIXTURES] : readCachedPayload();
poller = usingFixture ? undefined : new Poller();
const initialSettings = loadSettings();

const app = new App({
  bridge,
  renderer,
  screens: SCREENS,
  poller,
  // The fixture's `fetchedAt` is a fixed moment in §7's reference day, so its clock is held there
  // too — a live clock would read the demo data as a day stale and every screen would say `stale
  // 24h`. Live data gets the real clock, which is what makes §3's staleness mean anything.
  clock: usingFixture ? () => DEMO_NOW : () => new Date(),
  initial: initialState({
    payload,
    now: usingFixture ? DEMO_NOW : new Date(),
    // `displaySettings`, never the stored record: the latter carries `relayUrl`, and the app state
    // is rendered and logged. Assignability makes the wrong version type-check silently.
    settings: displaySettings(initialSettings),
    errorCode: fixture === 'connecting' ? 'net err' : null,
    unconfigured: fixture === 'unconfigured' || (!usingFixture && initialSettings.relayUrl === ''),
  }),
});

// PLAN T6b.4 rule 10, in one call so the order is testable: first page → hydrate → apply → start the
// poll loop (which is why the poller above is only CONSTRUCTED here — started, it would read the
// relay URL out of a store the host has not answered for yet). A fixture build passes `live: null`,
// because `?state=` owns the screen and no stored value may replace it.
const hydrated = await startThenHydrate({
  app,
  store,
  keys: [SETTINGS_KEY, CACHE_KEY],
  live: usingFixture ? null : { poller },
  // …and the phone face gets the hydrate too (rules 2/9): the relay URL saved on a previous launch
  // lives on the host only, so until this ran the form showed an empty field over a configured app.
  page: settingsPage,
});
// README screenshots need the menu on demand; this switch is fixture-only and never runs on live data.
if (usingFixture && params.get('menu') === '1') {
  await app.dispatch('LONG_PRESS');
  console.log('QuotaLens: menu opened by the ?menu=1 fixture switch');
}
console.log(
  `QuotaLens: ready (${usingFixture ? `fixture=${String(fixture)}` : 'live'}, phase=${app.current.phase}${hydrated ? ', hydrated' : ''})`,
);
