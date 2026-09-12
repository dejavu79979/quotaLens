import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEMO_PAYLOAD } from './fixtures.ts';
import {
  BridgeStore,
  DEFAULT_STORED,
  installBridgeStore,
  loadSettings,
  SETTINGS_KEY,
  useStorage,
  type PersistentStorage,
  type StorageBridge,
  type WriteResults,
} from './settings.ts';
import {
  SettingsController,
  formatTestRow,
  RELAY_HINT,
  RELAY_LABEL,
  RELAY_PLACEHOLDER,
  savedRowText,
  testConnection,
  type SavedRow,
  type SettingsView,
  type TestRow,
} from './settings-page.ts';

/** M9: the relay address is the daemon's origin; the page adds nothing and hides nothing. */
const RELAY = 'http://127.0.0.1:8787';
const USAGE = `${RELAY}/usage.json`;

/** The success path has to answer with something the real contract accepts, so it uses the
 * fixture the screens are drawn from rather than a hand-written body. */
const GOOD_PAYLOAD = DEMO_PAYLOAD;

/** The two methods the page uses, with a switch for the WebView that blocks site data. */
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

/** Records what the page would have painted, so the controller is testable without a DOM. */
function fakeView() {
  const seen = {
    relay: [] as string[],
    poll: [] as number[],
    test: [] as TestRow[],
    // `SavedRow`, not `SaveOutcome`: `null` is the blank row, which is what a commit still in
    // flight leaves behind (PLAN T6b.4 spec item 3).
    saved: [] as SavedRow[],
  };
  const view: SettingsView = {
    showRelay: (text) => void seen.relay.push(text),
    showPollInterval: (min) => void seen.poll.push(min),
    showTestRow: (row) => void seen.test.push(row),
    showSaved: (outcome) => void seen.saved.push(outcome),
  };
  const last = <T>(xs: T[]): T => xs[xs.length - 1] as T;
  return { view, seen, last };
}

function okResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

test('M9 — the field copy is §7 phone side verbatim, and the seam is the four paint methods', () => {
  assert.equal(RELAY_LABEL, 'Relay address');
  assert.equal(RELAY_PLACEHOLDER, 'http://100.x.y.z:8787');
  assert.equal(RELAY_HINT, "Your desktop's tailnet address — the installer prints it.");
  const { view } = fakeView();
  const controller = new SettingsController(view, { storage: fakeStorage() });
  // T6b.2 removed the threshold control; M9 removed the Scan button, its row and the glasses hint.
  assert.deepEqual(Object.keys(view).sort(), ['showPollInterval', 'showRelay', 'showSaved', 'showTestRow']);
  assert.deepEqual(Object.keys(controller.settings).sort(), ['pollIntervalMin', 'relayUrl']);
  for (const gone of ['stepWarn', 'showWarnAt', 'scan', 'enableScan', 'glassesConnected', 'focusRelay']) {
    assert.equal((controller as unknown as Record<string, unknown>)[gone], undefined, `${gone} survived`);
  }
});

test('the result row is §7 V8 verbatim', () => {
  assert.equal(formatTestRow({ kind: 'ok', ms: 142 }), '✓ 142 ms');
  assert.equal(formatTestRow({ kind: 'fail', code: 'HTTP 404' }), '✗ HTTP 404');
  assert.equal(formatTestRow({ kind: 'idle' }), '');
});

test('Test connection fetches <base>/usage.json and reports the round trip on a good relay', async () => {
  let clock = 1000;
  const fetched: string[] = [];
  const row = await testConnection(RELAY, {
    fetch: async (input) => {
      fetched.push(String(input));
      clock += 142;
      return okResponse(GOOD_PAYLOAD);
    },
    now: () => clock,
  });
  assert.deepEqual(row, { kind: 'ok', ms: 142 });
  assert.deepEqual(fetched, [USAGE], 'the page must add /usage.json itself (M9)');
});

