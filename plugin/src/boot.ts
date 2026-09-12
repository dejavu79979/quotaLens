// QuotaLens plugin — the boot ORDER, which is a requirement (PLAN T6b.4 rule 10) and therefore
// code with a test rather than a sequence of statements in `main.ts`.
//
// The bug this file exists to prevent: the Even App's storage calls used to ride the renderer's
// single serialised queue (§10.3(a) "one in-flight call"), so a `getLocalStorage` that is accepted
// and never answered held everything queued behind it. With the hydrate in front of the first
// mount, the per-key deadline released the WAIT — hydrate returned, the app started — while the page
// create stayed stuck behind the abandoned read: a blank pair of glasses, §6 rule 5 in its worst
// shape (the 2026-09-10 codex review probe: `hydrateReturned: true, painted: false`).
//
// Storage and renders DO share that queue (glasses-ui skill: serialize all bridge calls; rule 8), so
// the order below is what keeps the first page in front of every storage call — and, with the
// per-call cap that also releases the queue, a host that never answers costs the boot its hydrated
// values, not the glasses their page. It is also what makes the first poll read the hydrated relay
// URL rather than the browser mirror's.
//
// So: mount first from the browser mirror, hydrate second, and apply whatever the host turns out to
// hold through the paths that already exist — `App.deliver`, which is how every poll lands.
import type { UsagePayload } from '@quotalens/shared';
import type { App } from './app.ts';
import { readCachedPayload } from './poll.ts';
import type { PluginSettings } from './render.ts';
import { displaySettings, loadSettings } from './settings.ts';

/** What the boot needs from the app: the first page, a way to apply a later one, and the poll loop. */
export type BootApp = Pick<App, 'start' | 'startPolling' | 'deliver' | 'current'>;

/** What the boot needs from the store: the hydrate, and word of a read that answered after it. */
export interface HydratableStore {
  hydrate(keys: readonly string[]): Promise<void>;
  /** Rule 13 (`BridgeStore.onLateHydrate`). Optional so a plain store double need not carry it. */
  onLateHydrate?(listener: (key: string) => void): void;
}

/** `Poller.adopt`: the poller's own last-good payload, which the hydrate may be the first to fill. */
export interface PayloadSink {
  adopt(payload: UsagePayload): void;
  /** `Poller.poke`: poll now, because the relay URL arrived after the loop started (rule 13). */
  poke?(): void;
}

/**
 * The phone page's half of "apply whatever the host turns out to hold" (PLAN T6b.4 rules 2 and 9).
 *
 * `SettingsController.resync`. The page is mounted and handed the store BEFORE the hydrate, because
 * rule 10 puts the first glasses page first — so on the packaged app it reads an empty store and has
 * to be told when the host has answered. Without this the field stayed blank over a relay URL the
 * hydrate had just recovered, and the next control the owner touched wrote that blank back over it
 * (the 2026-09-10 codex review, reproduced with the real store and controller).
 */
export interface SettingsSink {
  resync(): void;
}

/**
 * The live half of the boot, absent when a `?state=` fixture owns the screen — nothing hydrated may
 * replace a fixture, and the dev fixtures are the one case where storage is not the source of truth.
 */
export interface LiveBoot {
  poller?: PayloadSink;
  /** Injected in tests only; both default to the shared store the hydrate just filled. */
  readPayload?: () => UsagePayload | null;
  readSettings?: () => PluginSettings;
}

export interface BootDeps {
  app: BootApp;
  store: HydratableStore;
  keys: readonly string[];
  live: LiveBoot | null;
  /**
   * The settings page, re-synced after the hydrate. Absent when there is no page to re-sync —
   * `main.ts` only mounts one when the document has an `#app` element, and the probes have none.
   *
   * Outside `live`: the fixtures own the GLASSES, never the phone form, so a `?state=` build still
   * shows the owner the settings the host is holding.
   */
  page?: SettingsSink | null;
}

/**
 * PLAN T6b.4 rule 10: first page, then hydrate, then apply the difference, then poll.
 *
 * Resolves to whether the hydrate changed anything on the glasses, which is what the boot log line
 * reports and what the tests assert.
 */
