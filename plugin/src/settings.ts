// QuotaLens plugin — the settings the phone page writes and the glasses app reads (PLAN T3.5, §7).
//
// This is the seam between the two halves of M3, so it is deliberately the only place that knows
// the storage key, the allowed values and what happens to a bad one. T3.4's poller reads it; T3.5's
// settings page writes it; neither invents a default of its own.
//
// PLAN T3.4 stores ONE connection value. Since M9 (2026-09-11 owner ruling) that value is the
// daemon's ORIGIN — `http://<tailnet IP>:8787` — and nothing in it is secret; `poll.ts` appends
// `/usage.json`. Whatever the owner types is normalised here (`normalizeRelayBase`), which is also
// what migrates a pre-M9 `…/u/<secret>/usage.json` value to its origin without a re-paste.
//
// Since T6b.4 the file also owns WHERE that lands: `BridgeStore` below writes through to the Even
// App, because browser storage in its WebView does not survive the app being closed. The seam the
// rest of the app sees is unchanged — a synchronous `getItem`/`setItem` — so the poller and the
// settings page still call the same four functions and still know only one storage key each.
import type { PluginSettings } from './render.ts';
import { DEFAULT_SETTINGS } from './render.ts';

/** One key, one JSON blob: nothing here is big enough to be worth separate keys. */
export const SETTINGS_KEY = 'quotalens.settings';

/** §7 / T10.9: every whole-minute interval the phone page accepts. */
export const POLL_INTERVAL_MIN = 1;
export const POLL_INTERVAL_MAX = 60;

export interface StoredSettings extends PluginSettings {
  /**
   * The relay's origin, e.g. `http://100.x.y.z:8787` (M9). The field name is kept so a stored
   * blob from before M9 still loads — its full URL is normalised down to the origin.
   *
   * Empty means "not configured yet", which is a normal state (PLAN M0-C C2b). A value that cannot
   * be parsed is kept as typed so the owner can see and fix it; the poller reports it as `net err`.
   */
  relayUrl: string;
}

export const DEFAULT_STORED: StoredSettings = { ...DEFAULT_SETTINGS, relayUrl: '' };

/** The daemon's port (PLAN §3); filled in when the owner types a bare address. */
export const RELAY_PORT = 8787;

/**
 * §7 phone side (M9): what the owner typed → the origin the poller uses.
 *
 * `100.x.y.z`, `100.x.y.z:8787`, `http://100.x.y.z:8787/`, and a pre-M9
 * `http://100.x.y.z:8787/u/<secret>/usage.json` all become `http://100.x.y.z:8787`: a
 * missing scheme is `http://`, a missing port is 8787, and any path, query or hash is dropped.
 * Empty stays empty. Anything `URL` cannot parse — or a non-http(s) scheme — is returned trimmed
 * but otherwise as typed, so the field shows the owner what they wrote rather than a blank.
 */
export function normalizeRelayBase(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  // Resolve bare addresses as network-path references. The base supplies only the
  // default protocol; the user's address supplies the host (no request to the base).
  // A full URL template becomes a fake unlisted host in the Hub's static scan.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `//${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme, 'http://127.0.0.1:8787');
  } catch {
    return trimmed;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return trimmed;
  if (url.port === '') url.port = String(RELAY_PORT);
  return url.origin;
}

/** T10.9: stored intervals must be whole minutes in range; malformed values use the default. */
export function isPollInterval(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= POLL_INTERVAL_MIN &&
    value <= POLL_INTERVAL_MAX
  );
}

function pollIntervalOf(value: unknown): number {
  return isPollInterval(value) ? value : DEFAULT_STORED.pollIntervalMin;
}

/**
 * Validate whatever came out of storage. Every field is checked independently, so one bad value
 * costs its own default and not the whole record — losing a configured relay URL because the
 * interval was malformed is the kind of thing that reads as "the app forgot my settings".
 *
 * Fields are also whitelisted rather than spread: anything the record carries that is not part of
 * the contract is dropped here. That is what makes a pre-T6b.2 blob — one that still holds §7 V3's
 * withdrawn threshold field (removed by the 2026-09-10 owner ruling) — load normally instead of
 * carrying a dead field into the app state and back out to storage on the next save.
 */
export function parseSettings(raw: unknown): StoredSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_STORED };
  const record = raw as Record<string, unknown>;
  return {
    relayUrl: typeof record.relayUrl === 'string' ? normalizeRelayBase(record.relayUrl) : DEFAULT_STORED.relayUrl,
    pollIntervalMin: pollIntervalOf(record.pollIntervalMin),
  };
}

/** Which fields of the settings blob THIS session owns (PLAN T6b.4 rule 9, per field). */
export type SettingsField = keyof StoredSettings;

/**
 * PLAN T6b.4 rule 9 at FIELD granularity: `session` owns `edited`, `host` owns the rest.
 *
 * Rule 9 is written per key ("only an untouched key may be replaced by the host value") and the settings are ONE key, so the
 * first implementation let any edit make the whole blob the session's. That is destructive in the
 * common case: the browser mirror is empty on the packaged app, the owner presses a poll-interval
 * segment while the hydrate is still in flight, and the blob that outranked the host was
 * `{"relayUrl":"","pollIntervalMin":3}` — a configured relay URL wiped from the store, the page and
 * the Even App at once (2026-09-10 codex review). The key is dirty; only some of its FIELDS are.
 *
 * Written out field by field rather than spread, for the reason `parseSettings` whitelists: adding a
 * field to the contract has to be a decision here too, not something a spread does silently.
 *
 * `session` first, as in `mergeSettingsBlobs` and in `BridgeStoreDeps.mergeSession`: the two records
 * have the same type, so a caller that swapped them would type-check and quietly reverse the rule.
 * One order everywhere is the only thing that makes the mistake visible.
 */
export function mergeSettings(
  session: StoredSettings,
  host: StoredSettings,
  edited: readonly SettingsField[],
): StoredSettings {
  return {
    relayUrl: edited.includes('relayUrl') ? session.relayUrl : host.relayUrl,
    pollIntervalMin: edited.includes('pollIntervalMin') ? session.pollIntervalMin : host.pollIntervalMin,
  };
}