test('Test connection turns every failure into a short code', async () => {
  const now = () => 0;
  const codeOf = async (fetchImpl: typeof fetch, base = RELAY) => {
    const row = await testConnection(base, { fetch: fetchImpl, now });
    assert.equal(row.kind, 'fail');
    return row.kind === 'fail' ? row.code : '';
  };

  assert.equal(await codeOf(async () => okResponse(null, 404)), 'HTTP 404');
  assert.equal(await codeOf(async () => okResponse({ version: 2 })), 'bad schema');
  assert.equal(
    await codeOf(async () => {
      throw new TypeError('Failed to fetch');
    }),
    'net err',
  );
  const timeout = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  assert.equal(
    await codeOf(async () => {
      throw timeout;
    }),
    'timeout',
  );
  // An address the browser cannot parse is a connection that can never be made, not a fetch.
  assert.equal(await codeOf(async () => okResponse(GOOD_PAYLOAD), 'not a url at all'), 'net err');

  const row = await testConnection('', { fetch: async () => okResponse(GOOD_PAYLOAD), now });
  assert.deepEqual(row, { kind: 'fail', code: 'no relay address' }, 'an empty field is a failure, not a fetch');
});

test('a failed Test connection never rejects, so it cannot take the page down', async () => {
  const row = await testConnection(RELAY, {
    fetch: async () => {
      throw new Error('boom');
    },
    now: () => 0,
  });
  assert.equal(row.kind, 'fail');
});

test('the row goes busy first, so the button is never silent (§6.5)', async () => {
  const { view, seen } = fakeView();
  const controller = new SettingsController(view, {
    storage: fakeStorage(JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 })),
    fetch: async () => okResponse(GOOD_PAYLOAD),
    now: () => 0,
  });
  controller.start();
  const done = controller.test();
  assert.deepEqual(seen.test.at(-1), { kind: 'busy' }, 'feedback before the fetch, not after');
  await done;
  assert.equal(seen.test.at(-1)?.kind, 'ok');
});

test('settings survive a restart: what one page saved, the next page loads', async () => {
  const storage = fakeStorage();
  const first = fakeView();
  const writer = new SettingsController(first.view, { storage });
  writer.start();
  await writer.editRelay(RELAY);
  writer.blurRelay();
  await writer.setPollInterval(10);

  // A restart is a brand new controller over the same storage — no shared state in between.
  const second = fakeView();
  const reader = new SettingsController(second.view, { storage });
  reader.start();
  assert.deepEqual(reader.settings, { relayUrl: RELAY, pollIntervalMin: 10 });
  assert.equal(second.last(second.seen.relay), RELAY);
  assert.equal(second.last(second.seen.poll), 10);
});

test('any relay change pokes the poller, while poll interval changes do not', async () => {
  const storage = fakeStorage(JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 }));
  let pokes = 0;
  const controller = new SettingsController(fakeView().view, {
    storage,
    onRelaySaved: () => void (pokes += 1),
  });
  controller.start();

  await controller.editRelay('100.64.0.9');
  assert.equal(pokes, 1, 'the normalized non-empty relay did not wake the poller');
  await controller.editRelay('   ');
  assert.equal(pokes, 2, 'clearing the relay did not wake the poller');
  await controller.setPollInterval(10);
  assert.equal(pokes, 2, 'changing only the poll interval woke the poller');
});

test('a relay change is stored before it pokes the poller', async () => {
  const storage = fakeStorage(JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 }));
  const seen: string[] = [];
  const controller = new SettingsController(fakeView().view, {
    storage,
    onRelaySaved: () => void seen.push(loadSettings(storage).relayUrl),
  });

  await controller.editRelay('');
  await controller.editRelay('100.64.0.9');

  assert.deepEqual(seen, ['', 'http://100.64.0.9:8787']);
});

test('M9 — a bare tailnet IP typed into the field is stored, and shown on blur, as the full origin', async () => {
  const { view, seen, last } = fakeView();
  const controller = new SettingsController(view, { storage: fakeStorage() });
  controller.start();
  await controller.editRelay('100.64.0.9');
  assert.equal(controller.settings.relayUrl, 'http://100.64.0.9:8787', 'scheme and port were not filled in');
  assert.equal(last(seen.relay), '', 'the field is not repainted while it is being typed in');
  controller.blurRelay();
  assert.equal(last(seen.relay), 'http://100.64.0.9:8787');
  // …and a pre-M9 value pasted whole loses its path: the origin is all that is kept.
  await controller.editRelay('http://100.64.0.9:8787/u/oldsecret/usage.json');
  assert.equal(controller.settings.relayUrl, 'http://100.64.0.9:8787');
});

