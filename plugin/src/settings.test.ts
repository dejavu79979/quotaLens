import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  activeStorage,
  BridgeStore,
  commitSettings,
  DEFAULT_STORED,
  installBridgeStore,
  installStore,
  loadSettings,
  mergeSettings,
  mergeSettingsBlobs,
  normalizeRelayBase,
  parseSettings,
  saveSettings,
  SETTINGS_KEY,
  storedKey,
  useStorage,
  type StorageBridge,
  type StoredSettings,
} from './settings.ts';

/** Rule 11: `persist()` answers per key, so a test asks about the key it actually wrote. */
async function ackOf(store: BridgeStore, key: string = SETTINGS_KEY): Promise<boolean> {
  return storedKey(await store.persist(), key);
}

/** The two methods `loadSettings`/`saveSettings` actually use, with a switch for the throwing case. */
function fakeStorage(initial: string | null = null) {
  const store = { value: initial, throws: false };
  return {
    store,
    getItem: (key: string) => {
      if (store.throws) throw new Error('site data is blocked');
      return key === SETTINGS_KEY ? store.value : null;
    },
    setItem: (key: string, value: string) => {
      if (store.throws) throw new Error('site data is blocked');
      if (key === SETTINGS_KEY) store.value = value;
    },
  };
}

test('a round trip keeps every field', () => {
  const storage = fakeStorage();
  const settings = { relayUrl: 'http://127.0.0.1:8787', pollIntervalMin: 10 };
  assert.equal(saveSettings(settings, storage), true);
  assert.deepEqual(loadSettings(storage), settings);
});

test('M9 — whatever the owner types for the relay address is normalised to the daemon origin', () => {
  for (const [typed, expected] of [
    ['100.64.0.9', 'http://100.64.0.9:8787'],
    ['  100.64.0.9  ', 'http://100.64.0.9:8787'],
    ['100.64.0.9:8787', 'http://100.64.0.9:8787'],
    ['http://100.64.0.9', 'http://100.64.0.9:8787'],
    ['http://100.64.0.9:8787', 'http://100.64.0.9:8787'],
    ['http://100.64.0.9:8787/', 'http://100.64.0.9:8787'],
    ['http://100.64.0.9:8787/usage.json', 'http://100.64.0.9:8787'],
    // A pre-M9 stored value migrates on load, without a re-paste.
    ['http://100.64.0.9:8787/u/OLDSECRET/usage.json?refresh=1#x', 'http://100.64.0.9:8787'],
    ['https://desk.tail1234.ts.net', 'https://desk.tail1234.ts.net:8787'],
    ['https://desk.tail1234.ts.net:9000/x', 'https://desk.tail1234.ts.net:9000'],
    ['HTTP://100.64.0.9:8787', 'http://100.64.0.9:8787'],
    ['', ''],
    ['   ', ''],
    // Unparseable or the wrong scheme: kept as typed (trimmed) so the field shows the mistake.
    ['not a url', 'not a url'],
    ['ftp://100.64.0.9:8787', 'ftp://100.64.0.9:8787'],
  ] as const) {
    assert.equal(normalizeRelayBase(typed), expected, JSON.stringify(typed));
  }
  // …and `parseSettings` applies it, which is what `loadSettings` and every save go through.
  assert.equal(parseSettings({ relayUrl: '100.64.0.9', pollIntervalMin: 5 }).relayUrl, 'http://100.64.0.9:8787');
});

test('nothing stored yet is the defaults, not an error', () => {
  assert.deepEqual(loadSettings(fakeStorage()), DEFAULT_STORED);
});

test('one bad field costs its own default, not the whole record', () => {
  // Losing a configured relay URL because the interval was malformed reads as "the app forgot my
  // settings" — the one thing T3.5's acceptance says must survive a restart.
  const parsed = parseSettings({ relayUrl: 'http://host:8787', pollIntervalMin: 7 });
  assert.equal(parsed.relayUrl, 'http://host:8787');
  assert.equal(parsed.pollIntervalMin, DEFAULT_STORED.pollIntervalMin, 'an interval off the menu');
  // …and the other way round: a bad URL does not cost a good interval.
  assert.deepEqual(parseSettings({ relayUrl: 42, pollIntervalMin: 10 }), {
    relayUrl: DEFAULT_STORED.relayUrl,
    pollIntervalMin: 10,
  });
});

test('T6b.4 rule 9 — mergeSettings takes the edited fields from the session and the rest from the host', () => {
  // Rule 9 at FIELD granularity, which is what the 2026-09-10 codex review found missing. The
  // whole-key version wiped a configured relay URL: the owner toggles the poll interval while the
  // hydrate is still running, so the page's blob still carries an empty `relayUrl` — nothing had
  // answered yet — and that blob went over the host's copy as one unit.
  const host = { relayUrl: 'http://host:8787', pollIntervalMin: 10 };
  const session = { relayUrl: '', pollIntervalMin: 3 };
  assert.deepEqual(mergeSettings(session, host, ['pollIntervalMin']), {
    relayUrl: host.relayUrl,
    pollIntervalMin: 3,
  });
  // …and the direction rule 9 was originally written for: the pasted URL wins, the interval does not.
  assert.deepEqual(mergeSettings(session, host, ['relayUrl']), { relayUrl: '', pollIntervalMin: 10 });
  assert.deepEqual(mergeSettings(session, host, []), host, 'an untouched key belongs to the host');
  assert.deepEqual(
    mergeSettings(session, host, ['relayUrl', 'pollIntervalMin']),
    session,
    'a session that edited every field owns every field',
  );
});

test('T6b.4 rule 9 — the blob merge validates both sides and keeps the session when the host is junk', () => {
  const held = JSON.stringify({ relayUrl: 'http://host:8787', pollIntervalMin: 10 });
  const session = JSON.stringify({ relayUrl: '', pollIntervalMin: 3 });
  assert.deepEqual(JSON.parse(mergeSettingsBlobs(session, held, ['pollIntervalMin'])), {
    relayUrl: 'http://host:8787',
    pollIntervalMin: 3,
  });
  // Nothing to take fields FROM: the session's own blob stands, which is the pre-fix behaviour and
  // the only answer that leaves the app on a value someone actually chose.
  assert.equal(mergeSettingsBlobs(session, 'not json at all', ['pollIntervalMin']), session);
  assert.equal(mergeSettingsBlobs(session, '"a string"', ['pollIntervalMin']), session);
});