/**
 * The same merge over the two stored blobs, which is the shape `BridgeStore` deals in (rule 9).
 *
 * Both sides go through `parseSettings`, so a field taken from the host is validated exactly as a
 * field read at launch is. A blob that is not an object at all has no fields to contribute: the
 * session's own blob stands, which is both the pre-fix behaviour and the only answer that leaves the
 * app on a value someone chose.
 */
export function mergeSettingsBlobs(
  session: string,
  host: string,
  edited: readonly SettingsField[],
): string {
  const held = parseBlob(host);
  const mine = parseBlob(session);
  if (held === null || mine === null) return session;
  return JSON.stringify(mergeSettings(mine, held, edited));
}

/** `null` for anything that is not a JSON object, which is the one input with no fields to merge. */
function parseBlob(text: string): StoredSettings | null {
  try {
    const raw: unknown = JSON.parse(text);
    return typeof raw === 'object' && raw !== null ? parseSettings(raw) : null;
  } catch {
    return null;
  }
}

/**
 * The one field the glasses side is allowed to see.
 *
 * `StoredSettings` is structurally assignable to `PluginSettings`, so handing the stored record
 * straight to `initialState` type-checks and quietly carries `relayUrl` into the app state, which
 * is rendered, logged and rolled back. Since M9 the address is not a secret, but the glasses have
 * no use for it and the app state stays the two display fields; one function so both callers strip
 * it the same way.
 */
export function displaySettings(stored: StoredSettings): PluginSettings {
  return { pollIntervalMin: stored.pollIntervalMin };
}

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

/** Nowhere to persist, but somewhere to read and write, so the rest of the app is unchanged. */
const memory = new Map<string, string>();
const MEMORY_STORAGE: StorageLike = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => void memory.set(key, value),
};

/**
 * `localStorage` in a WebView with site data blocked does not merely fail to store — **reading the
 * property throws**, and that throw is outside anything a `try` inside this function would catch.
 * As a default parameter value it therefore took the whole boot down with it: `main.ts` calls this
 * before `app.start()`, so the glasses got no page at all, which is the §6 rule 5 violation with
 * the worst shape. The fallback keeps the app running on defaults; nothing persists, which is
 * exactly what the environment is telling us.
 */
export function safeStorage(): StorageLike {
  try {
    // `?? MEMORY_STORAGE` covers the other shape of "no browser storage": outside a browser the
    // property is simply absent (measured on this repo's Node 26: `typeof localStorage` is
    // `undefined`), which is not an error and must not be logged as one.
    return globalThis.localStorage ?? MEMORY_STORAGE;
  } catch {
    console.error('QuotaLens: this WebView blocks site data; settings will not persist');
    return MEMORY_STORAGE;
  }
}

// ---- T6b.4: the Even App is the only store that survives an app restart -------------------------
//
// The packaged app (installed from the dev portal) came back with an empty relay URL every time the
// owner closed and reopened QuotaLens — PLAN M6 D12, found on the device 2026-09-10. The Even App's
// WebView is a Flutter WebView, and the official `device-features` skill is explicit: browser
// `localStorage` and IndexedDB there are NOT guaranteed across app restarts, and the SDK store is
// "the only reliable persistence". The sideload build survived only because its dev-server origin
// happened not to be cleared.

/**
 * The two host methods this file uses (SDK 0.0.15, `dist/index.d.ts:1358,1371`). Narrowed to those
 * two so a test can stand in for the whole bridge, and so nothing in this file can reach the
 * glasses. `getLocalStorage` answers `''` for a key the host does not hold.
 */
export interface StorageBridge {
  setLocalStorage(key: string, value: string): Promise<boolean>;
  getLocalStorage(key: string): Promise<string>;
}

/** Where a write to a store actually lands. Only `bridge` outlives the Even App being closed. */
export type Durability = 'bridge' | 'browser' | 'none';

/**
 * What one batch of host writes did, per key (PLAN T6b.4 rule 11).
 *
 * Per key rather than one boolean because a batch can disagree with itself: `quotalens.settings` and
 * `quotalens.payload` ride the same debounce, and an aggregate answer let an accepted cache write
 * speak for a refused save — `Saved` over a relay URL the Even App had thrown away (2026-09-10 codex
 * review). A key that was not in the batch is absent from the map, which is not the same as `false`.
 */
export type WriteResults = ReadonlyMap<string, boolean>;

/** Did THIS key's own write land? The only question §7 V8's notice row is allowed to ask. */
export function storedKey(results: WriteResults, key: string): boolean {
  return results.get(key) === true;
}

/** A store that knows how durable it is, and when the host acknowledged the writes queued on it. */
export interface PersistentStorage extends StorageLike {
  readonly durability: Durability;
  /**
   * Flush whatever the debounce is holding and resolve when the host has answered it (PLAN T6b.4
   * rule 8), with one answer per key in the batch (rule 11).
   */
  persist(): Promise<WriteResults>;
  /**
   * The same answer, but without cutting the debounce short — what a keystroke waits on, so typing a
   * relay URL is one host round trip instead of one per character (PLAN T6b.4 rule 8).
   */
  settled(): Promise<WriteResults>;
}

function isPersistent(storage: StorageLike): storage is PersistentStorage {
  const candidate = storage as Partial<PersistentStorage>;
  return typeof candidate.persist === 'function' && typeof candidate.settled === 'function';
}

