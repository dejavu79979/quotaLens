// QuotaLens plugin — T3.4 data polling: the only place the plugin talks to the relay.
//
// PLAN T3.4, one paragraph at a time:
//   - boot reads the `localStorage` cache and draws it immediately, then fetches;
//   - after that it polls on the configured interval (default 5 min), and every 30 s while there
//     is no last-good payload (CONNECTING, or UNCONFIGURED without a cache);
//   - Refresh is the same request with `?refresh=1` (§3: that is what makes the daemon re-read
//     upstream instead of handing back the same scheduled artefact), debounced by 10 s;
//   - every failure — network, 404, `version !== 1`, schema mismatch — keeps the last good payload
//     and reports a §7 V2 short code. Nothing here clears the screen and nothing throws out of it.
//
// Two hard rules from CLAUDE.md shape the file:
//   - the payload is validated by `parseUsagePayload` from `@quotalens/shared`, the single
//     definition of the contract. A response is never trusted for its shape.
//   - the relay address stays out of the app state and the failure logs name a short code rather
//     than an error object. Since M9 the address is not a secret (it is the daemon's origin on the
//     tailnet), but the glasses have no use for it and one fixed code per failure is what the
//     footer has room for (§7 V2) — so the outcome carries `PluginSettings`, not `StoredSettings`.
import { parseUsagePayload, type UsagePayload } from '@quotalens/shared';
import type { PluginSettings } from './render.ts';
import {
  activeStorage,
  displaySettings,
  flushStorage,
  loadSettings,
  nameOf,
  type StorageLike,
} from './settings.ts';

/** Where the last good payload lives between runs. One key, one JSON blob, as in settings.ts. */
export const CACHE_KEY = 'quotalens.payload';

/** §10.3(a): `CONNECTING --> CONNECTING : FETCH_FAIL(retry every 30 seconds)`. */
export const CONNECTING_RETRY_MS = 30_000;

/**
 * PLAN T3.4: Refresh carries a 10-second debounce. Leading edge — the first press goes out at once
 * and later ones inside the window are dropped — because the point of the gesture is an immediate
 * answer; a trailing-edge debounce would delay every manual refresh by ten seconds. §7 V7 is what
 * makes the dropped ones visible: the `refreshing…` notice goes up on the press, not on the request.
 */
export const REFRESH_DEBOUNCE_MS = 10_000;

/**
 * How long one request gets. Without it a hung connection would stall the loop for good — there is
 * no other timer that would ever fire. Sized under `CONNECTING_RETRY_MS` so an abandoned request
 * cannot overlap the retry that follows it; the daemon answered a cold `usage.json` in 1.1 s
 * (measured 2026-09-08 against 127.0.0.1:8787), and the tailnet hop is the part M6 re-measures.
 */
export const FETCH_TIMEOUT_MS = 15_000;

/** §7 V2's footer codes. The set is closed: these three are the only strings the column reserves. */
export const ERROR_NET = 'net err';
export const ERROR_NOT_FOUND = '404';
export const ERROR_BAD_SCHEMA = 'bad schema';

/**
 * One poll result, as the app consumes it.
 *
 * `payload` is the last good payload, NOT "the payload from this attempt": PLAN T3.4 says a failed
 * fetch keeps what is on screen, so a failure delivers the previous value together with the error
 * code. `null` means there has never been one — §7 V2 CONNECTING.
 *
 * `settings` rides along because §3's staleness threshold is a function of the poll interval: if
 * the owner changes the interval on the phone page, the footer's `ok` / `stale Xm` verdict has to
 * change with it, and the app must not be reading a stale copy of the number the poller is using.
 */
export interface PollOutcome {
  payload: UsagePayload | null;
  errorCode: string | null;
  settings: PluginSettings;
  /** `true` when there is no relay address to request yet (PLAN §7 V10). */
  unconfigured: boolean;
}