test('T6b.2 — an old blob that still carries warnAt loads fine and simply drops it', () => {
  // The 2026-09-10 owner ruling withdrew §7 V3 entirely, so `warnAt` is no longer part of the
  // contract. A phone that saved one before the upgrade must still load: the field is ignored, the
  // two surviving fields are kept, and the next save does not write it back.
  const relayUrl = 'http://127.0.0.1:8787';
  const storage = fakeStorage(JSON.stringify({ relayUrl, pollIntervalMin: 10, warnAt: 80 }));
  const loaded = loadSettings(storage);
  assert.deepEqual(loaded, { relayUrl, pollIntervalMin: 10 });
  assert.deepEqual(Object.keys(loaded).sort(), ['pollIntervalMin', 'relayUrl'], 'a withdrawn field survived');
  assert.equal(saveSettings(loaded, storage), true);
  assert.ok(!(storage.store.value as string).includes('warnAt'), `the save resurrected it: ${storage.store.value}`);
});

test('unreadable storage starts the app on defaults instead of not starting it', () => {
  const storage = fakeStorage();
  storage.store.throws = true;
  assert.deepEqual(loadSettings(storage), DEFAULT_STORED);
  assert.equal(saveSettings(DEFAULT_STORED, storage), false, 'a failed save must be reported');
});

test('corrupt JSON is defaults, not a crash', () => {
  assert.deepEqual(loadSettings(fakeStorage('{not json')), DEFAULT_STORED);
});

// ---- the two boundaries a WebView actually has ------------------------------

/** Replace the `localStorage` global with one whose GETTER throws, as blocked site data does. */
function withBlockedStorage<T>(body: () => T): T {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: The operation is insecure.');
    },
  });
  try {
    return body();
  } finally {
    if (had === undefined) delete (globalThis as { localStorage?: unknown }).localStorage;
    else Object.defineProperty(globalThis, 'localStorage', had);
  }
}

function captureErrors<T>(body: () => T): { result: T; logged: string } {
  const real = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  try {
    return { result: body(), logged: lines.join('\n') };
  } finally {
    console.error = real;
  }
}

test('a WebView that blocks site data still starts the app', () => {
  // Reading the property throws — outside any `try` in the function body when it is a default
  // parameter value — so this used to escape `loadSettings` and kill `main.ts` before
  // `app.start()`: no page on the glasses at all, the worst shape of a §6 rule 5 violation.
  const { result } = captureErrors(() => withBlockedStorage(() => loadSettings()));
  assert.deepEqual(result, DEFAULT_STORED);
  // …and the app keeps working for this session — the value is readable back — while `saveSettings`
  // reports `false`, because it did not persist. Both halves matter: the app must not die, and the
  // page must not print `Saved` over something the next launch will not have.
  captureErrors(() =>
    withBlockedStorage(() => {
      assert.equal(saveSettings({ ...DEFAULT_STORED, pollIntervalMin: 10 }), false, 'reported as persisted');
      assert.equal(loadSettings().pollIntervalMin, 10, 'the in-memory fallback did not hold the value');
    }),
  );
});

test('a corrupt settings blob is logged by error NAME only, never by its content', () => {
  // `JSON.parse` quotes the start of its input; the log gets the class name and a fixed sentence.
  const corrupt = 'BLOB-CONTENT-not-json';
  const { result, logged } = captureErrors(() =>
    loadSettings({ getItem: () => corrupt, setItem: () => undefined }),
  );
  assert.deepEqual(result, DEFAULT_STORED);
  assert.ok(!logged.includes('BLOB-CONTENT'), `the log quoted the blob: ${logged}`);
  assert.ok(logged.includes('SyntaxError'), 'the log should still name the failure');
});

test('the memory fallback reports NOT saved, so the page cannot promise a restart', () => {
  // The value is live for this session, but `Saved` is a promise about the next launch — and in a
  // WebView with site data blocked that promise is false. Reporting `true` here meant the owner
  // saw `Saved`, restarted, and found the relay URL gone.
  captureErrors(() =>
    withBlockedStorage(() => {
      assert.equal(saveSettings({ ...DEFAULT_STORED, relayUrl: 'http://h:8787' }), false);
    }),
  );
});

// ---- T6b.4: the Even App is the only storage that survives an app restart ---------------------
//
// The packaged app (installed from the dev portal) came back with an empty relay URL every time the
// owner reopened it (2026-09-10, PLAN M6 D12). Browser `localStorage` in the Even App's Flutter
// WebView is not guaranteed across app restarts — the official `device-features` skill says the SDK
// store is "the only reliable persistence" — so the store below writes through to the host.

const RELAY = 'http://127.0.0.1:8787';
const OTHER_KEY = 'quotalens.payload';

/** A whole key/value store, unlike `fakeStorage` above, because the bridge store mirrors two keys. */
function fakeBrowserStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const control = { throws: false };
  return {
    map,
    control,
    getItem: (key: string) => {
      if (control.throws) throw new Error('site data is blocked');
      return map.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (control.throws) throw new Error('site data is blocked');
      map.set(key, value);
    },
  };
}

/** The two host methods, recording every write so the test can prove the write-through happened. */
function fakeBridge(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const writes: Array<{ key: string; value: string }> = [];
  // `refuse` is per KEY, because rule 11 is about a batch where the keys disagree: `accept: false`
  // could only ever produce a batch that failed as a whole, which is the one case the old aggregate
  // answered correctly.
  const control = { accept: true, throws: false, readThrows: false, refuse: new Set<string>() };
  const bridge: StorageBridge = {
    setLocalStorage: async (key, value) => {
      if (control.throws) throw new Error('the host went away');
      writes.push({ key, value });
      if (!control.accept || control.refuse.has(key)) return false;
      values.set(key, value);
      return true;
    },
    getLocalStorage: async (key) => {
      if (control.readThrows) throw new Error('the host went away');
      return values.get(key) ?? '';
    },
  };
  return { bridge, values, writes, control };
}

/** Injected timers, same shape as `poll.test.ts`, so no test in this file ever sleeps for real. */
class FakeTimers {
  private nextId = 1;
  readonly pending = new Map<number, () => void>();