/** Injected timers, the same shape `poll.ts` uses, so one fake drives both in a test. */
export interface StoreTimers {
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/** PLAN T6b.4 rule 8: a typed relay URL is one host write, not one per keystroke. */
export const HOST_WRITE_DEBOUNCE_MS = 500;
/** PLAN T6b.4 rule 7: one key's worth of patience with a host that has gone quiet. */
export const HOST_CALL_TIMEOUT_MS = 3_000;
/** PLAN T6b.4 rule 7: the whole hydrate, after which the rest of the boot goes ahead regardless. */
export const HYDRATE_TIMEOUT_MS = 5_000;

/** Everything a `BridgeStore` needs from outside itself. All optional, all injectable in a test. */
export interface BridgeStoreDeps extends Partial<StoreTimers> {
  /** Trailing debounce for host writes. */
  debounceMs?: number;
  /** Per-call bound on a host that accepted the call and said nothing (rule 7). */
  callTimeoutMs?: number;
  /** Bound on the whole hydrate, after which the remaining keys count as UNKNOWN (rule 7). */
  hydrateTimeoutMs?: number;
  /**
   * The ONE bridge queue — the renderer's `PageRenderer.enqueue` (PLAN T6b.4 rule 8, glasses-ui
   * skill: "Serialize all bridge calls, not just images … concurrent render + storage calls can
   * crash the connection"; "`setLocalStorage` shares the same BLE link"). Absent in tests and in a
   * store with no renderer, where the store falls back to a queue of its own.
   */
  enqueue?: <T>(call: () => Promise<T>) => Promise<T>;
  /**
   * Did this session already write this key, before this store existed? (PLAN T6b.4 rule 9.)
   *
   * The settings page is mounted on browser storage on purpose — the owner pastes the relay URL
   * while the glasses are still disconnected — so a value they just typed lives in the mirror and
   * not in the store hydrate is about to fill. Answering `true` is what stops the host's older copy
   * replacing it.
   *
   * A predicate rather than a list because hydrate takes tens of milliseconds and the owner can be
   * typing through them: a list snapshotted before the call would still lose a keystroke that landed
   * during it. Asked per key when that key is adopted AND once more per key when the last read comes
   * back — the reads are sequential, so the first ask can precede the edit — and the page stays the
   * only thing that knows whether it has been edited.
   */
  wroteThisSession?: (key: string) => boolean;
  /**
   * …and, for a key whose value has FIELDS, which of them the session owns (PLAN T6b.4 rule 9).
   *
   * `wroteThisSession` answers a question about the KEY, and answering only that made the whole blob
   * the session's: an interval press during the hydrate carried an empty `relayUrl` over a configured
   * one (2026-09-10 codex review). A store cannot merge what it cannot parse — the values here are
   * opaque strings — so the owner of each key's schema supplies the merge. `main.ts` wires
   * `mergeSettingsBlobs` for `SETTINGS_KEY` and nothing for the payload cache, which is one §3
   * payload with no fields to splice.
   *
   * Called only when BOTH sides have something to contribute: a session value exists and the host
   * answered with a non-empty one. The default keeps whole-key semantics.
   */
  mergeSession?: (key: string, session: string, host: string) => string;
}

/**
 * What the host said about one key.
 *
 * `''` is the host's own word for "I hold nothing"; `null` is the third answer PLAN T6b.4 rule 6
 * insists on — the read threw, never came back, or there is no bridge to ask. Collapsing that into
 * `''` is what let a stale browser mirror be migrated over newer durable data.
 */
type HostAnswer = string | null;

/**
 * Synchronous on the outside, the Even App underneath.
 *
 * The host API is async and `loadSettings` / the poller / the settings page are not, so this holds
 * three copies of the truth in a deliberate order: a memory map (what every synchronous read is
 * answered from), a write-through to the host (what makes the next launch have it), and a mirror in
 * browser storage (so a launch that never reaches the bridge — the glasses are not connected, which
 * is exactly when the owner is pasting a relay URL — still has yesterday's values to hydrate from).
 *
 * `''` means absent, which is the host's own convention rather than an invention here: writing `''`
 * is therefore how anything deletes a key (`qa-live.ts`'s `?fresh=1` cold start).
 *
 * ponytail: the debounce coalesces by key and nothing else, and every host call is bounded by
 * abandoning it rather than cancelling it — the SDK gives us nothing to cancel with. A write that
 * answers late is re-issued if the key has moved on (rule 12); a write refused late, with the key
 * unchanged, was already reported as not stored when its deadline passed.
 */
export class BridgeStore implements PersistentStorage {
  private readonly values = new Map<string, string>();
  private readonly bridge: StorageBridge | null;
  private readonly mirror: StorageLike;
  private readonly setTimer: StoreTimers['setTimer'];
  private readonly clearTimer: StoreTimers['clearTimer'];
  private readonly debounceMs: number;
  private readonly callTimeoutMs: number;
  private readonly hydrateTimeoutMs: number;
  /** Keys THIS store wrote: they outrank the host at hydrate and are pushed to it (rule 9). */
  private readonly dirty = new Set<string>();
  /** …and the same question for keys written before this store existed (rule 9). */
  private readonly wroteThisSession: (key: string) => boolean;
  /** Rule 9 per field: how a session value and the host's are combined for a key with a schema. */
  private readonly mergeSession: (key: string, session: string, host: string) => string;
  /**
   * What the host answered for each key during the hydrate.
   *
   * `adopt` has the answer in hand, but the end-of-hydrate rule 9 pass (`applySessionWins`) runs
   * after every read has come back and would otherwise have nothing to merge a late edit against.
   */
  private readonly hostAnswers = new Map<string, HostAnswer>();
  /**
   * The renderer's bridge queue when there is one (PLAN T6b.4 rule 8, as the glasses-ui skill has
   * it: every bridge call, storage included, one at a time on the link). What keeps that from
   * becoming the deadlock the 2026-09-10 fifth-round review measured is `callHost`: a call that
   * misses its deadline releases the queue as well as the caller — the skill's own `Promise.race`
   * cap — and its late answer is handled by `onLate`, never by the queue.
   */
  private enqueue: (<T>(call: () => Promise<T>) => Promise<T>) | null;
  /** The fallback queue for a store with no renderer (tests, a bridge-less page). */
  private storageChain: Promise<unknown> = Promise.resolve();
  /** Rule 13: told when a late read fills a key the hydrate had given up on. */
  private lateListener: ((key: string) => void) | null = null;
  /** Rule 14: the last value the host CONFIRMED holding, per key, in arrival order. */
  private readonly acked = new Map<string, string>();
  /** Rule 14: the last value the host refused, per key — a repair is not retried against it. */
  private readonly refused = new Map<string, string>();
  /** Rule 14: what the listener was last told per key, so it hears changes and not every write. */
  private readonly durableShown = new Map<string, boolean>();
  private durabilityListener: ((key: string, durable: boolean) => void) | null = null;
  /** Once the browser copy has failed, this store no longer claims the browser will keep anything. */
  private mirrorFailed = false;
  /** The newest value per key still waiting out the debounce, so five keystrokes are one write. */
  private readonly waiting = new Map<string, string>();
  private debounce: unknown = null;
  /**
   * The tail of the WRITES, which is what `persist()` answers from — not the queue.
   *
   * `storageChain` above is what keeps host calls from overlapping; this one keeps a batch's own
   * writes in the order their keys arrived and marks where that batch ends, so `lastBatch` resolves
   * when this batch's last write has answered rather than when some later batch has (rule 11).
   */
  private chain: Promise<unknown>;
  /** What the last batch dispatched did, per key (rule 11). What `persist()` answers with. */
  private lastBatch: Promise<WriteResults> = Promise.resolve(new Map<string, boolean>());
  /** The keys in that batch — what a bounded wait reports as not stored when the batch never answers. */
  private lastBatchKeys: readonly string[] = [];
  /** Resolves once the batch the debounce is holding has been written and acknowledged. */
  private settling: Promise<WriteResults> | null = null;
  private settle: ((results: WriteResults | PromiseLike<WriteResults>) => void) | null = null;