test('a save that did not happen is reported, not pretended', async () => {
  const storage = fakeStorage();
  const { view, seen, last } = fakeView();
  const controller = new SettingsController(view, { storage });
  controller.start();
  // T6b.4: a plain browser store is no longer allowed to say plain `Saved` — the packaged app's
  // WebView loses it on restart, which is exactly the D12 failure.
  await controller.setPollInterval(3);
  assert.equal(last(seen.saved), 'browserOnly');
  storage.store.throws = true;
  await controller.setPollInterval(10);
  assert.equal(last(seen.saved), 'blocked', 'the user has to be told the value did not stick');
});

// ---- T6b.4: what the notice row is allowed to promise ------------------------------------------

test('T6b.4 the four notice rows are verbatim', () => {
  assert.equal(savedRowText('persisted'), 'Saved');
  assert.equal(savedRowText('browserOnly'), 'Saved (browser only — connect the glasses to keep it)');
  assert.equal(savedRowText('refused'), 'Not saved — the Even App refused to store it');
  assert.equal(savedRowText('blocked'), 'Not saved — this browser is blocking storage');
});

/** A promise the test resolves by hand, so "still in flight" is a state it can assert in. */
function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => void (settle = resolve));
  return { promise, resolve: (value: T): void => settle(value) };
}

/** Drain the microtask queue, so a queued host write has actually been dispatched. */
const tick = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 0));

/**
 * A host-backed store whose acknowledgements the test resolves by hand, one per commit.
 *
 * `BridgeStore` coalesces everything inside one debounce window onto a single ack, so two commits
 * there cannot overlap. This store hands out a fresh deferred per commit, which is the case PLAN
 * T6b.4 spec item 3 is about: an older write still outstanding when a newer value has replaced it.
 */
function pendingStore() {
  const acks: Array<(stored: boolean) => void> = [];
  const owe = (): Promise<WriteResults> => {
    const ack = deferred<WriteResults>();
    acks.push((stored) => ack.resolve(new Map([[SETTINGS_KEY, stored]])));
    return ack.promise;
  };
  const storage: PersistentStorage = {
    durability: 'bridge',
    getItem: () => null,
    // The controller keeps this session's edits itself, so the values it writes are re-read from
    // `edits` and nothing here has to hold them. What is under test is the ORDER of the acks.
    setItem: () => undefined,
    persist: owe,
    settled: owe,
  };
  return { storage, acks };
}

test('T6b.4 `Saved` appears only after the Even App acknowledges the write', async () => {
  // The whole point of D12: `Saved` is a promise about the NEXT launch, and only the host store can
  // keep it. So the row must not say `Saved` while the write is still in flight.
  const ack = deferred<boolean>();
  const bridge: StorageBridge = {
    setLocalStorage: () => ack.promise,
    getLocalStorage: async () => '',
  };
  // A keystroke rides the store's trailing debounce (T6b.4 rule 8), so the test collapses the wait
  // rather than sleeping through it. What it is checking is the ORDER, which the debounce preserves.
  const store = new BridgeStore(bridge, fakeStorage(), { debounceMs: 0 });
  await store.hydrate([SETTINGS_KEY]);

  const { view, seen } = fakeView();
  const controller = new SettingsController(view, { storage: store });
  controller.start();
  const saving = controller.editRelay(RELAY);
  assert.equal(controller.settings.relayUrl, RELAY, 'the value must be live for this session at once');
  await tick();
  assert.deepEqual(seen.saved, [], 'the row promised persistence before the host had answered');

  ack.resolve(true);
  await saving;
  assert.deepEqual(seen.saved, ['persisted']);
});