  set = (fn: () => void, _ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.set(id, fn);
    return id;
  };

  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** Every timer outstanding right now, in the order it was set. Ones set by these do not fire. */
  fireAll(): void {
    const due = [...this.pending.entries()];
    for (const [id, fn] of due) {
      this.pending.delete(id);
      fn();
    }
  }
}

/** Let the microtask and macrotask queues drain, so a dispatched host call has actually been made. */
const tick = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 0));

/**
 * Fire fake timers until none are left. Hydrate sets one timer per key as it goes, so a single
 * `fireAll()` only gets the app as far as the first key.
 */
async function drainTimers(timers: FakeTimers, rounds = 10): Promise<void> {
  for (let round = 0; round < rounds && timers.pending.size > 0; round += 1) {
    timers.fireAll();
    await tick();
  }
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

test('T6b.4 hydrate — a value in the Even App wins over a stale browser copy', async () => {
  const host = fakeBridge({ [SETTINGS_KEY]: JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 10 }) });
  const mirror = fakeBrowserStorage({
    [SETTINGS_KEY]: JSON.stringify({ relayUrl: 'http://stale:8787', pollIntervalMin: 3 }),
  });
  const store = new BridgeStore(host.bridge, mirror);
  await store.hydrate([SETTINGS_KEY, OTHER_KEY]);

  assert.deepEqual(loadSettings(store), { relayUrl: RELAY, pollIntervalMin: 10 });
  // …and the browser copy is brought into line, so a later read that misses the map agrees.
  assert.deepEqual(JSON.parse(mirror.map.get(SETTINGS_KEY) as string), {
    relayUrl: RELAY,
    pollIntervalMin: 10,
  });
  assert.deepEqual(host.writes, [], 'hydrating a value the host already has must not write it back');
});

test('T6b.4 hydrate — a sideload user’s browser value is migrated to the Even App once', async () => {
  const host = fakeBridge();
  const stored = JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 3 });
  const mirror = fakeBrowserStorage({ [SETTINGS_KEY]: stored, [OTHER_KEY]: '{"version":1}' });
  const store = new BridgeStore(host.bridge, mirror);
  await store.hydrate([SETTINGS_KEY, OTHER_KEY]);
  await store.persist();

  assert.deepEqual(loadSettings(store), { relayUrl: RELAY, pollIntervalMin: 3 });
  assert.equal(host.values.get(SETTINGS_KEY), stored, 'the settings were not migrated to the host');
  assert.equal(host.values.get(OTHER_KEY), '{"version":1}', 'the payload cache was not migrated');
  assert.deepEqual(
    host.writes.map((write) => write.key),
    [SETTINGS_KEY, OTHER_KEY],
    'the migration is one write per key, in key order',
  );
});

test('T6b.4 hydrate — both sides empty is the defaults, not an error', async () => {
  const host = fakeBridge();
  const mirror = fakeBrowserStorage();
  const store = new BridgeStore(host.bridge, mirror);
  await store.hydrate([SETTINGS_KEY, OTHER_KEY]);

  assert.deepEqual(loadSettings(store), DEFAULT_STORED);
  assert.equal(store.getItem(OTHER_KEY), null, 'an absent key must read as absent, not as ""');
  assert.deepEqual(host.writes, [], 'nothing to migrate means nothing written');
});

test('T6b.4 every write goes through to the Even App and is mirrored to the browser', async () => {
  const host = fakeBridge();
  const mirror = fakeBrowserStorage();
  const store = new BridgeStore(host.bridge, mirror);
  await store.hydrate([SETTINGS_KEY]);

  assert.equal(await commitSettings({ relayUrl: RELAY, pollIntervalMin: 10 }, store), 'persisted');
  assert.deepEqual(host.writes.map((write) => write.key), [SETTINGS_KEY]);
  assert.deepEqual(JSON.parse(host.values.get(SETTINGS_KEY) as string), {
    relayUrl: RELAY,
    pollIntervalMin: 10,
  });
  assert.deepEqual(JSON.parse(mirror.map.get(SETTINGS_KEY) as string), {
    relayUrl: RELAY,
    pollIntervalMin: 10,
  });
  // The synchronous read is answered from memory, so the poller sees the new URL on its next tick
  // without waiting for the host to acknowledge anything.
  assert.deepEqual(loadSettings(store), { relayUrl: RELAY, pollIntervalMin: 10 });
});

test('T6b.4 a host that refuses the write is reported, not pretended', async () => {
  const host = fakeBridge();
  host.control.accept = false;
  const store = new BridgeStore(host.bridge, fakeBrowserStorage());
  await store.hydrate([SETTINGS_KEY]);

  assert.equal(await commitSettings({ relayUrl: RELAY, pollIntervalMin: 5 }, store), 'refused');
  assert.equal(await ackOf(store), false);
});

test('T6b.4 a host that throws is reported by the error name, without the settings blob in the log', async () => {
  const host = fakeBridge();
  host.control.throws = true;
  const store = new BridgeStore(host.bridge, fakeBrowserStorage());
  const { result, logged } = await captureErrorsAsync(async () => {
    await store.hydrate([SETTINGS_KEY]);
    return commitSettings({ relayUrl: RELAY, pollIntervalMin: 5 }, store);
  });
  assert.equal(result, 'refused');
  assert.ok(!logged.includes(RELAY), `the log carried the blob: ${logged}`);
  assert.ok(logged.includes('Error'), `the failure should still be named: ${logged}`);
});

test('T6b.4 no bridge yet — the browser holds it and persist() says so', async () => {
  // The settings page mounts before the glasses connect (that is where the relay URL is pasted), so
  // "no bridge" is a normal state. It must not promise the Even App will have the value.
  const mirror = fakeBrowserStorage();
  const store = new BridgeStore(null, mirror);
  await store.hydrate([SETTINGS_KEY]);

  assert.equal(await commitSettings({ relayUrl: RELAY, pollIntervalMin: 5 }, store), 'browserOnly');
  assert.equal(await ackOf(store), false, 'nothing reached the Even App');
  assert.deepEqual(loadSettings(store), { relayUrl: RELAY, pollIntervalMin: 5 });
  assert.deepEqual(JSON.parse(mirror.map.get(SETTINGS_KEY) as string).relayUrl, RELAY);
});