  constructor(
    bridge: StorageBridge | null,
    mirror: StorageLike = safeStorage(),
    deps: BridgeStoreDeps = {},
  ) {
    this.bridge = bridge;
    this.mirror = mirror;
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer =
      deps.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.debounceMs = deps.debounceMs ?? HOST_WRITE_DEBOUNCE_MS;
    this.callTimeoutMs = deps.callTimeoutMs ?? HOST_CALL_TIMEOUT_MS;
    this.hydrateTimeoutMs = deps.hydrateTimeoutMs ?? HYDRATE_TIMEOUT_MS;
    this.enqueue = deps.enqueue ?? null;
    this.wroteThisSession = deps.wroteThisSession ?? ((): boolean => false);
    // Whole-key by default, which is right for any value with no fields to merge.
    this.mergeSession = deps.mergeSession ?? ((_key, session): string => session);
    this.chain = Promise.resolve();
  }

  get durability(): Durability {
    if (this.bridge !== null) return 'bridge';
    return this.mirror === MEMORY_STORAGE || this.mirrorFailed ? 'none' : 'browser';
  }

  getItem(key: string): string | null {
    const held = this.values.get(key);
    if (held !== undefined) return held === '' ? null : held;
    // Only reachable for a key that was never hydrated or written, so the browser copy is the best
    // answer available rather than a second source of truth.
    return this.readMirror(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
    // Rule 9: this session has an opinion about this key now, and hydrate must not overrule it.
    this.dirty.add(key);
    this.writeMirror(key, value);
    this.schedule(key, value);
  }

  /** Rule 8: flush now and wait for the acks. What the settings page paints `Saved` from (rule 11). */
  persist(): Promise<WriteResults> {
    this.dispatch();
    return this.bounded(this.lastBatch, this.lastBatchKeys, this.callTimeoutMs);
  }

  /** Rule 8: the same answer, without cutting the debounce short. What a keystroke waits on. */
  settled(): Promise<WriteResults> {
    const keys = [...this.waiting.keys(), ...this.lastBatchKeys];
    return this.bounded(this.settling ?? this.lastBatch, keys, this.debounceMs + this.callTimeoutMs);
  }

  /**
   * A save's answer is bounded even when its write never gets ISSUED.
   *
   * `callHost`'s deadline starts when the queue issues the call. Since storage rides the renderer's
   * queue (rule 8), a write queued behind a render the glasses never answer is never issued, never
   * times out, and `persist()` would wait for good — the settings page stuck between `Save` and any
   * answer (2026-09-10 stop-gate review). So the WAIT is bounded here: past it the keys are reported
   * as not stored, which is the truthful answer about the next launch at that moment. The write is
   * still queued and still goes out if the link comes back; its ack simply has no one waiting.
   */
  private bounded(batch: Promise<WriteResults>, keys: readonly string[], ms: number): Promise<WriteResults> {
    return this.withTimeout(batch, ms, (): WriteResults => {
      console.error('QuotaLens: the Even App did not answer the save in time; reporting it as not stored');
      return new Map(keys.map((key) => [key, false] as const));
    });
  }

  /**
   * Fill the map before anything reads it — PLAN T6b.4 spec item 2 and rules 6/7/9.
   *
   * BOUNDED (rule 7), because the rest of the boot is behind it. Since rule 10 the first glasses
   * page is already up when this runs, so a host that accepted a read and never answered no longer
   * costs the glasses their page — it costs the boot the values it was going to apply and, since the
   * 2026-09-10 codex finding, the first poll, which `App.startPolling` only issues once this has
   * returned. On the deadline the remaining keys count as UNKNOWN and boot goes on.
   *
   * The keys are passed in rather than imported: `quotalens.payload` belongs to `poll.ts`, which
   * imports this file, and the contract has one owner per key.
   */
  async hydrate(keys: readonly string[]): Promise<void> {
    // A second hydrate asks the host again, so last time's answers must not be merged against.
    this.hostAnswers.clear();
    const bound = { expired: false };
    await this.withTimeout(this.hydrateKeys(keys, bound), this.hydrateTimeoutMs, () => {
      bound.expired = true;
      console.error('QuotaLens: the Even App did not answer in time; starting on the browser copy');
    });
  }

  private async hydrateKeys(keys: readonly string[], bound: { expired: boolean }): Promise<void> {
    for (const key of keys) {
      const answer = await this.readBridge(key);
      // Past the whole-hydrate deadline the boot has moved on with UNKNOWN keys. An answer arriving
      // now is the rule 13 case — the read was queued behind a slow first render and only issued
      // after the deadline — and it goes through `adoptLate`, which applies it only to a key that
      // is still UNKNOWN and untouched, then tells the boot. It is NOT dropped: dropping it cost a
      // whole session its durable settings (2026-09-10 codex review).
      if (bound.expired) {
        this.adoptLate(key, answer);
        continue;
      }
      this.hostAnswers.set(key, answer);
      this.adopt(key, answer);
    }
    // Unconditional, as before: a session value is OURS whenever it turns up (rule 9), and the merge
    // is idempotent — after the deadline this simply runs once the late reads are in.
    this.applySessionWins(keys);
  }

  /**
   * Rule 9 once more, over every key, after the last read has come back.
   *
   * `adopt` judges each key at the moment that key's own read answers, and the reads are sequential:
   * an edit that landed LATER in the hydrate — the owner is still typing while the second key is
   * being read — was never put to `wroteThisSession` again, so the host's older copy stayed in the
   * map (the 2026-09-10 codex review watched `http://old/…` survive a hydrate). A session value wins
   * whenever it appears, in whatever order, and goes to the host.
   *
   * Runs even when the hydrate ran out of time: a session value is OURS, so adopting it late is not
   * the late-host-value problem the deadline guards against — it is the correct value arriving.
   *
   * Rule 9's field granularity applies here too, and the merge is idempotent: the value `adopt` left
   * in the map already holds the session's fields, so merging it against the same host answer a
   * second time produces the same blob.
   */
  private applySessionWins(keys: readonly string[]): void {
    for (const key of keys) {
      const session = this.sessionValue(key);
      if (session === null) continue;
      this.takeSession(key, session, this.hostAnswers.get(key) ?? null);
    }
  }

  /**
   * Keep what this session owns of a key, fill the rest from the host, and push the result (rule 9).
   *
   * The merged blob goes to all three copies: the map (every synchronous read), the host (what makes
   * the next launch have it) and the browser mirror (what a launch that never reaches the bridge
   * hydrates from — leaving the pre-merge value there would bring the empty field back offline).
   */
  private takeSession(key: string, session: string, answer: HostAnswer): void {
    // Nothing to merge with: UNKNOWN (rule 6) or a host that explicitly holds nothing, so the
    // session's own value stands whole.
    const merged =
      answer === null || answer === '' ? session : this.mergeSession(key, session, answer);
    this.values.set(key, merged);
    // The merge is a decision of this session's, so the key is ours from here on — which is what
    // makes a second `sessionValue` read the merged blob rather than the pre-merge mirror copy.
    this.dirty.add(key);
    this.writeMirror(key, merged);
    this.schedule(key, merged);
  }

  /**
   * What THIS session put on this key, or `null` if the session has no opinion about it (rule 9).
   *
   * Two places to look, and WHO wrote it decides which one is right: a write through this store is
   * in the map (`dirty`), while a write made before the store was installed — the settings page is
   * mounted on browser storage on purpose, so the owner can paste a relay URL with the glasses still
   * disconnected — only ever reached the mirror. Reading the map for that second case is what made
   * the bug: by then the map can already hold the value hydrate adopted from the host.
   */
  private sessionValue(key: string): string | null {
    if (this.dirty.has(key)) return this.values.get(key) ?? null;
    if (this.wroteThisSession(key)) return this.readMirror(key);
    return null;
  }

  /**
   * One key's precedence, in the order PLAN T6b.4 spec item 2 and rules 6/9 put it:
   *
   *   1. this session already wrote it → keep the FIELDS it wrote, take the rest from the host, and
   *      push the result to the host (rule 9; `takeSession`);
   *   2. the read failed, timed out, or there is no bridge → UNKNOWN: run on the mirror for this
   *      session and write NOTHING back, because the host's copy may be the newer one (rule 6);
   *   3. the host holds a value → adopt it and bring the browser copy into line;
   *   4. the host explicitly holds nothing and the browser does → migrate it once (the sideload
   *      user whose settings only ever reached browser storage);
   *   5. both empty → nothing, which `loadSettings` reads as the defaults.
   */
  private adopt(key: string, answer: HostAnswer): void {
    // `''` is a deliberate delete and wins like any other session value. `null` is the one case with
    // nothing to prefer — no session opinion, or a mirror that failed to read — so the ordinary
    // precedence applies.
    const session = this.sessionValue(key);
    if (session !== null) {
      this.takeSession(key, session, answer);
      return;
    }
    if (answer === null) return;
    if (answer !== '') {
      this.values.set(key, answer);
      this.writeMirror(key, answer);
      return;
    }
    const mirrored = this.readMirror(key);
    if (mirrored === null || mirrored === '') return;
    this.values.set(key, mirrored);
    this.schedule(key, mirrored);
  }

  /**
   * Hold a host write behind the trailing debounce (rule 8).
   *
   * Typing a relay URL is one `input` event per character, and each one used to be its own round
   * trip to the host — thirty-odd serialised calls, each one three seconds of patience if the host
   * stops answering. Only the newest value per key survives the wait, which is the one the owner
   * meant, and rule 8 keeps the keystrokes themselves on memory and the browser mirror.
   */
  private schedule(key: string, value: string): void {
    this.waiting.set(key, value);
    if (this.settling === null) {
      this.settling = new Promise<WriteResults>((resolve) => void (this.settle = resolve));
    }
    if (this.debounce !== null) this.clearTimer(this.debounce);
    this.debounce = this.setTimer(() => {
      this.debounce = null;
      this.dispatch();
    }, this.debounceMs);
  }

  /**
   * Issue whatever the debounce is holding, newest value per key, in the order the keys arrived.
   *
   * Rule 11: each write records its OWN answer in the batch's map. The old shape kept the tail of
   * the chain — one boolean, the LAST write's — and `commitSettings` read it as the settings key's
   * ack, so a refused save followed by an accepted payload cache painted `Saved`.
   */
  private dispatch(): void {
    if (this.debounce !== null) {
      this.clearTimer(this.debounce);
      this.debounce = null;
    }
    if (this.waiting.size === 0) return;
    const batch = [...this.waiting];
    this.waiting.clear();
    const results = new Map<string, boolean>();
    for (const [key, value] of batch) {
      const write = async (): Promise<void> => void results.set(key, await this.writeBridge(key, value));
      // Both arms: one refused write must not poison every write after it.
      this.chain = this.chain.then(write, write);
    }
    // The chain AS IT IS NOW — a later batch appends to `this.chain`, so this resolves when this
    // batch's own last write has answered, and the map is complete by then.
    const done = this.chain.then((): WriteResults => results);
    this.lastBatch = done;
    this.lastBatchKeys = batch.map(([key]) => key);
    const settle = this.settle;
    this.settling = null;
    this.settle = null;
    settle?.(done);
  }

  private writeBridge(key: string, value: string): Promise<boolean> {
    const bridge = this.bridge;
    if (bridge === null) return Promise.resolve(false);
    return this.callHost(
      async () => {
        const stored = await bridge.setLocalStorage(key, value);
        // Rule 11: a host that simply answers `false` used to be silent — the batch's aggregate hid
        // it. The NAME, as with every other failure here, never the value.
        if (!stored) console.error(`QuotaLens: the Even App refused to store ${key}`);
        // Rule 14: whatever the host said, on time or late, is now what it HOLDS (or refused), and
        // that is compared against what this store holds — in one place, for every write.
        if (stored) this.acked.set(key, value);
        else this.refused.set(key, value);
        this.reconcile(key);
        return stored;
      },
      () => {
        console.error(`QuotaLens: the Even App did not answer a write to ${key} in time`);
        return false;
      },
      // The NAME only, and never `value`: a host error is free to quote what it was handed, and a
      // log line is not the place for a settings blob. The key name is safe.
      (error) => {
        console.error(`QuotaLens: the Even App rejected a write to ${key} (${nameOf(error)})`);
        return false;
      },
      // PLAN T6b.4 rule 12: a write that answers AFTER its deadline may have landed on the host
      // after a newer write of the same key went out and was acknowledged — the host would then hold
      // the OLD value under a `Saved` for the new one (2026-09-10 codex review, `durable A, ui B`).
      // The bookkeeping above has already run for it; `reconcile` is what issues the repair.
      (late) => {
        console.error(`QuotaLens: a write to ${key} answered after its deadline (${late ? 'stored' : 'refused'})`);
      },
    );
  }

  /**
   * PLAN T6b.4 rule 14: keep writing until the host holds what this store holds, or refuses it.
   *
   * `acked` is the last value the host confirmed, in the order the confirmations ARRIVED — a
   * timed-out write that lands late is a confirmation too, and it can arrive after a newer one
   * (rule 12). Whenever they disagree with the current value, one more write of the current value
   * goes out; the loop ends when the host confirms the current value or has refused exactly it
   * (a refusal of an older value says nothing about this one). A write that times out and is never
   * heard from again ends nothing — there is no answer to reconcile — which is why the listener
   * exists: the page is told the durable copy is not the one on screen and takes `Saved` down, and
   * told again when it is (2026-09-10 codex review: a refused repair behind a standing `Saved`).
   */
  private reconcile(key: string): void {
    const current = this.values.get(key);
    if (current === undefined) return;
    const durable = this.acked.get(key) === current;
    if (!durable && this.refused.get(key) !== current) this.schedule(key, current);
    if (this.durableShown.get(key) !== durable) {
      this.durableShown.set(key, durable);
      this.durabilityListener?.(key, durable);
    }
  }

  /** Rule 14: who to tell when a key's durable copy stops, or starts, matching the current value. */
  onDurability(listener: (key: string, durable: boolean) => void): void {
    this.durabilityListener = listener;
  }

  /**
   * Attach the renderer's queue to a store built before the renderer existed (rule 8).
   *
   * `qa-live.ts` installs and hydrates the store before it imports `main.ts`, so the store exists —
   * and has already made host calls on its fallback chain — when `main.ts` builds the renderer.
   * Without this, `installStore`'s idempotent path returned that store with the queue `main.ts`
   * supplied ignored, and the harness ran storage and renders on two queues (2026-09-10 codex
   * review). Calls already queued on the fallback chain finish there; every call from here on rides
   * the renderer's.
   */
  useQueue(enqueue: <T>(call: () => Promise<T>) => Promise<T>): void {
    this.enqueue = enqueue;
  }

  private readBridge(key: string): Promise<HostAnswer> {
    const bridge = this.bridge;
    // No bridge is UNKNOWN too, not an empty host: there is nothing to migrate TO, and answering
    // `''` here would have the mirror queued for a write that can only fail (rule 6).
    if (bridge === null) return Promise.resolve(null);
    return this.callHost<HostAnswer>(
      () => bridge.getLocalStorage(key),
      () => {
        console.error(`QuotaLens: the Even App did not answer a read of ${key} in time`);
        return null;
      },
      (error) => {
        console.error(`QuotaLens: the Even App could not be read for ${key} (${nameOf(error)})`);
        return null;
      },
      (answer) => this.adoptLate(key, answer),
    );
  }

  /**
   * A read that answers after its deadline (PLAN T6b.4 rule 13).
   *
   * Since storage rides the renderer's queue (rule 8), a first render that is merely SLOW — longer
   * than the hydrate's own bound — means the read is not even issued until after the hydrate has
   * returned UNKNOWN. Dropping that answer threw away durable settings for the whole session and
   * left the poller on an empty relay URL (2026-09-10 codex review). It is safe to apply exactly
   * when the key is still UNKNOWN and this session has not written it: then it is the host's truth
   * and nothing newer exists. `adopt` already encodes that precedence (rule 6/9), and the listener
   * lets the boot re-apply the value — page, glasses, first poll — as if the hydrate had answered.
   */
  private adoptLate(key: string, answer: HostAnswer): void {
    if (answer === null || this.values.has(key)) return;
    this.hostAnswers.set(key, answer);
    this.adopt(key, answer);
    if (this.values.has(key)) this.lateListener?.(key);
  }

  /** Rule 13: who to tell when a key is filled by a read that answered after the hydrate gave up. */
  onLateHydrate(listener: (key: string) => void): void {
    this.lateListener = listener;
  }

  /**
   * One host call, on THE bridge queue and bounded (PLAN T6b.4 rules 7, 8 and 12).
   *
   * Both halves of the glasses-ui skill's rule at once: the call waits its turn on the same queue as
   * every render ("serialize all bridge calls, not just images"), and it is capped ("wrap calls in
   * `Promise.race` with a few-second cap"). The cap does two things: it answers the CALLER (hydrate
   * goes on with UNKNOWN, `persist()` answers `false`) **and** it advances the QUEUE — a storage call
   * the host accepted and never answers must not hold every redraw, exit call and input
   * acknowledgement behind it for good (§6 rule 5; the 2026-09-10 fifth-round review measured
   * exactly that, 31 mount timeouts and still retrying). That is the one moment two bridge calls can
   * be outstanding, and it is the moment the skill itself prescribes.
   *
   * A late answer is not silently dropped: `onLate` gets it. For a read there is nothing to do — the
   * key stayed UNKNOWN, and a stale host copy must not come back over what was written meanwhile
   * (rule 6) — but a late WRITE may have landed on the host after a newer write of the same key was
   * acknowledged, so `writeBridge` re-issues the current value (rule 12).
   *
   * The deadline starts when the queue ISSUES the call, not when it is requested: each call gets its
   * whole `callTimeoutMs` with the host, and the wait is still bounded because every entry in front
   * of it leaves within its own deadline (the hydrate has rule 7's overall bound on top).
   */
  private callHost<T>(
    call: () => Promise<T>,
    onTimeout: () => T,
    onError: (error: unknown) => T,
    onLate: (answer: T) => void = () => undefined,
  ): Promise<T> {
    let release: (value: T) => void = () => undefined;
    const caller = new Promise<T>((resolve) => void (release = resolve));
    // Cannot reject: everything `call` can throw is turned into an answer, and the job itself only
    // ever resolves — a rejecting tail would stop the queue as surely as a stalled call.
    this.queueStorage(
      () =>
        new Promise<void>((advance) => {
          let timedOut = false;
          const deadline = this.setTimer(() => {
            timedOut = true;
            release(onTimeout());
            advance();
          }, this.callTimeoutMs);
          const settle = (answer: T): void => {
            this.clearTimer(deadline);
            if (timedOut) {
              onLate(answer);
              return;
            }
            release(answer);
            advance();
          };
          call().then(settle, (error: unknown) => settle(onError(error)));
        }),
    );
    return caller;
  }

  /**
   * Append one job to the bridge queue (rule 8): the renderer's when this store has one, its own
   * otherwise. Never rejects, so the tail is always runnable.
   */
  private queueStorage(job: () => Promise<void>): void {
    if (this.enqueue !== null) {
      void this.enqueue(job).catch(() => undefined);
      return;
    }
    this.storageChain = this.storageChain.then(job, job);
  }

  /**
   * Resolve to `onTimeout()` if `work` has not settled within `ms` (PLAN T6b.4 rule 7).
   *
   * The whole-hydrate bound, and the reason it exists rather than trusting the per-call ones: the
   * keys are read one after another, so N keys are N deadlines end to end. The boot awaits the
   * hydrate before applying anything and before the first poll goes out, so an unbounded one is a
   * launch that never fetches (and, before rule 10 moved the first page in front of it, a blank pair
   * of glasses — §6 rule 5).
   */
  private withTimeout<T>(work: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = this.setTimer(() => resolve(onTimeout()), ms);
      work.then(
        (value) => {
          this.clearTimer(handle);
          resolve(value);
        },
        (error: unknown) => {
          this.clearTimer(handle);
          reject(error instanceof Error ? error : new Error(nameOf(error)));
        },
      );
    });
  }