/** What `App` needs from the poller — narrowed so a test can stand in for it without a network. */
export interface DataPoller {
  start(deliver: (outcome: PollOutcome) => void): void;
  /** Resolves when the forced refresh is over, including when the debounce swallowed it (§7 V7). */
  refresh(): Promise<void>;
  /** Write the last good payload out now (`FOREGROUND_EXIT`). */
  flush(): void;
  stop(): void;
  /**
   * Poll now, off-schedule and without `?refresh=1` (PLAN T6b.4 rule 13): the relay URL arrived
   * after the loop started. Optional so a test double need not carry it.
   */
  poke?(): void;
}

export interface PollerDeps {
  /** Both the settings and the payload cache live here. Injected so tests need no DOM. */
  storage?: StorageLike;
  fetchImpl?: typeof fetch;
  clock?: () => Date;
  /** Injected so a test can assert the delay and fire it, rather than sleeping for five minutes. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * `<relay base>` → `<relay base>/usage.json[?refresh=1]` (§3, M9). The stored value is an origin
 * (`settings.ts` normalises it), so the path is always appended here and nowhere else. Throws on a
 * base that cannot be parsed, which the caller treats as a connection failure.
 */
export function usageUrl(relayBase: string, refresh: boolean): string {
  const url = new URL('/usage.json', relayBase);
  if (refresh) url.searchParams.set('refresh', '1');
  return url.toString();
}

/**
 * The cache, read back through the contract's own validator.
 *
 * Anything unreadable is discarded rather than thrown: a corrupt entry (a half-written blob, a
 * payload from an older contract version) must cost the app a cold start, not the start itself.
 */
export function readCachedPayload(storage?: Pick<StorageLike, 'getItem'>): UsagePayload | null {
  try {
    // Resolved INSIDE the try: in a WebView with site data blocked, reading the `localStorage`
    // property itself throws, and as a default parameter value that throw escaped the function and
    // took the boot down with it — no page on the glasses at all. Since T6b.4 the shared store is
    // the Even App's, hydrated before this is called, so the cache survives an app restart too.
    const raw = (storage ?? activeStorage()).getItem(CACHE_KEY);
    if (raw === null) return null;
    return parseUsagePayload(JSON.parse(raw));
  } catch (error) {
    console.error(`QuotaLens: the cached payload could not be read (${nameOf(error)}); starting without it`);
    return null;
  }
}

function writeCachedPayload(storage: Pick<StorageLike, 'setItem'>, payload: UsagePayload): void {
  try {
    storage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch (error) {
    // A full or blocked `localStorage` costs the NEXT boot its cache, and nothing else. The app
    // that is running still has the payload in hand.
    console.error(`QuotaLens: the payload cache could not be written (${nameOf(error)})`);
  }
}

/**
 * PLAN T3.4 / §10.3(a): 30 s without a payload, the configured interval once a last-good payload
 * exists. A failed poll with a cached payload is NOT connecting — the screen has data, it is just
 * ageing, and §3 already says so in the footer. UNCONFIGURED deliberately keeps this same schedule.
 */
export function nextDelayMs(hasPayload: boolean, pollIntervalMin: number): number {
  return hasPayload ? pollIntervalMin * 60_000 : CONNECTING_RETRY_MS;
}

export class Poller implements DataPoller {
  private readonly storage: StorageLike;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => Date;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  /** The payload currently on the glasses. Every failure re-delivers this one (PLAN T3.4). */
  private lastGood: UsagePayload | null = null;
  private deliver: ((outcome: PollOutcome) => void) | null = null;
  private timer: unknown = null;
  private lastRefreshAt: number | null = null;
  private stopped = false;
  /**
   * One request at a time. Two in flight could deliver out of order — an older payload landing on
   * top of a newer one — and PLAN §10.3(a) already treats the link to the glasses as serial; there
   * is no reason to treat the link to the daemon differently.
   */
  private chain: Promise<void> = Promise.resolve();

  constructor(deps: PollerDeps = {}) {
    // The shared store, not a bare `localStorage`: reading the property throws when site data is
    // blocked, and a constructor is no more able to catch that than a default parameter value was.
    // T6b.4's boot installs that store before building the poller, so this captures the host-backed
    // one — and every attempt re-reads it, so the values the hydrate adds later are picked up too
    // (rule 10 starts the loop after the hydrate for exactly that reason).
    this.storage = deps.storage ?? activeStorage();
    this.fetchImpl = deps.fetchImpl ?? ((...args) => globalThis.fetch(...args));
    this.clock = deps.clock ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  /**
   * Load the cache and start polling. Called by `App.startPolling`, which the boot runs AFTER the
   * T6b.4 hydrate (rule 10) — so the settings this first attempt reads are the host's, not the
   * browser mirror's.
   *
   * The cache is read here as well as by `main.ts` (which seeds the first render with it): without
   * it the poller would have no `lastGood`, and the first fetch failing after a cache hit would
   * deliver `null` — clearing a screen that PLAN T3.4 says must keep its data. A payload already
   * `adopt`ed wins over the read: the boot always hands over what is ON THE GLASSES, which is the
   * newer of the two copies, and this read would put the store's older one back. So this line is
   * reached only on a boot that had nothing to hand over at all.
   */
  start(deliver: (outcome: PollOutcome) => void): void {
    this.deliver = deliver;
    this.lastGood ??= readCachedPayload(this.storage);
    void this.run(false);
  }

  /**
   * Take a payload this poller did not fetch: the one the T6b.4 hydrate found (rule 10).
   *
   * The boot draws the first page from the browser mirror and only then hydrates, so the payload on
   * the glasses may be a copy the host does not have (or a newer one than it has). `lastGood` is
   * what every failed fetch re-delivers, so it has to be the payload the owner is looking at —
   * otherwise the first failure after launch draws the screen backwards, or clears it.
   */
  adopt(payload: UsagePayload): void {
    this.lastGood = payload;
  }

  /** PLAN T3.4: `?refresh=1`, debounced by 10 s; a swallowed press still settles for §7 V7. */
  async refresh(): Promise<void> {
    const now = this.clock().getTime();
    if (this.lastRefreshAt !== null && now - this.lastRefreshAt < REFRESH_DEBOUNCE_MS) {
      // Not silent: §7 V7 owes the press visible feedback, and the app supplies it by keeping
      // `refreshing…` up for its one-second floor whether or not a request went out.
      console.log('QuotaLens: refresh swallowed by the 10s debounce');
      return;
    }
    this.lastRefreshAt = now;
    await this.run(true);
  }

  flush(): void {
    if (this.lastGood === null) return;
    writeCachedPayload(this.storage, this.lastGood);
    // PLAN T6b.4 rule 4: `setItem` alone leaves the host write inside the store's 500 ms debounce,
    // and `FOREGROUND_EXIT` is exactly when the WebView may be suspended before it elapses (the
    // 2026-09-10 codex review measured zero host writes after a flush). This issues it now. Not
    // awaited: the exit does not wait for the glasses, it only makes sure the call has gone out.
    void flushStorage(this.storage);
  }

  stop(): void {
    this.stopped = true;
    this.deliver = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  /**
   * PLAN T6b.4 rule 13: the relay URL turned up after the loop started (a host read that answered
   * after the hydrate's deadline), so poll now rather than wait out an interval scheduled around an
   * empty URL. The setting snapshot lands immediately, while the request remains serialised behind
   * any request in flight; a no-op before `start()` and after `stop()`.
   */
  poke(): void {
    if (this.stopped || this.deliver === null) return;
    const stored = loadSettings(this.storage);
    const snapshotUnconfigured = stored.relayUrl === '';
    this.deliver({
      payload: this.lastGood,
      errorCode: null,
      settings: displaySettings(stored),
      unconfigured: snapshotUnconfigured,
    });
    void this.run(false, snapshotUnconfigured);
  }

  /** Test hook: resolves when every request issued so far has settled. */
  idle(): Promise<void> {
    return this.chain;
  }

  /** Serialised, and each attempt's failure is contained to that attempt (as `App.dispatch` is). */
  private run(refresh: boolean, snapshotUnconfigured?: boolean): Promise<void> {
    const next = this.chain.then(() => this.attempt(refresh, snapshotUnconfigured));
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async attempt(refresh: boolean, snapshotUnconfigured: boolean | undefined): Promise<void> {
    if (this.stopped) return;
    // Re-read every time rather than caching at construction: the settings page (T3.5) writes to
    // the same `localStorage` from the phone half of this very plugin, so pasting a relay URL takes
    // effect on the next poll instead of on the next launch.
    const stored = loadSettings(this.storage);
    // Only the display fields cross over: the app state is rendered and logged, and the glasses
    // have no use for the relay address (`displaySettings`).
    const settings: PluginSettings = displaySettings(stored);

    if (stored.relayUrl === '') {
      // A normal state, not a failure: tell the app to draw §7 V10 without inventing a §7 V2 error
      // code. The loop keeps checking so a pasted URL connects on its own.
      // Suppress the duplicate only when poke already delivered THIS state. A configured snapshot
      // can be stale by the time this queued attempt reads an empty relay.
      if (snapshotUnconfigured !== true) {
        this.deliver?.({ payload: this.lastGood, errorCode: null, settings, unconfigured: true });
      }
      this.schedule(settings.pollIntervalMin);
      return;
    }

    const relayUrl = stored.relayUrl;
    const outcome = await this.fetchOnce(relayUrl, refresh, settings);
    if (this.stopped) return;
    // The phone can replace or clear the relay while this request is in flight. Its answer then
    // belongs to an endpoint that is no longer configured, so it must not reach the screen or
    // become the cache/last-good value used by the new endpoint.
    if (loadSettings(this.storage).relayUrl !== relayUrl) {
      this.schedule(settings.pollIntervalMin);
      return;
    }
    if (outcome.errorCode === null && outcome.payload !== null) {
      this.lastGood = outcome.payload;
      writeCachedPayload(this.storage, outcome.payload);
    }
    this.deliver?.(outcome);
    this.schedule(settings.pollIntervalMin);
  }

  /** Never rejects: every failure becomes an outcome carrying the last good payload. */
  private async fetchOnce(relayUrl: string, refresh: boolean, settings: PluginSettings): Promise<PollOutcome> {
    let target: string;
    try {
      target = usageUrl(relayUrl, refresh);
    } catch {
      // An address the browser cannot parse is a connection that can never be made.
      console.error(`QuotaLens: the relay address is not a valid URL (${ERROR_NET})`);
      return this.failure(ERROR_NET, settings);
    }

    const controller = new AbortController();
    const deadline = this.setTimer(() => controller.abort(), FETCH_TIMEOUT_MS);
    let body: string;
    try {
      const response = await this.fetchImpl(target, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) {
        // §7 V2 defines exactly three codes, and `404` is the one the relay actually produces for a
        // wrong path (measured 2026-09-08). Every other status is reported as a
        // failed connection rather than as a fourth code the footer has reserved no room for.
        const code = response.status === 404 ? ERROR_NOT_FOUND : ERROR_NET;
        console.error(`QuotaLens: the relay answered ${response.status} (${code})`);
        return this.failure(code, settings);
      }
      body = await response.text();
    } catch {
      console.error(`QuotaLens: the relay could not be reached (${ERROR_NET})`);
      return this.failure(ERROR_NET, settings);
    } finally {
      this.clearTimer(deadline);
    }

    try {
      // The contract's own validator, never a local copy: `version !== 1` and any shape mismatch
      // both land here as a thrown Error carrying a JSON path (§3, CLAUDE.md contract discipline).
      const payload = parseUsagePayload(JSON.parse(body));
      return { payload, errorCode: null, settings, unconfigured: false };
    } catch (error) {
      // The NAME only, never the message: `JSON.parse` quotes the start of its input (a proxy's
      // HTML page, say), and one fixed line per failure is the habit every log here keeps.
      console.error(`QuotaLens: the relay answered something that is not a v1 payload (${ERROR_BAD_SCHEMA}, ${nameOf(error)})`);
      return this.failure(ERROR_BAD_SCHEMA, settings);
    }
  }

  private failure(errorCode: string, settings: PluginSettings): PollOutcome {
    return { payload: this.lastGood, errorCode, settings, unconfigured: false };
  }

  /** One timer, always: a manual refresh restarts the interval instead of adding a second loop. */
  private schedule(pollIntervalMin: number): void {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.run(false);
    }, nextDelayMs(this.lastGood !== null, pollIntervalMin));
  }
}