test('T6b.4 no bridge and a browser that blocks storage is `blocked`, the worst case', async () => {
  const mirror = fakeBrowserStorage();
  mirror.control.throws = true;
  const store = new BridgeStore(null, mirror);
  const { result } = await captureErrorsAsync(async () => {
    await store.hydrate([SETTINGS_KEY]);
    return commitSettings({ relayUrl: RELAY, pollIntervalMin: 5 }, store);
  });
  assert.equal(result, 'blocked');
  // …and the app still runs on the value for this session, which is what keeps the glasses drawn.
  assert.deepEqual(loadSettings(store), { relayUrl: RELAY, pollIntervalMin: 5 });
});

test('T6b.4 installBridgeStore switches the shared store once and is idempotent', async () => {
  const host = fakeBridge({ [SETTINGS_KEY]: JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 10 }) });
  try {
    const store = await installBridgeStore(host.bridge, [SETTINGS_KEY], fakeBrowserStorage());
    assert.equal(activeStorage(), store, 'the shared store was not switched');
    // Every caller that does not pass a store of its own now reads the hydrated value.
    assert.deepEqual(loadSettings(), { relayUrl: RELAY, pollIntervalMin: 10 });
    // `qa-live.ts` installs the store, seeds it, and then imports `main.ts`, which installs again:
    // a second hydrate would overwrite the seed with the host's value.
    const again = await installBridgeStore(host.bridge, [SETTINGS_KEY], fakeBrowserStorage());
    assert.equal(again, store, 'a second install built a second store');
  } finally {
    useStorage(null);
  }
});

// ---- T6b.4 rules 6–9 (2026-09-10 codex review of `4231fb8`) ------------------------------------

test('T6b.4 rule 6 — a read that FAILED is not the same as a key the host does not hold', async () => {
  // The finding: `getLocalStorage` throwing was caught and answered `''`, which is the host's own
  // word for "I hold nothing" — so hydrate took the migration branch and pushed the browser mirror
  // over host data that may be NEWER than it. A failed read means UNKNOWN: this session runs on the
  // mirror, and nothing is written back.
  const host = fakeBridge({ [SETTINGS_KEY]: JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 10 }) });
  host.control.readThrows = true;
  const stale = { relayUrl: 'http://stale:8787', pollIntervalMin: 3 };
  const mirror = fakeBrowserStorage({ [SETTINGS_KEY]: JSON.stringify(stale) });
  const store = new BridgeStore(host.bridge, mirror);

  const { logged } = await captureErrorsAsync(async () => {
    await store.hydrate([SETTINGS_KEY]);
    await store.persist();
  });

  assert.deepEqual(host.writes, [], 'a failed read let the browser mirror overwrite the host');
  assert.equal(
    host.values.get(SETTINGS_KEY),
    JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 10 }),
    'the durable value was replaced by a mirror that could be older',
  );
  // …and the session still works, on the only copy it can reach.
  assert.deepEqual(loadSettings(store), stale);
  assert.ok(logged.includes('Error'), `the failed read should be named: ${logged}`);
});

test('T6b.4 rule 7 — a host store that never answers still lets the app start', { timeout: 2000 }, async () => {
  // `main.ts` awaits this before `app.start()`, so an unbounded hydrate is a blank pair of glasses —
  // §6 rule 5 in its worst shape. Per key 3 s, overall 5 s, and a timeout counts as UNKNOWN (rule 6).
  const timers = new FakeTimers();
  const bridge: StorageBridge = {
    setLocalStorage: async () => true,
    // Never settles: the host accepted the call and said nothing, which no `catch` can rescue.
    getLocalStorage: () => new Promise<string>(() => undefined),
  };
  try {
    const { result, logged } = await captureErrorsAsync(async () => {
      const installing = installBridgeStore(bridge, [SETTINGS_KEY, OTHER_KEY], fakeBrowserStorage(), {
        setTimer: timers.set,
        clearTimer: timers.clear,
      });
      await drainTimers(timers);
      return installing;
    });
    assert.equal(activeStorage(), result, 'the store was never installed, so app.start() never ran');
    assert.deepEqual(loadSettings(result), DEFAULT_STORED, 'a key that never answered must read as absent');
    assert.ok(logged.includes('did not answer'), `the timeout should be logged: ${logged}`);
  } finally {
    useStorage(null);
  }
});

test('T6b.4 rule 8 — a keystroke writes memory and the mirror only, and the host once', async () => {
  // The settings page used to write the host on every keystroke — thirty round trips for one pasted
  // relay URL, each of them one more thing between the owner and their next redraw.
  const timers = new FakeTimers();
  const host = fakeBridge();
  const store = new BridgeStore(host.bridge, fakeBrowserStorage(), {
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  await store.hydrate([SETTINGS_KEY]);

  // One keystroke per character, as the settings page's `input` handler delivers them.
  for (const typed of ['h', 'ht', 'htt', 'http', RELAY]) store.setItem(SETTINGS_KEY, typed);
  assert.deepEqual(host.writes, [], 'a keystroke reached the host before the debounce elapsed');
  assert.equal(store.getItem(SETTINGS_KEY), RELAY, 'the value must be live for this session at once');

  timers.fireAll();
  await store.persist();
  assert.deepEqual(
    host.writes,
    [{ key: SETTINGS_KEY, value: RELAY }],
    'five keystrokes were not coalesced into one host write',
  );

  // …and `persist()` does not wait for the debounce, because `Saved` is painted from its answer.
  store.setItem(SETTINGS_KEY, JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 3 }));
  assert.equal(host.writes.length, 1, 'the debounce should still be holding the second write');
  assert.equal(await ackOf(store), true);
  assert.equal(host.writes.length, 2, 'persist() did not flush the pending write immediately');
});

/** A bridge whose reads are handed back to the test, so a hydrate can be stopped between keys. */
function deferredReadBridge() {
  const values = new Map<string, string>();
  const writes: Array<{ key: string; value: string }> = [];
  const reads = new Map<string, (value: string) => void>();
  const bridge: StorageBridge = {
    setLocalStorage: async (key, value) => {
      writes.push({ key, value });
      values.set(key, value);
      return true;
    },
    getLocalStorage: (key) => new Promise<string>((resolve) => void reads.set(key, resolve)),
  };
  return { bridge, values, writes, reads };
}