  private readMirror(key: string): string | null {
    try {
      return this.mirror.getItem(key);
    } catch (error) {
      this.noteMirrorFailure(`read for ${key}`, error);
      return null;
    }
  }

  private writeMirror(key: string, value: string): void {
    try {
      this.mirror.setItem(key, value);
    } catch (error) {
      this.noteMirrorFailure(`copy of ${key}`, error);
    }
  }

  /** Logged once. A blocked WebView fails on every access, and the poller reads on every tick. */
  private noteMirrorFailure(what: string, error: unknown): void {
    if (this.mirrorFailed) return;
    this.mirrorFailed = true;
    console.error(`QuotaLens: the browser ${what} failed (${nameOf(error)}); the Even App is the only copy`);
  }
}

/**
 * The store every unqualified read and write resolves to.
 *
 * `null` until `installBridgeStore` swaps in the host-backed one, because the settings page is
 * mounted before `waitForEvenAppBridge()` resolves and has to work meanwhile (T6b.4 boot order).
 */
let installed: StorageLike | null = null;

export function activeStorage(): StorageLike {
  return installed ?? safeStorage();
}

/** Swap the shared store. `null` puts it back to plain browser storage (and resets a test). */
export function useStorage(storage: StorageLike | null): void {
  installed = storage;
}