export async function startThenHydrate(deps: BootDeps): Promise<boolean> {
  // Rule 13, registered BEFORE the hydrate so no late answer can slip past it: storage rides the
  // renderer's queue (rule 8), so a first render that is merely slower than the hydrate's bound
  // means the reads are issued only after the hydrate has returned UNKNOWN. When such a read then
  // answers, the store adopts it (it is the host's truth for a key nobody has touched) and this
  // re-runs the apply step for it — page, glasses, and a poll with the URL that just arrived —
  // instead of leaving the whole session on an empty browser mirror (2026-09-10 codex review).
  deps.store.onLateHydrate?.(() => void applyLate(deps));
  // The first page goes up before the host is asked anything: from the browser mirror if the Even
  // App left one, and §7 V10's setup card if the mirrored relay is empty. Either way there is
  // something to look at.
  await deps.app.start();
  // Only now: the values the host is holding are applied to a page that is already up, never waited
  // for in front of one. The hydrate runs on the store's own queue (rule 8), so a host that goes
  // quiet costs this boot its stored values and nothing on the glasses.
  await deps.store.hydrate(deps.keys);
  // Both faces of the page are behind the same hydrate, so both are brought up to date by it: the
  // phone form first because it is synchronous and cannot fail, the glasses through `deliver` below.
  deps.page?.resync();
  // A `?state=` fixture owns the screen and has no poller: nothing more to do (`App.startPolling`
  // would be a no-op anyway, and saying so here keeps the fixture path a single branch).
  if (deps.live === null) return false;
  const applied = await applyHydrated(deps.app, deps.live);
  // LAST, and this is the whole point of the split (2026-09-10 codex finding): the poll loop reads
  // the relay URL out of the shared store when it starts, so starting it inside `App.start()` — in
  // front of the hydrate — meant the first request was built from the browser mirror. An empty
  // mirror fetched NOTHING and left the first real request to the 30-second UNCONFIGURED retry; a
  // stale one fetched yesterday's endpoint and cached the answer. The first fetch goes out here,
  // immediately, with the URL the host is holding.
  deps.app.startPolling();
  return applied;
}

/**
 * Rule 13: the apply step again, for a key the host answered after the hydrate had given up on it.
 *
 * Nothing after the exit: `stop()` has torn the app down, `deliver` would only be acknowledged, and
 * the poller's `poke` is a no-op once stopped — but saying so here keeps a late host answer from
 * touching a page that no longer exists at all.
 */
async function applyLate(deps: BootDeps): Promise<void> {
  if (deps.app.current.phase === 'EXITING') return;
  deps.page?.resync();
  if (deps.live === null) return;
  await applyHydrated(deps.app, deps.live);
  // The loop may already be running on the URL it had at the time — an empty one — with its next
  // request scheduled a whole interval away. Ask for one now, with the URL that just arrived.
  deps.live.poller?.poke?.();
}

/**
 * Put whatever the host turned out to hold on the glasses, through the path a poll already uses.
 *
 * `App.deliver` rather than a new event: a hydrated cache IS a payload arriving from outside the
 * reducer, which is what `DATA` means, and it brings §3's LIVE/STALE re-derivation and the
 * shape-change mount with it for free (§10.3(a)).
 */
async function applyHydrated(app: BootApp, live: LiveBoot): Promise<boolean> {
  const painted = app.current;
  const hydrated = (live.readPayload ?? readCachedPayload)();
  const stored = loadSettings();
  const settings = live.readSettings?.() ?? displaySettings(stored);
  const unconfigured = stored.relayUrl === '';
  // A hydrate never takes data OFF the glasses: a host that holds nothing, or answered nothing
  // (rule 6), leaves the page exactly as it was drawn. And a poll that landed while the hydrate ran
  // outranks the cache — the cache is by definition a copy of an older poll.
  const payload = hydrated !== null && !olderThan(hydrated, painted.payload) ? hydrated : painted.payload;
  // T3.4: the poller's own last-good copy, which is what every failed fetch re-delivers. Handed
  // over explicitly rather than left to the read inside `Poller.start()` — which the caller runs
  // right after this — because the two can differ: the browser mirror may hold a NEWER cache than
  // the host, and the line above keeps that one on the glasses while the STORE holds the host's
  // older copy.
  //
  // UNCONDITIONAL, and in front of the early return below (the 2026-09-10 codex review, reproduced
  // with the real store and the real poller): "the hydrate changed nothing on the glasses" and "the
  // poller already has the right payload" are different statements, and a mirror ahead of the host
  // is exactly where they come apart. Taking the early return skipped the hand-over, `Poller.start`
  // read the host's older cache instead, and the first failed fetch drew the glasses BACKWARDS —
  // over a request that had brought no data at all. Set before the redraw too, so a fetch that fails
  // in between re-delivers this payload rather than `null`.
  if (payload !== null) live.poller?.adopt(payload);
  if (
    same(payload, painted.payload) &&
    same(settings, painted.settings) &&
    unconfigured === painted.unconfigured
  ) {
    return false;
  }
  await app.deliver({
    payload,
    errorCode: painted.errorCode,
    settings,
    unconfigured,
  });
  return true;
}

/** §3's own ordering field. `NaN` from an unparseable stamp compares false, i.e. "not older". */
function olderThan(candidate: UsagePayload, drawn: UsagePayload | null): boolean {
  if (drawn === null) return false;
  return Date.parse(candidate.generatedAt) < Date.parse(drawn.generatedAt);
}

/**
 * Structural equality, for deciding whether the hydrate is worth a redraw at all.
 *
 * ponytail: `JSON.stringify` on two small objects, once per launch. Both sides come from the same
 * schema — for the payload, from `JSON.parse` of text the validator rebuilt — so key order matches.
 * The ceiling is a payload whose keys ever arrive in a different order: the verdict would be
 * "changed" and the cost is one redundant redraw at boot, never a wrong screen. The upgrade is
 * comparing `generatedAt` plus the two `fetchedAt` stamps, which is what §3 actually orders on.
 */
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}