test('T6b.4 rule 9 — a value written before the bridge resolved wins over the host’s older one', async () => {
  // The settings page is mounted on browser storage on purpose: the owner pastes the relay URL while
  // the glasses are still disconnected. Hydrate then handed them the host's previous URL back, so the
  // paste vanished a second after it was typed. A key this session wrote wins, and goes to the host.
  const pasted = 'http://100.64.0.2:8787';
  const mirror = fakeBrowserStorage();
  assert.equal(saveSettings({ relayUrl: pasted, pollIntervalMin: 5 }, mirror), true, 'the paste landed');
  const host = fakeBridge({
    [SETTINGS_KEY]: JSON.stringify({ relayUrl: 'http://yesterday:8787', pollIntervalMin: 10 }),
  });
  try {
    const store = await installBridgeStore(host.bridge, [SETTINGS_KEY], mirror, {
      wroteThisSession: (key) => key === SETTINGS_KEY,
    });
    assert.deepEqual(
      loadSettings(store),
      { relayUrl: pasted, pollIntervalMin: 5 },
      'hydrate overwrote what the owner had just typed',
    );
    await store.persist();
    assert.equal(
      JSON.parse(host.values.get(SETTINGS_KEY) as string).relayUrl,
      pasted,
      'the session value was kept but never written to the host',
    );
  } finally {
    useStorage(null);
  }
});

test('T6b.4 rule 9 — an edit that lands AFTER this key was adopted still wins', async () => {
  // The ordering the 2026-09-10 codex review found: hydrate handles the keys one after another, so
  // `wroteThisSession` was asked about the settings key BEFORE the owner had finished typing, and
  // never again. The paste lands in the browser mirror (the settings page is deliberately still
  // mounted on it) while the SECOND key is being read, and the host's older URL stayed in the map —
  // the review's probe watched `http://old/…` survive the hydrate.
  const old = 'http://old:8787';
  const pasted = 'http://100.64.0.2:8787';
  const mirror = fakeBrowserStorage();
  const host = deferredReadBridge();
  // Exactly what `main.ts` injects: the settings page's own `touched` flag, asked per key, per moment.
  const page = { touched: false };
  const store = new BridgeStore(host.bridge, mirror, {
    wroteThisSession: (key) => key === SETTINGS_KEY && page.touched,
  });

  const hydrating = store.hydrate([SETTINGS_KEY, OTHER_KEY]);
  await tick();
  // The settings key is read and adopted from the host first — nothing has been typed yet.
  host.reads.get(SETTINGS_KEY)?.(JSON.stringify({ relayUrl: old, pollIntervalMin: 10 }));
  await tick();
  assert.ok(host.reads.has(OTHER_KEY), 'the hydrate never got as far as the second key');
  // …and NOW the paste lands, in the browser storage the page is still mounted on.
  assert.equal(saveSettings({ relayUrl: pasted, pollIntervalMin: 5 }, mirror), true, 'the paste landed');
  page.touched = true;
  host.reads.get(OTHER_KEY)?.('');
  await hydrating;

  assert.deepEqual(
    loadSettings(store),
    { relayUrl: pasted, pollIntervalMin: 5 },
    'the host’s older URL overwrote the paste at the end of the hydrate',
  );
  assert.equal(await ackOf(store), true);
  assert.equal(
    JSON.parse(host.values.get(SETTINGS_KEY) as string).relayUrl,
    pasted,
    'the session value was kept but never written to the host',
  );
});

test('T6b.4 rule 9 — a setItem during the hydrate is dirty whichever key is still being read', async () => {
  // The same property from the other side: the edit arrives through the store itself (the page has
  // been handed it already), while the cache key's read is still outstanding. Both reads then answer
  // with the host's older copies, and neither may be allowed to land on the key the session wrote.
  const fresh = JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 3 });
  const host = deferredReadBridge();
  const store = new BridgeStore(host.bridge, fakeBrowserStorage());

  const hydrating = store.hydrate([SETTINGS_KEY, OTHER_KEY]);
  await tick();
  host.reads.get(SETTINGS_KEY)?.(JSON.stringify({ relayUrl: 'http://old:8787', pollIntervalMin: 10 }));
  await tick();
  store.setItem(SETTINGS_KEY, fresh);
  host.reads.get(OTHER_KEY)?.('{"version":1}');
  await hydrating;

  assert.deepEqual(loadSettings(store), { relayUrl: RELAY, pollIntervalMin: 3 });
  assert.equal(await ackOf(store), true);
  assert.equal(host.values.get(SETTINGS_KEY), fresh, 'the edit made during the hydrate never reached the host');
  // One write, not two: the key is scheduled when it is adopted and again by the end-of-hydrate
  // rule 9 pass, and the debounce is what makes that idempotent instead of chatty.
  assert.deepEqual(host.writes, [{ key: SETTINGS_KEY, value: fresh }], 'the host was written twice');
});

test('T6b.4 rule 9 — hydrate merges the settings key PER FIELD, not as one blob', async () => {
  // The 2026-09-10 codex finding. The browser mirror is empty (the packaged app clears it), the host
  // holds the configured relay URL, and the owner presses a poll-interval segment before the hydrate
  // has answered. The session's blob is therefore `{"relayUrl":"","pollIntervalMin":3}`, and as ONE
  // dirty key it went over the host's copy AND was written back to it — the URL gone for good.
  const hostUrl = 'http://100.64.0.3:8787';
  const host = deferredReadBridge();
  const mirror = fakeBrowserStorage();
  // Live, as `main.ts` reads it: the hydrate takes tens of milliseconds and the press lands inside it.
  const edited: Array<keyof StoredSettings> = [];
  const store = new BridgeStore(host.bridge, mirror, {
    mergeSession: (key, session, held) =>
      key === SETTINGS_KEY ? mergeSettingsBlobs(session, held, edited) : session,
  });

  const hydrating = store.hydrate([SETTINGS_KEY, OTHER_KEY]);
  await tick();
  edited.push('pollIntervalMin');
  store.setItem(SETTINGS_KEY, JSON.stringify({ relayUrl: '', pollIntervalMin: 3 }));
  host.reads.get(SETTINGS_KEY)?.(JSON.stringify({ relayUrl: hostUrl, pollIntervalMin: 10 }));
  await tick();
  host.reads.get(OTHER_KEY)?.('');
  await hydrating;

  const merged = { relayUrl: hostUrl, pollIntervalMin: 3 };
  assert.deepEqual(loadSettings(store), merged, 'the interval press wiped the host’s relay URL');
  assert.equal(await ackOf(store), true);
  assert.deepEqual(
    JSON.parse(host.values.get(SETTINGS_KEY) as string),
    merged,
    'the merged blob is what the host has to end up holding',
  );
  // The mirror is what a launch that never reaches the bridge hydrates from, so it carries the merge
  // too — otherwise the next offline launch is back to the empty URL.
  assert.deepEqual(JSON.parse(mirror.map.get(SETTINGS_KEY) as string), merged);
});