/**
 * Build the host-backed store and make it the shared one, WITHOUT hydrating it.
 *
 * What `main.ts` uses, because PLAN T6b.4 rule 10 puts the first glasses page in front of the
 * hydrate: until the host answers, every read here falls through to the browser mirror, which is the
 * cache the first page is drawn from. `store.hydrate()` then runs on the store's own queue (rule 8),
 * alongside that page rather than in front of it.
 *
 * Idempotent for `qa-live.ts`, which installs and hydrates the store itself before it imports
 * `main.ts` (spec item 5) — a second store would lose the relay URL it seeded.
 */
export function installStore(
  bridge: StorageBridge | null,
  mirror: StorageLike = safeStorage(),
  deps: BridgeStoreDeps = {},
): BridgeStore {
  if (installed instanceof BridgeStore) {
    // The one dep a second caller can still contribute: the renderer's queue, which did not exist
    // when `qa-live.ts` installed the store (rule 8; `BridgeStore.useQueue`).
    if (deps.enqueue !== undefined) installed.useQueue(deps.enqueue);
    return installed;
  }
  const store = new BridgeStore(bridge, mirror, deps);
  useStorage(store);
  return store;
}

/**
 * Install as above and hydrate before returning.
 *
 * For callers with nothing on the glasses to protect: `qa-live.ts` (which must have the store filled
 * before it seeds a relay URL into it) and the tests. `main.ts` deliberately does NOT use this — rule
 * 10: a host read that never answers would hold the whole boot, and the first page with it.
 */