test('T6b.4 a host that refuses the write is named on the page, not swallowed', async () => {
  const bridge: StorageBridge = { setLocalStorage: async () => false, getLocalStorage: async () => '' };
  const store = new BridgeStore(bridge, fakeStorage(), { debounceMs: 0 });
  await store.hydrate([SETTINGS_KEY]);
  const { view, seen } = fakeView();
  const controller = new SettingsController(view, { storage: store });
  controller.start();
  await controller.editRelay(RELAY);
  assert.deepEqual(seen.saved, ['refused']);
});

test('T6b.4 the page re-reads after the store is swapped for the host-backed one', async () => {
  // Boot order: the page mounts on browser storage before `waitForEvenAppBridge()` resolves, so the
  // hydrated relay address arrives after the first paint and the page has to pick it up.
  const browser = fakeStorage();
  const { view, seen, last } = fakeView();
  const controller = new SettingsController(view, { storage: browser });
  controller.start();
  assert.equal(controller.settings.relayUrl, '', 'nothing stored yet');

  const bridge: StorageBridge = {
    setLocalStorage: async () => true,
    getLocalStorage: async (key) =>
      key === SETTINGS_KEY ? JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 10 }) : '',
  };
  const store = new BridgeStore(bridge, fakeStorage());
  await store.hydrate([SETTINGS_KEY]);
  controller.useStorage(store);

  assert.deepEqual(controller.settings, { relayUrl: RELAY, pollIntervalMin: 10 });
  assert.equal(last(seen.relay), RELAY);
  assert.equal(last(seen.poll), 10);
  assert.deepEqual(seen.saved, [], 'a repaint is not a save');
});

test('T6b.4 rule 9 — the page reports WHICH fields it edited, not just that one of them changed', async () => {
  // `touched` answers the key-level question (is there a session value at all?), and the 2026-09-10
  // codex review found that it was also being used as the whole answer: one press on the interval
  // segments made the page's blob outrank the host's for `relayUrl` too. The merge needs the names.
  const { view } = fakeView();
  const controller = new SettingsController(view, { storage: fakeStorage() });
  controller.start();
  assert.deepEqual(controller.editedFields, [], 'nothing has been touched yet');

  await controller.setPollInterval(3);
  assert.deepEqual(controller.editedFields, ['pollIntervalMin'], 'the interval is the only edit');
  assert.equal(controller.touched, true, 'main.ts still needs the key-level answer');

  await controller.editRelay(RELAY);
  assert.deepEqual([...controller.editedFields].sort(), ['pollIntervalMin', 'relayUrl']);
});

test('T6b.4 rule 9 — an address pasted before the bridge resolved survives the hydrate', async () => {
  // The reviewer's finding, end to end. The page is mounted on browser storage on purpose (the owner
  // pastes the relay address while the glasses are still disconnected), the host is still holding
  // yesterday's address, and hydrate used to hand that older value straight back to the page — the
  // paste disappeared a second after it was typed.
  const pasted = 'http://100.64.0.2:8787';
  const browser = fakeStorage();
  const { view, seen, last } = fakeView();
  const controller = new SettingsController(view, { storage: browser });
  controller.start();
  assert.equal(controller.touched, false, 'nothing has been typed yet');
  await controller.editRelay(pasted);
  assert.equal(controller.touched, true, 'main.ts needs to know this key was written this session');

  const host = new Map<string, string>([
    [SETTINGS_KEY, JSON.stringify({ relayUrl: 'http://yesterday:8787', pollIntervalMin: 10 })],
  ]);
  const bridge: StorageBridge = {
    setLocalStorage: async (key, value) => {
      host.set(key, value);
      return true;
    },
    getLocalStorage: async (key) => host.get(key) ?? '',
  };
  try {
    // Exactly what `main.ts` does once `waitForEvenAppBridge()` resolves.
    const store = await installBridgeStore(bridge, [SETTINGS_KEY], browser, {
      wroteThisSession: (key) => key === SETTINGS_KEY && controller.touched,
    });
    controller.useStorage(store);

    assert.equal(controller.settings.relayUrl, pasted, 'hydrate overwrote what the owner had just typed');
    assert.equal(last(seen.relay), pasted);
    assert.deepEqual(seen.saved, ['browserOnly'], 'the repaint is not a save of its own');
    await store.persist();
    assert.equal(
      JSON.parse(host.get(SETTINGS_KEY) as string).relayUrl,
      pasted,
      'the session value was kept but never written to the host',
    );
  } finally {
    useStorage(null);
  }
});