test('T6b.4 rule 9 — the payload cache keeps whole-key semantics: it has no fields to merge', async () => {
  // `quotalens.payload` is one opaque §3 payload: a session copy that is newer wins entirely, and no
  // field of the host's older copy may be spliced into it. Nothing is injected for it, which is the
  // default — asserted so the per-field merge above cannot quietly become the rule for both keys.
  const fresh = '{"version":1,"generatedAt":"2026-09-10T00:00:00+10:00"}';
  const host = deferredReadBridge();
  const store = new BridgeStore(host.bridge, fakeBrowserStorage());

  const hydrating = store.hydrate([OTHER_KEY]);
  await tick();
  store.setItem(OTHER_KEY, fresh);
  host.reads.get(OTHER_KEY)?.('{"version":1,"generatedAt":"2026-09-09T00:00:00+10:00"}');
  await hydrating;

  assert.equal(store.getItem(OTHER_KEY), fresh, 'the host’s older cache overwrote this session’s');
  assert.equal(await ackOf(store, OTHER_KEY), true);
  assert.equal(host.values.get(OTHER_KEY), fresh);
});

/**
 * A host that answers nothing until the test says so, counting how many calls it holds at once.
 *
 * Rule 8's two halves in one fixture: the storage queue must never hold two of these open together,
 * and it must ABANDON one that is never released rather than stopping there for good.
 */
function stallableBridge() {
  const issued: string[] = [];
  const writes: Array<{ key: string; value: string }> = [];
  const pending: Array<{ what: string; settle: (value: unknown) => void }> = [];
  const state = { inFlight: 0, mostInFlight: 0 };
  const accept = <T,>(what: string): Promise<T> => {
    issued.push(what);
    state.inFlight += 1;
    state.mostInFlight = Math.max(state.mostInFlight, state.inFlight);
    return new Promise<T>((resolve) => {
      pending.push({
        what,
        settle: (value) => {
          state.inFlight -= 1;
          resolve(value as T);
        },
      });
    });
  };
  const bridge: StorageBridge = {
    getLocalStorage: (key) => accept<string>(`read ${key}`),
    setLocalStorage: (key, value) => {
      writes.push({ key, value });
      return accept<boolean>(`write ${key}`);
    },
  };
  /** Answer one named call. Named rather than oldest-first, because an abandoned one is never taken. */
  const release = (what: string, value: string | boolean): void => {
    const at = pending.findIndex((call) => call.what === what);
    assert.ok(at >= 0, `no ${what} is with the host: ${pending.map((call) => call.what).join(', ')}`);
    pending.splice(at, 1)[0]?.settle(value);
  };
  /** The same, newest first: for a NEWER write to be answered before an older one that is still held. */
  const releaseNewest = (what: string, value: string | boolean): void => {
    const at = pending.map((call) => call.what).lastIndexOf(what);
    assert.ok(at >= 0, `no ${what} is with the host: ${pending.map((call) => call.what).join(', ')}`);
    pending.splice(at, 1)[0]?.settle(value);
  };
  return { bridge, issued, writes, state, release, releaseNewest };
}