export async function installBridgeStore(
  bridge: StorageBridge | null,
  keys: readonly string[],
  mirror: StorageLike = safeStorage(),
  deps: BridgeStoreDeps = {},
): Promise<BridgeStore> {
  // An already-installed store is returned as it is, never hydrated a second time: `qa-live.ts`
  // seeds into it between the two calls, and rule 9 only protects keys the session wrote.
  if (installed instanceof BridgeStore) return installed;
  const store = installStore(bridge, mirror, deps);
  await store.hydrate(keys);
  return store;
}

/** Where a write to this store lands. A plain browser `Storage` keeps things; the fallback does not. */
function durabilityOf(storage: StorageLike): Durability {
  if (isPersistent(storage)) return storage.durability;
  return storage === MEMORY_STORAGE ? 'none' : 'browser';
}

/**
 * Dispatch whatever a store is holding behind its debounce, NOW (PLAN T6b.4 rules 4 and 8).
 *
 * `FOREGROUND_EXIT` is the one moment where the 500 ms trailing debounce is wrong: the WebView can
 * be suspended before the timer fires, and the write it was holding never leaves — the 2026-09-10
 * codex review measured zero host writes after `Poller.flush()`, which is the payload cache silently
 * not surviving the app being closed (PLAN M6 D12 again). A plain `Storage` needs nothing: a
 * `setItem` there has already landed.
 *
 * Never rejects, and its callers do not await it: an exit path cannot wait for the host, it can only
 * make sure the call has gone out before the WebView goes quiet.
 */