test('T6b.4 rules 9/10 — a control writes the CHANGED field, never the page\'s stale copy of the rest', async () => {
  // The other half of the 2026-09-10 codex finding, and the destructive half: the page read the
  // store before the hydrate, so its copy of the relay address was empty. One press on the interval
  // segments then wrote `{"relayUrl":"","pollIntervalMin":…}` over the address the hydrate had just
  // brought back from the host — a valid relay address gone for good, with `Saved` on the row.
  //
  // So the write is a merge over what the store holds NOW, and the page's own state is authoritative
  // only for the field being changed. That makes the control safe on its own, whether or not anything
  // re-synced the page first.
  const host = new Map<string, string>([
    [SETTINGS_KEY, JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 3 })],
  ]);
  const bridge: StorageBridge = {
    setLocalStorage: async (key, value) => {
      host.set(key, value);
      return true;
    },
    getLocalStorage: async (key) => host.get(key) ?? '',
  };
  const store = new BridgeStore(bridge, fakeStorage(), { debounceMs: 0 });

  const { view, seen, last } = fakeView();
  // Built over the store BEFORE it is hydrated — `main.ts` hands the page the store first (rule 10),
  // so this stale read is the real starting point.
  const controller = new SettingsController(view, { storage: store });
  controller.start();
  assert.equal(controller.settings.relayUrl, '', 'the store has not been hydrated yet');

  await store.hydrate([SETTINGS_KEY]);
  // Deliberately NO re-sync here: the toggle has to be safe by itself.
  await controller.setPollInterval(5);

  assert.equal(controller.settings.relayUrl, RELAY, 'the page dropped the stored address on a toggle');
  assert.equal(last(seen.poll), 5);
  assert.equal(last(seen.saved), 'persisted');
  await store.persist();
  assert.deepEqual(
    JSON.parse(host.get(SETTINGS_KEY) as string),
    { relayUrl: RELAY, pollIntervalMin: 5 },
    'the interval toggle wiped the relay address out of the host store',
  );
});

// ---- T6b.4 spec item 3: WHICH write the notice row is answering for -----------------------------

test('T6b.4 — an older write\'s ack may not paint the row for a value that has already replaced it', async () => {
  // The 2026-09-10 codex finding. Two commits are outstanding at once (typing, then a press; or a
  // press while a keystroke's write is still with the host). The first one's ack came back and
  // painted `Saved` — over the SECOND value, which the host had not answered for and might refuse.
  const { storage, acks } = pendingStore();
  const { view, seen } = fakeView();
  const controller = new SettingsController(view, { storage });
  controller.start();

  const first = controller.setPollInterval(3);
  const second = controller.setPollInterval(10);
  assert.equal(acks.length, 2, 'each commit is its own host write, so their acks can overlap');

  acks[0]?.(true);
  await first;
  assert.equal(controller.settings.pollIntervalMin, 10, 'the page is showing the second value');
  assert.ok(
    !seen.saved.includes('persisted'),
    'a superseded write\'s ack promised the value the page is now showing was saved',
  );

  acks[1]?.(true);
  await second;
  assert.equal(seen.saved.at(-1), 'persisted', 'the newest write is the one the row answers for');
});

test('T6b.4 — a refused newest write is what the row reports, whatever the older ones answered', async () => {
  const { storage, acks } = pendingStore();
  const { view, seen } = fakeView();
  const controller = new SettingsController(view, { storage });
  controller.start();

  const first = controller.setPollInterval(3);
  const second = controller.setPollInterval(10);
  acks[0]?.(true);
  await first;
  acks[1]?.(false);
  await second;

  assert.equal(seen.saved.at(-1), 'refused', 'the row has to name the failure of the CURRENT value');
  assert.deepEqual(
    seen.saved.filter((row) => row === 'persisted'),
    [],
    'the row said `Saved` on the way to a value the Even App threw away',
  );
});