test('T6b.4 rule 8 — a host read that never answers is abandoned and the queue advances', { timeout: 2000 }, async () => {
  // The 2026-09-10 fifth-round codex finding. The deadline released the CALLER and left the stalled
  // call holding the queue, so nothing storage did afterwards ever went out — and while that queue
  // was the renderer's, neither did any redraw, exit call or input acknowledgement (§6 rule 5).
  const timers = new FakeTimers();
  const host = stallableBridge();
  const store = new BridgeStore(host.bridge, fakeBrowserStorage(), {
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  await captureErrorsAsync(async () => {
    const hydrating = store.hydrate([SETTINGS_KEY]);
    await tick();
    assert.deepEqual(host.issued, [`read ${SETTINGS_KEY}`], 'the hydrate read was never issued');

    // The host has gone quiet: the per-call deadline fires, the key counts as UNKNOWN and the boot
    // goes on (rule 7) — `app.start()` must not wait for a store that will not answer.
    await drainTimers(timers);
    await hydrating;
    assert.deepEqual(loadSettings(store), DEFAULT_STORED, 'a key that never answered must read as absent');

    // The Save that follows must reach the host even though the read is STILL with it (rule 8).
    store.setItem(SETTINGS_KEY, RELAY);
    const acked = ackOf(store);
    await tick();
    assert.deepEqual(
      host.issued,
      [`read ${SETTINGS_KEY}`, `write ${SETTINGS_KEY}`],
      'the storage queue never advanced past the abandoned read',
    );
    host.release(`write ${SETTINGS_KEY}`, true);
    assert.equal(await acked, true, '`Saved` was refused over a link that answered');
    // No overlap assertion here on purpose: the host is still HOLDING the abandoned read, which is
    // the point — nothing can take it back. Rule 8 abandons the wait, and the counter in the
    // overlap test below measures the only thing the store controls, which calls it ISSUES.
  });
});

test('T6b.4 rule 8 — two host storage calls never overlap', { timeout: 2000 }, async () => {
  // The storage queue owns this now rather than borrowing the renderer's: one storage call at a time
  // among themselves. A write that lands mid-hydrate waits for the read, it does not race it.
  const timers = new FakeTimers();
  const host = stallableBridge();
  const store = new BridgeStore(host.bridge, fakeBrowserStorage(), {
    setTimer: timers.set,
    clearTimer: timers.clear,
  });

  const hydrating = store.hydrate([SETTINGS_KEY, OTHER_KEY]);
  await tick();
  assert.deepEqual(host.issued, [`read ${SETTINGS_KEY}`], 'the second read went out alongside the first');

  store.setItem(SETTINGS_KEY, RELAY);
  const acked = ackOf(store);
  await tick();
  assert.deepEqual(host.issued, [`read ${SETTINGS_KEY}`], 'the write raced the read that was in flight');

  host.release(`read ${SETTINGS_KEY}`, '');
  await tick();
  assert.deepEqual(
    host.issued,
    [`read ${SETTINGS_KEY}`, `write ${SETTINGS_KEY}`],
    'the write did not go out when the link came free',
  );

  host.release(`write ${SETTINGS_KEY}`, true);
  assert.equal(await acked, true);
  await tick();
  host.release(`read ${OTHER_KEY}`, '');
  await hydrating;
  assert.equal(host.state.mostInFlight, 1, `${host.state.mostInFlight} host calls were open at once`);
});

test('T6b.4 rule 8 — a late answer never comes back over a value written after the timeout', { timeout: 2000 }, async () => {
  // Abandoning a call is only safe if its answer is DISCARDED: the host's pre-save copy turning up
  // after the deadline would otherwise walk the just-saved relay URL back (rules 6 and 8).
  const timers = new FakeTimers();
  const host = stallableBridge();
  const store = new BridgeStore(host.bridge, fakeBrowserStorage(), {
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const saved = JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 3 });
  const heldBefore = JSON.stringify({ relayUrl: 'http://old:8787', pollIntervalMin: 10 });

  await captureErrorsAsync(async () => {
    const hydrating = store.hydrate([SETTINGS_KEY]);
    await tick();
    await drainTimers(timers);
    await hydrating;

    store.setItem(SETTINGS_KEY, saved);
    const acked = ackOf(store);
    await tick();
    assert.ok(host.issued.includes(`write ${SETTINGS_KEY}`), 'the storage queue never advanced');
    host.release(`write ${SETTINGS_KEY}`, true);
    assert.equal(await acked, true);

    // …and only now does the abandoned read answer, with what the host held before the save.
    host.release(`read ${SETTINGS_KEY}`, heldBefore);
    await tick();
    assert.deepEqual(
      loadSettings(store),
      { relayUrl: RELAY, pollIntervalMin: 3 },
      'a late host answer came back over the value saved after it',
    );
    assert.equal(host.writes.length, 1, 'the late answer was pushed back out as a write of its own');
  });
});

test('T6b.4 rule 8 — storage rides the renderer queue, and a timed-out call lets the next render through', { timeout: 2000 }, async () => {
  // Sixth-round finding, in two halves: the glasses-ui skill says EVERY bridge call is serialised
  // (storage included — "setLocalStorage shares the same BLE link"), so the store must use the
  // renderer's queue and not one of its own; and the same skill's per-call `Promise.race` cap is
  // what keeps a host that never answers from holding a render behind it for good.
  const timers = new FakeTimers();
  const host = stallableBridge();
  const order: string[] = [];
  let tail: Promise<unknown> = Promise.resolve();
  // A stand-in for `Renderer.enqueue`: one chain, every job appended to it.
  const enqueue = <T,>(call: () => Promise<T>): Promise<T> => {
    const result = tail.then(call);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const store = new BridgeStore(host.bridge, fakeBrowserStorage(), {
    setTimer: timers.set,
    clearTimer: timers.clear,
    enqueue,
  });

  await captureErrorsAsync(async () => {
    const hydrating = store.hydrate([SETTINGS_KEY]);
    await tick();
    // A render queued behind the read must wait for it: one bridge call at a time.
    const rendered = enqueue(async () => void order.push('render'));
    await tick();
    assert.deepEqual(order, [], 'the render overtook a storage call that was still with the host');

    // The host never answers the read. Its deadline releases the queue (the skill's race cap), so the
    // render goes out; the read itself stays with the host and its answer, if any, is discarded.
    await drainTimers(timers);
    await hydrating;
    await rendered;
    assert.deepEqual(order, ['render'], 'a storage call that missed its deadline held the renderer queue');
  });
});

test('T6b.4 rule 12 — a write that answers after its deadline is followed by a re-write of the current value', { timeout: 2000 }, async () => {
  // Sixth-round finding: write A times out (caller told `false`, queue advanced), write B goes out
  // and is acknowledged, then A lands late on the host — durable A under a `Saved` for B. The SDK
  // cannot cancel A, so the store answers with one more write of what it holds now.
  const timers = new FakeTimers();
  const host = stallableBridge();
  const store = new BridgeStore(host.bridge, fakeBrowserStorage(), {
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const a = JSON.stringify({ relayUrl: 'http://a:8787', pollIntervalMin: 3 });
  const b = JSON.stringify({ relayUrl: 'http://b:8787', pollIntervalMin: 5 });

  await captureErrorsAsync(async () => {
    store.setItem(SETTINGS_KEY, a);
    const ackA = ackOf(store);
    await tick();
    assert.deepEqual(host.issued, [`write ${SETTINGS_KEY}`], 'write A was never issued');
    // A goes quiet past its deadline: reported as not stored, queue released.
    await drainTimers(timers);
    assert.equal(await ackA, false, 'a write the host never answered was reported as stored');

    store.setItem(SETTINGS_KEY, b);
    const ackB = ackOf(store);
    await tick();
    assert.equal(host.writes.length, 2, 'write B did not go out after A was abandoned');

    // A lands on the host, late — `release` answers the OLDEST pending write of that name, which is
    // A. The host now holds A behind a B that is still in flight (or, on a real host, already acked).
    host.release(`write ${SETTINGS_KEY}`, true);
    await tick();
    host.release(`write ${SETTINGS_KEY}`, true); // B
    assert.equal(await ackB, true);

    // The store must not leave the host holding A: one more write, of what it holds now.
    await drainTimers(timers); // the re-write waits out the debounce like any other write
    await tick();
    assert.equal(host.writes.length, 3, 'the late write was not followed by a re-write');
    assert.equal(host.writes[2]?.value, b, 'the re-write did not carry the current value');
    host.release(`write ${SETTINGS_KEY}`, true);
    await tick();
    assert.deepEqual(loadSettings(store), { relayUrl: 'http://b:8787', pollIntervalMin: 5 });
  });
});

test('T6b.4 rule 8 — a save queued behind a render the glasses never answer is reported as not stored, not awaited forever', { timeout: 2000 }, async () => {
  // Stop-gate finding on the shared queue: `callHost`'s deadline starts when the call is ISSUED, so
  // a write queued behind a hung render is never issued, never times out, and `persist()` waited
  // for good. The wait itself is bounded now.
  const timers = new FakeTimers();
  const host = stallableBridge();
  // A renderer queue whose head never settles: nothing appended to it ever runs.
  const stuck = new Promise<never>(() => undefined);
  const enqueue = <T,>(call: () => Promise<T>): Promise<T> => stuck.then(call);
  const store = new BridgeStore(host.bridge, fakeBrowserStorage(), {
    setTimer: timers.set,
    clearTimer: timers.clear,
    enqueue,
  });

  await captureErrorsAsync(async () => {
    store.setItem(SETTINGS_KEY, RELAY);
    const acked = ackOf(store);
    await tick();
    assert.deepEqual(host.issued, [], 'the write went out past a render that had not answered');
    await drainTimers(timers);
    assert.equal(await acked, false, 'a save that could not be issued was reported as stored');
  });
});

test('T6b.4 rule 14 — a refused repair takes the durability down, and a later confirmation brings it back', { timeout: 2000 }, async () => {
  // Codex review on d51da3c: write A times out, B is acknowledged, A lands late and overwrites B on
  // the host; the one corrective write of B times out and is then refused late — the host is left
  // holding A behind a standing `Saved` for B. The store must keep the two in view and say so.
  const timers = new FakeTimers();
  const host = stallableBridge();
  const store = new BridgeStore(host.bridge, fakeBrowserStorage(), {
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  const heard: Array<[string, boolean]> = [];
  store.onDurability((key, durable) => heard.push([key, durable]));
  const a = JSON.stringify({ relayUrl: 'http://a:8787', pollIntervalMin: 3 });
  const b = JSON.stringify({ relayUrl: 'http://b:8787', pollIntervalMin: 5 });

  await captureErrorsAsync(async () => {
    store.setItem(SETTINGS_KEY, a);
    const ackA = ackOf(store);
    await tick();
    await drainTimers(timers); // A times out
    assert.equal(await ackA, false);

    store.setItem(SETTINGS_KEY, b);
    const ackB = ackOf(store);
    await tick();
    host.releaseNewest(`write ${SETTINGS_KEY}`, true); // B is acknowledged: durable B
    assert.equal(await ackB, true);
    assert.deepEqual(heard.at(-1), [SETTINGS_KEY, true], 'B acknowledged: durable');

    host.release(`write ${SETTINGS_KEY}`, true); // …and A lands late: the host now holds A
    await tick();
    assert.deepEqual(heard.at(-1), [SETTINGS_KEY, false], 'a late A over an acknowledged B must take the durability down');
    // The repair of B goes out (rule 12), times out, and is then REFUSED late.
    await drainTimers(timers);
    await tick();
    assert.equal(host.writes.length, 3, 'no repair write followed the late A');
    assert.equal(host.writes[2]?.value, b);
    await drainTimers(timers); // the repair times out
    host.release(`write ${SETTINGS_KEY}`, false); // …and is refused, late
    await tick();
    assert.deepEqual(heard.at(-1), [SETTINGS_KEY, false], 'the durability must still read as down');
    // …and no further repair against a value the host has refused.
    await drainTimers(timers);
    await tick();
    assert.equal(host.writes.length, 3, 'the store kept retrying a value the host refused');

    // The owner edits again; the host takes it: durable once more.
    const c = JSON.stringify({ relayUrl: 'http://c:8787', pollIntervalMin: 10 });
    store.setItem(SETTINGS_KEY, c);
    const ackC = ackOf(store);
    await tick();
    host.release(`write ${SETTINGS_KEY}`, true);
    assert.equal(await ackC, true);
    assert.deepEqual(heard.at(-1), [SETTINGS_KEY, true]);
  });
});

test('T6b.4 rule 8 — a store installed before the renderer takes the renderer queue when main.ts installs again', async () => {
  // `qa-live.ts` installs (and hydrates) the store first; `main.ts` then calls `installStore` with
  // the renderer's queue and got the existing store back with that queue ignored — the harness ran
  // storage and renders on two queues (2026-09-10 codex review).
  useStorage(null);
  const host = fakeBridge();
  const first = installStore(host.bridge, fakeBrowserStorage(), { debounceMs: 1 });
  const rode: string[] = [];
  const enqueue = <T,>(call: () => Promise<T>): Promise<T> => {
    rode.push('storage');
    return call();
  };
  const again = installStore(host.bridge, fakeBrowserStorage(), { enqueue });
  assert.equal(again, first, 'installStore must stay idempotent');
  again.setItem(SETTINGS_KEY, RELAY);
  await again.persist();
  assert.deepEqual(rode, ['storage'], 'the write did not ride the queue supplied by the second install');
  useStorage(null);
});

// ---- T6b.4 rule 11 (2026-09-10 codex review, third round) --------------------------------------

test('T6b.4 rule 11 — `Saved` reads the settings key’s OWN ack, not the last write in the batch', async () => {
  // The finding: one batch carried both keys and `persist()` answered with the LAST boolean, so a
  // refused `quotalens.settings` followed by an accepted `quotalens.payload` painted `Saved` over a
  // relay URL the Even App had thrown away — the exact promise §7 V8 exists to keep honest.
  const timers = new FakeTimers();
  const host = fakeBridge();
  host.control.refuse.add(SETTINGS_KEY);
  const store = new BridgeStore(host.bridge, fakeBrowserStorage(), {
    setTimer: timers.set,
    clearTimer: timers.clear,
  });
  await store.hydrate([SETTINGS_KEY, OTHER_KEY]);

  // The settings key enters the batch FIRST (the owner typed a URL) and the cache key after it (a
  // poll landed): that order is what let an accepted cache write speak for a refused save.
  store.setItem(SETTINGS_KEY, JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 10 }));
  store.setItem(OTHER_KEY, '{"version":1}');

  const { result: outcome, logged } = await captureErrorsAsync(() =>
    commitSettings({ relayUrl: RELAY, pollIntervalMin: 5 }, store),
  );
  assert.equal(outcome, 'refused', 'a refused settings write was reported as saved');

  const results = await store.persist();
  assert.equal(results.get(SETTINGS_KEY), false, 'the refused key must answer for itself');
  assert.equal(results.get(OTHER_KEY), true, 'the accepted key must answer for itself too');
  // The failure is named by KEY; the value (the whole blob) never appears in a log line.
  assert.ok(logged.includes(SETTINGS_KEY), `the failed key was not named: ${logged}`);
  assert.ok(!logged.includes(RELAY), `the log carried the blob: ${logged}`);
});