export function flushStorage(storage: StorageLike): Promise<WriteResults> {
  const nothing: WriteResults = new Map<string, boolean>();
  if (!isPersistent(storage)) return Promise.resolve(nothing);
  return storage.persist().then(
    (results) => results,
    () => nothing,
  );
}

/**
 * Both directions are guarded, and neither ever logs the exception.
 *
 * A `SyntaxError` from `JSON.parse` quotes the beginning of its input, so a corrupt blob would put
 * whatever it starts with in the log. Only the error's NAME (a class name, never input) goes to the
 * log alongside a fixed sentence — the same habit every other failure log in this file keeps.
 */
export function loadSettings(storage?: StorageLike): StoredSettings {
  try {
    const stored = (storage ?? activeStorage()).getItem(SETTINGS_KEY);
    if (stored === null) return { ...DEFAULT_STORED };
    return parseSettings(JSON.parse(stored));
  } catch (error) {
    console.error(`QuotaLens: settings could not be read (${nameOf(error)}); using defaults`);
    return { ...DEFAULT_STORED };
  }
}

/**
 * The synchronous half: the value is live for this session the moment this returns.
 *
 * `false` = **nowhere durable**, which the page shows as "Not saved" rather than "Saved". The memory
 * fallback counts as not persisted, and that distinction is the whole point of the return value: the
 * settings are readable back, but `Saved` is a promise about the NEXT launch, and in a WebView with
 * site data blocked that promise is false. Silently losing a relay URL the owner believes they saved
 * is worse than telling them the browser will not keep it.
 *
 * `true` over a `BridgeStore` means the write is queued for the Even App, not yet acknowledged by
 * it — `commitSettings` is the one that waits for the answer, and the notice row uses that.
 */
export function saveSettings(settings: StoredSettings, storage?: StorageLike): boolean {
  try {
    const resolved = storage ?? activeStorage();
    resolved.setItem(SETTINGS_KEY, JSON.stringify(parseSettings(settings)));
    return durabilityOf(resolved) !== 'none';
  } catch (error) {
    console.error(`QuotaLens: settings could not be saved (${nameOf(error)})`);
    return false;
  }
}

/** What the §7 V8 notice row is allowed to promise. Each maps to one sentence in `settings-page.ts`. */
export type SaveOutcome =
  /** The Even App acknowledged it: the next launch of the packaged app will have it. */
  | 'persisted'
  /** No bridge yet (the glasses are not connected). Live now, kept only by the browser. */
  | 'browserOnly'
  /** The Even App answered `false` or threw. */
  | 'refused'
  /** No bridge and no browser storage either — live for this session and gone after it. */
  | 'blocked';

/** How soon the host write behind a commit is allowed to leave (PLAN T6b.4 rule 8). */
export interface CommitOptions {
  /**
   * `true` (the default) issues the host write at once — a discrete press, or a harness seeding a
   * value, is a save and wants its answer now. `false` lets the 500 ms trailing debounce dispatch
   * it, which is what a keystroke does: rule 8 keeps typing on memory and the browser mirror only.
   */
  flush?: boolean;
}

/**
 * PLAN T6b.4 spec item 3: save, then answer the question the notice row actually asks — will the
 * next launch have this? Over a host-backed store that answer only exists after the host replies,
 * so this is the async half of `saveSettings` and the only thing the settings page paints from.
 *
 * Rule 11: the answer is `SETTINGS_KEY`'s own ack. The batch it rode in can carry the payload cache
 * too, and asking whether "the batch" succeeded reported a refused relay URL as `Saved`.
 */
export async function commitSettings(
  settings: StoredSettings,
  storage?: StorageLike,
  options: CommitOptions = {},
): Promise<SaveOutcome> {
  const resolved = storage ?? activeStorage();
  const written = saveSettings(settings, resolved);
  if (isPersistent(resolved) && resolved.durability === 'bridge') {
    const acked = options.flush === false ? resolved.settled() : resolved.persist();
    return storedKey(await acked, SETTINGS_KEY) ? 'persisted' : 'refused';
  }
  return written ? 'browserOnly' : 'blocked';
}

/** A class name — `SyntaxError`, `QuotaExceededError` — which cannot contain any of the input. */
export function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