test('T6b.4 — a fresh edit takes `Saved` down until its own write is acknowledged', async () => {
  // The same rule in its steady-state shape: the row is a promise about the value on screen, so it
  // may not keep the previous value's `Saved` while a newer one is still on its way to the host.
  const { storage, acks } = pendingStore();
  const { view, seen } = fakeView();
  const controller = new SettingsController(view, { storage });
  controller.start();

  const first = controller.setPollInterval(3);
  acks[0]?.(true);
  await first;
  assert.equal(seen.saved.at(-1), 'persisted');

  const second = controller.setPollInterval(10);
  assert.equal(seen.saved.at(-1), null, 'the row kept promising the previous value');
  acks[1]?.(true);
  await second;
  assert.equal(seen.saved.at(-1), 'persisted');
});

test('T6b.4 rule 14 — the row follows the durable copy: a refused repair takes `Saved` down, a landed one puts it back', () => {
  const view = fakeView();
  const controller = new SettingsController(view.view);
  // Nothing promised yet: a durability report before the first save changes nothing.
  controller.durabilityChanged(false);
  assert.deepEqual(view.seen.saved, []);
  // …but once the row says `Saved`, the store's word about the durable copy outranks the last ack.
  (controller as unknown as { showSavedRow(row: unknown): void }).showSavedRow('persisted');
  controller.durabilityChanged(false);
  assert.equal(view.seen.saved.at(-1), 'refused');
  controller.durabilityChanged(true);
  assert.equal(view.seen.saved.at(-1), 'persisted');
});

test('a Test connection result is not painted for an address edited while the request was in flight', async () => {
  // Codex stop-gate 2026-09-11: the request for the old address was still running when the owner
  // edited the field, and its ✓ landed under the new address.
  const edited = 'http://100.64.0.9:8787';
  const gate = deferred<Response>();
  const { view, seen, last } = fakeView();
  const controller = new SettingsController(view, {
    storage: fakeStorage(JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 })),
    fetch: () => gate.promise,
    now: () => 0,
  });
  controller.start();

  const testing = controller.test();
  assert.equal(seen.test.at(-1)?.kind, 'busy');
  await controller.editRelay(edited);
  gate.resolve(okResponse(GOOD_PAYLOAD));
  await testing;

  assert.equal(controller.settings.relayUrl, edited);
  assert.equal(last(seen.test)?.kind, 'idle', 'the old address\'s ✓ was painted under the edited one');
  assert.ok(!seen.test.some((row) => row.kind === 'ok'), 'no ✓ at any point for an address not on screen');
});

test('an unreadable store starts the page on the defaults instead of not starting it', () => {
  const storage = fakeStorage();
  storage.store.throws = true;
  const { view, seen, last } = fakeView();
  const controller = new SettingsController(view, { storage });
  controller.start();
  assert.deepEqual(controller.settings, DEFAULT_STORED);
  assert.equal(last(seen.poll), DEFAULT_STORED.pollIntervalMin);
});

test('an interval off the menu is refused rather than stored', () => {
  const { view, seen, last } = fakeView();
  const controller = new SettingsController(view, { storage: fakeStorage() });
  controller.start();
  controller.setPollInterval(7);
  assert.equal(controller.settings.pollIntervalMin, DEFAULT_STORED.pollIntervalMin);
  assert.equal(last(seen.poll), DEFAULT_STORED.pollIntervalMin);
});

test('a MagicDNS name with a scheme and port is stored as typed — no host is assumed (C2b)', () => {
  const storage = fakeStorage();
  const { view } = fakeView();
  const controller = new SettingsController(view, { storage });
  controller.start();
  const tailnet = 'https://desk.tail1234.ts.net:8787';
  controller.editRelay(tailnet);
  assert.equal(controller.settings.relayUrl, tailnet);
  assert.equal(JSON.parse(storage.store.value as string).relayUrl, tailnet);
});
