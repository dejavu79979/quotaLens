// Fixed +10:00 zone, as in the other plugin tests: the §7 fixtures are all `+10:00`.
process.env.TZ = 'Australia/Brisbane';

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { UsagePayload } from '@quotalens/shared';
import { DEMO_PAYLOAD } from './fixtures.ts';
import {
  CACHE_KEY,
  CONNECTING_RETRY_MS,
  ERROR_BAD_SCHEMA,
  ERROR_NET,
  ERROR_NOT_FOUND,
  Poller,
  readCachedPayload,
  REFRESH_DEBOUNCE_MS,
  usageUrl,
  type PollOutcome,
} from './poll.ts';
import { BridgeStore, SETTINGS_KEY, type StoredSettings } from './settings.ts';
import { SettingsController, type SettingsView } from './settings-page.ts';

/** M9: the stored value is the daemon's origin; the poller appends `/usage.json` itself. */
const RELAY = 'http://127.0.0.1:8787';
const USAGE = `${RELAY}/usage.json`;

class MemoryStorage implements Pick<Storage, 'getItem' | 'setItem'> {
  readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

/**
 * Timers as data. The poll interval is five minutes and the CONNECTING retry thirty seconds, so a
 * test that used real timers would either sleep for minutes or assert nothing about the delay.
 * Here the delay is a value the test reads, and firing the timer is a call the test makes.
 */
class FakeTimers {
  private nextId = 1;
  readonly pending = new Map<number, { ms: number; fn: () => void }>();

  set = (fn: () => void, ms: number): unknown => {
    const id = this.nextId;
    this.nextId += 1;
    this.pending.set(id, { ms, fn });
    return id;
  };

  clear = (handle: unknown): void => {
    this.pending.delete(handle as number);
  };

  /** The poll loop keeps exactly one timer outstanding once a request has settled. */
  only(): { ms: number; fn: () => void } {
    assert.equal(this.pending.size, 1, `expected one outstanding timer, saw ${this.pending.size}`);
    return [...this.pending.values()][0];
  }

  fire(): void {
    const [id, timer] = [...this.pending.entries()][0];
    this.pending.delete(id);
    timer.fn();
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

class Harness {
  readonly storage = new MemoryStorage();
  readonly timers = new FakeTimers();
  readonly requests: string[] = [];
  readonly delivered: PollOutcome[] = [];
  now = new Date('2026-09-07T12:04:00+10:00');
  /** What the relay answers next. Reassigned per test; the default is a healthy payload. */
  respond: (url: string) => Promise<Response> = async () => jsonResponse(DEMO_PAYLOAD);
  readonly poller: Poller;

  constructor(settings: Partial<StoredSettings> = {}, cached?: unknown) {
    this.storage.setItem(
      SETTINGS_KEY,
      JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5, ...settings }),
    );
    if (cached !== undefined) this.storage.setItem(CACHE_KEY, JSON.stringify(cached));
    this.poller = new Poller({
      storage: this.storage,
      clock: () => this.now,
      setTimer: this.timers.set,
      clearTimer: this.timers.clear,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        this.requests.push(url);
        return this.respond(url);
      }) as typeof fetch,
    });
  }

  /** Start and wait for the first attempt to settle. */
  async start(): Promise<void> {
    this.poller.start((outcome) => this.delivered.push(outcome));
    await this.poller.idle();
  }

  last(): PollOutcome {
    assert.ok(this.delivered.length > 0, 'nothing was delivered to the app at all');
    return this.delivered[this.delivered.length - 1];
  }

  cached(): unknown {
    const raw = this.storage.getItem(CACHE_KEY);
    return raw === null ? null : JSON.parse(raw);
  }
}

// ---- the URL (PLAN §3: `?refresh=1` asks the daemon to re-read upstream) -------

test('the usage path and the refresh query parameter are added to the stored origin (M9)', () => {
  assert.equal(usageUrl(RELAY, false), USAGE);
  assert.equal(usageUrl(RELAY, true), `${USAGE}?refresh=1`);
  assert.equal(usageUrl('https://desk.tail1234.ts.net:8787', false), 'https://desk.tail1234.ts.net:8787/usage.json');
  assert.throws(() => usageUrl('not a url', false), 'an unparseable base is a failure the caller reports');
});

// ---- boot: the cache is on screen before the network is even tried -------------

test('the cached payload is read back through the shared validator', () => {
  const storage = new MemoryStorage();
  assert.equal(readCachedPayload(storage), null, 'no cache is a normal boot, not an error');
  storage.setItem(CACHE_KEY, JSON.stringify(DEMO_PAYLOAD));
  assert.deepEqual(readCachedPayload(storage), DEMO_PAYLOAD);
});

test('a corrupt cache is discarded rather than crashing the boot', () => {
  const storage = new MemoryStorage();
  storage.setItem(CACHE_KEY, '{ not json');
  assert.equal(readCachedPayload(storage), null);
  // A well-formed JSON blob that is not a v1 payload is the same situation.
  storage.setItem(CACHE_KEY, JSON.stringify({ version: 2 }));
  assert.equal(readCachedPayload(storage), null);
});

test('a first fetch that fails still shows the cache the boot loaded', async () => {
  const h = new Harness({}, DEMO_PAYLOAD);
  h.respond = async () => {
    throw new TypeError('Failed to fetch');
  };
  await h.start();
  assert.deepEqual(h.last().payload, DEMO_PAYLOAD, 'the failure cleared the screen (PLAN T3.4)');
  assert.equal(h.last().errorCode, ERROR_NET);
});

// ---- the happy path -----------------------------------------------------------

test('a successful poll delivers the payload, clears the error and writes the cache', async () => {
  const h = new Harness();
  await h.start();
  assert.deepEqual(h.requests, [USAGE], 'the first poll must not ask for a forced refresh');
  assert.deepEqual(h.last().payload, DEMO_PAYLOAD);
  assert.equal(h.last().errorCode, null);
  assert.deepEqual(h.cached(), JSON.parse(JSON.stringify(DEMO_PAYLOAD)));
});

test('the delivered settings never carry the relay address (the app state is the display fields only)', async () => {
  const h = new Harness();
  await h.start();
  const settings = h.last().settings as unknown as Record<string, unknown>;
  assert.equal(settings.relayUrl, undefined, 'the relay address reached the app state');
  assert.equal(settings.pollIntervalMin, 5);
  // The whole record, not just the absence of the URL: `displaySettings` is a whitelist of one field
  // since T6b.2, so anything else appearing here would be a field that was never stripped.
  assert.deepEqual(Object.keys(settings), ['pollIntervalMin']);
});

// ---- every failure path keeps the last good payload (PLAN T3.4) ----------------

const FAILURES: ReadonlyArray<readonly [string, () => Promise<Response>, string]> = [
  [
    'a network error',
    async () => {
      throw new TypeError('Failed to fetch');
    },
    ERROR_NET,
  ],
  ['a 404 from the relay', async () => jsonResponse({}, 404), ERROR_NOT_FOUND],
  ['a 500 from the relay', async () => jsonResponse({}, 500), ERROR_NET],
  ['a body that is not JSON', async () => jsonResponse('<html>nope</html>'), ERROR_BAD_SCHEMA],
  [
    'a payload from a future contract version',
    async () => jsonResponse({ ...DEMO_PAYLOAD, version: 2 }),
    ERROR_BAD_SCHEMA,
  ],
  [
    'a payload whose shape does not match the contract',
    async () => jsonResponse({ ...DEMO_PAYLOAD, claude: { ok: true, source: 'statusline' } }),
    ERROR_BAD_SCHEMA,
  ],
];

for (const [label, respond, code] of FAILURES) {
  test(`${label} keeps the last good payload and reports \`${code}\``, async () => {
    const h = new Harness();
    await h.start(); // one good poll, so there IS a last good payload
    h.respond = respond;
    h.timers.fire();
    await h.poller.idle();

    assert.equal(h.last().errorCode, code);
    assert.deepEqual(h.last().payload, DEMO_PAYLOAD, 'the screen lost its data on a failed poll');
    assert.deepEqual(h.cached(), JSON.parse(JSON.stringify(DEMO_PAYLOAD)), 'a failure overwrote the cache');
  });

  test(`${label} with no cache at all leaves the app CONNECTING`, async () => {
    const h = new Harness();
    h.respond = respond;
    await h.start();
    assert.equal(h.last().payload, null, 'CONNECTING is payload === null (§7 V2)');
    assert.equal(h.last().errorCode, code);
  });
}

// ---- the schedule (PLAN T3.4 / §10.3(a) CONNECTING self-loop) ------------------

test('a successful poll is followed by the configured interval', async () => {
  const h = new Harness({ pollIntervalMin: 10 });
  await h.start();
  assert.equal(h.timers.only().ms, 10 * 60_000);
});

test('the default interval is five minutes', async () => {
  const h = new Harness();
  await h.start();
  assert.equal(h.timers.only().ms, 5 * 60_000);
});

test('CONNECTING retries every 30 seconds until it succeeds', async () => {
  const h = new Harness();
  h.respond = async () => {
    throw new TypeError('Failed to fetch');
  };
  await h.start();
  assert.equal(h.timers.only().ms, CONNECTING_RETRY_MS);

  // Still nothing cached, still failing: the fast retry has to stay fast.
  h.timers.fire();
  await h.poller.idle();
  assert.equal(h.timers.only().ms, CONNECTING_RETRY_MS);

  // …and the moment it succeeds it drops back to the configured interval.
  h.respond = async () => jsonResponse(DEMO_PAYLOAD);
  h.timers.fire();
  await h.poller.idle();
  assert.equal(h.timers.only().ms, 5 * 60_000);
});

test('a failure after a good poll keeps the normal interval, not the CONNECTING retry', async () => {
  const h = new Harness();
  await h.start();
  h.respond = async () => jsonResponse({}, 404);
  h.timers.fire();
  await h.poller.idle();
  assert.equal(h.timers.only().ms, 5 * 60_000, 'a stale-but-present screen is not CONNECTING');
});

test('an unconfigured relay URL is delivered without a request, then poke picks up a saved URL', async () => {
  const h = new Harness({ relayUrl: '' });
  await h.start();
  assert.deepEqual(h.requests, [], 'there is nothing to fetch until T3.5 supplies a URL');
  assert.equal(h.delivered.length, 1, 'the app was not told that setup is required');
  assert.deepEqual(h.last(), {
    payload: null,
    errorCode: null,
    settings: { pollIntervalMin: 5 },
    unconfigured: true,
  });
  // …and it keeps checking, so pasting the URL into the settings page is enough to connect.
  assert.equal(h.timers.only().ms, CONNECTING_RETRY_MS);

  h.storage.setItem(SETTINGS_KEY, JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 }));
  h.poller.poke();
  assert.equal(h.delivered.length, 2, 'poke did not deliver the configured snapshot immediately');
  assert.deepEqual(h.last(), {
    payload: null,
    errorCode: null,
    settings: { pollIntervalMin: 5 },
    unconfigured: false,
  });
  await h.poller.idle();
  assert.deepEqual(h.requests, [USAGE]);
  assert.equal(h.last().unconfigured, false);
});

test('the settings controller and poller share relay changes without stale snapshots', async () => {
  const h = new Harness();
  await h.start();
  const view: SettingsView = {
    showRelay: () => undefined,
    showPollInterval: () => undefined,
    showTestRow: () => undefined,
    showSaved: () => undefined,
  };
  const controller = new SettingsController(view, {
    storage: h.storage,
    onRelaySaved: () => h.poller.poke(),
  });
  controller.start();

  const beforeClear = h.delivered.length;
  await controller.editRelay('');
  await h.poller.idle();
  assert.equal(h.delivered.length, beforeClear + 1, 'clearing the relay delivered more than once');
  assert.equal(h.last().unconfigured, true, 'clearing the relay left the old payload on screen');

  const beforeReconnect = h.delivered.length;
  const reconnecting = controller.editRelay(RELAY);
  assert.equal(h.delivered.length, beforeReconnect + 1, 'the configured snapshot was not immediate');
  assert.equal(h.last().unconfigured, false);
  await reconnecting;
  await h.poller.idle();
  assert.equal(h.delivered.length, beforeReconnect + 2, 'the relay payload was not delivered after its snapshot');
  assert.deepEqual(h.last().payload, DEMO_PAYLOAD);
});

test('a queued poke corrects a configured snapshot when the relay is cleared before its attempt', async () => {
  const h = new Harness();
  await h.start();
  let release: (value: Response) => void = () => undefined;
  h.respond = () => new Promise<Response>((resolve) => void (release = resolve));
  h.timers.fire();
  await Promise.resolve();

  const beforePoke = h.delivered.length;
  h.poller.poke();
  assert.equal(h.delivered.length, beforePoke + 1);
  assert.equal(h.last().unconfigured, false);
  h.storage.setItem(SETTINGS_KEY, JSON.stringify({ relayUrl: '', pollIntervalMin: 5 }));

  release(jsonResponse(DEMO_PAYLOAD));
  await h.poller.idle();
  assert.equal(h.delivered.length, beforePoke + 2, 'the stale configured snapshot was not corrected');
  assert.equal(h.last().unconfigured, true);
});

test('clearing the relay during a fetch immediately delivers UNCONFIGURED and discards the old success', async () => {
  const h = new Harness();
  let release: (value: Response) => void = () => undefined;
  h.respond = () => new Promise<Response>((resolve) => void (release = resolve));
  h.poller.start((outcome) => h.delivered.push(outcome));
  await Promise.resolve();
  assert.deepEqual(h.requests, [USAGE], 'the held request never started');

  h.storage.setItem(SETTINGS_KEY, JSON.stringify({ relayUrl: '', pollIntervalMin: 5 }));
  h.poller.poke();
  assert.deepEqual(h.delivered, [
    {
      payload: null,
      errorCode: null,
      settings: { pollIntervalMin: 5 },
      unconfigured: true,
    },
  ]);

  release(jsonResponse(DEMO_PAYLOAD));
  await h.poller.idle();
  assert.equal(h.delivered.length, 1, 'the old result or queued poke redelivered after UNCONFIGURED');
  assert.equal(h.cached(), null, 'the old endpoint wrote its payload into the cache');
  h.poller.flush();
  assert.equal(h.cached(), null, 'the old endpoint became the poller last-good payload');
});

test('changing relay origin during a fetch snapshots last-good and discards the old endpoint result', async () => {
  const h = new Harness();
  await h.start();
  const oldPayload: UsagePayload = {
    ...DEMO_PAYLOAD,
    generatedAt: '2026-09-07T12:05:00+10:00',
  };
  let releaseOld: (value: Response) => void = () => undefined;
  h.respond = () => new Promise<Response>((resolve) => void (releaseOld = resolve));
  h.timers.fire();
  await Promise.resolve();

  const nextRelay = 'http://127.0.0.1:9797';
  let releaseNew: (value: Response) => void = () => undefined;
  h.respond = () => new Promise<Response>((resolve) => void (releaseNew = resolve));
  h.storage.setItem(SETTINGS_KEY, JSON.stringify({ relayUrl: nextRelay, pollIntervalMin: 5 }));
  h.poller.poke();
  assert.deepEqual(h.last(), {
    payload: DEMO_PAYLOAD,
    errorCode: null,
    settings: { pollIntervalMin: 5 },
    unconfigured: false,
  });

  releaseOld(jsonResponse(oldPayload));
  await tick();
  assert.deepEqual(h.requests, [USAGE, USAGE, `${nextRelay}/usage.json`]);
  assert.equal(
    h.delivered.some((outcome) => outcome.payload?.generatedAt === oldPayload.generatedAt),
    false,
    'the old endpoint payload was delivered',
  );
  assert.deepEqual(h.cached(), JSON.parse(JSON.stringify(DEMO_PAYLOAD)), 'the old endpoint replaced the cache');

  releaseNew(jsonResponse(DEMO_PAYLOAD));
  await h.poller.idle();
});

test('setting a relay from empty immediately delivers CONNECTING before the fetch completes', async () => {
  const h = new Harness({ relayUrl: '' });
  await h.start();
  assert.equal(h.last().unconfigured, true);

  let release: (value: Response) => void = () => undefined;
  h.respond = () => new Promise<Response>((resolve) => void (release = resolve));
  h.storage.setItem(SETTINGS_KEY, JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 }));
  h.poller.poke();
  assert.deepEqual(h.last(), {
    payload: null,
    errorCode: null,
    settings: { pollIntervalMin: 5 },
    unconfigured: false,
  });

  await tick();
  assert.deepEqual(h.requests, [USAGE]);
  assert.equal(h.delivered.length, 2, 'the pending fetch delivered before it was released');
  release(jsonResponse(DEMO_PAYLOAD));
  await h.poller.idle();
  assert.deepEqual(h.last().payload, DEMO_PAYLOAD);
});

// ---- Refresh (PLAN T3.4: `?refresh=1`, 10-second debounce) ---------------------

test('Refresh asks the daemon to re-read upstream', async () => {
  const h = new Harness();
  await h.start();
  await h.poller.refresh();
  assert.deepEqual(h.requests, [USAGE, `${USAGE}?refresh=1`]);
});

test('a second Refresh inside 10 seconds is swallowed', async () => {
  const h = new Harness();
  await h.start();
  await h.poller.refresh();
  h.now = new Date(h.now.getTime() + REFRESH_DEBOUNCE_MS - 1);
  await h.poller.refresh();
  assert.equal(h.requests.length, 2, 'the debounce let a second forced refresh through');
});

test('Refresh works again once the debounce window has passed', async () => {
  const h = new Harness();
  await h.start();
  await h.poller.refresh();
  h.now = new Date(h.now.getTime() + REFRESH_DEBOUNCE_MS);
  await h.poller.refresh();
  assert.equal(h.requests.length, 3);
  assert.equal(h.requests[2], `${USAGE}?refresh=1`);
});

test('a swallowed Refresh still settles, so the §7 V7 notice can come down', async () => {
  const h = new Harness();
  await h.start();
  await h.poller.refresh();
  await assert.doesNotReject(() => h.poller.refresh());
});

test('Refresh restarts the interval instead of leaving two loops running', async () => {
  const h = new Harness();
  await h.start();
  await h.poller.refresh();
  assert.equal(h.timers.pending.size, 1, 'a manual refresh left a second poll loop behind');
  assert.equal(h.timers.only().ms, 5 * 60_000);
});

// ---- foreground exit / teardown ------------------------------------------------

test('flush writes the last good payload for the next WebView to boot from', async () => {
  const h = new Harness();
  await h.start();
  h.storage.map.delete(CACHE_KEY); // as if the migrated WebView had never written one
  h.poller.flush();
  assert.deepEqual(h.cached(), JSON.parse(JSON.stringify(DEMO_PAYLOAD)));
});

test('flush with nothing fetched yet writes nothing', () => {
  const h = new Harness();
  h.poller.flush();
  assert.equal(h.cached(), null);
});

/** Let the microtask queue drain, so a dispatched host call has actually been made. */
const tick = (): Promise<void> => new Promise((resolve) => void setTimeout(resolve, 0));

test('T6b.4 rule 4 — the exit flush dispatches the host write now, not after the debounce', async () => {
  // `FOREGROUND_EXIT` can be followed by the WebView being suspended, so a write still inside the
  // store's 500 ms host debounce never leaves: the 2026-09-10 codex review measured zero host writes
  // after `flush()`. Nothing here ever fires a store timer — the write has to go out without one.
  const writes: Array<{ key: string; value: string }> = [];
  const host = new Map<string, string>([
    [SETTINGS_KEY, JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 5 })],
    [CACHE_KEY, JSON.stringify(DEMO_PAYLOAD)],
  ]);
  const storeTimers = new FakeTimers();
  const store = new BridgeStore(
    {
      setLocalStorage: async (key: string, value: string) => {
        writes.push({ key, value });
        host.set(key, value);
        return true;
      },
      getLocalStorage: async (key: string) => host.get(key) ?? '',
    },
    new MemoryStorage(),
    { setTimer: storeTimers.set, clearTimer: storeTimers.clear },
  );
  await store.hydrate([SETTINGS_KEY, CACHE_KEY]);
  // `assert.equal` on the length, not `deepEqual(writes, [])`: the latter is a type assertion and
  // narrows `writes` to `never[]` for the rest of the test.
  assert.equal(writes.length, 0, 'hydrating values the host already holds must not write them back');

  const timers = new FakeTimers();
  const poller = new Poller({
    storage: store,
    clock: () => new Date('2026-09-07T12:04:00+10:00'),
    setTimer: timers.set,
    clearTimer: timers.clear,
    // The relay is unreachable, so the only thing that can write the cache is the flush itself.
    fetchImpl: (async () => {
      throw new TypeError('Failed to fetch');
    }) as typeof fetch,
  });
  poller.start(() => undefined);
  await poller.idle();
  assert.equal(writes.length, 0, 'the failed poll wrote a cache entry of its own');

  // The control, so the assertion below is about the flush and not about the store writing eagerly:
  // an ordinary `setItem` — which is all the old flush did — waits for a timer that is never fired.
  store.setItem('quotalens.control', 'x');
  await tick();
  assert.equal(writes.length, 0, 'a debounced write left without its timer');

  poller.flush();
  await tick();
  const cached = writes.filter((write) => write.key === CACHE_KEY);
  assert.equal(cached.length, 1, `the exit flush never reached the host (writes: ${JSON.stringify(writes)})`);
  assert.deepEqual(JSON.parse(cached[0].value), JSON.parse(JSON.stringify(DEMO_PAYLOAD)));
  poller.stop();
});

test('stop cancels the loop', async () => {
  const h = new Harness();
  await h.start();
  h.poller.stop();
  assert.equal(h.timers.pending.size, 0, 'the poll timer survived teardown');
});

test('a poll that lands after stop delivers nothing', async () => {
  const h = new Harness();
  let release: (value: Response) => void = () => undefined;
  h.respond = () => new Promise<Response>((resolve) => (release = resolve));
  h.poller.start((outcome) => h.delivered.push(outcome));
  h.poller.stop();
  release(jsonResponse(DEMO_PAYLOAD));
  await h.poller.idle();
  assert.deepEqual(h.delivered, [], 'a late response redrew a page that had been torn down');
});

// ---- T6b.4: the store the poller reads is the hydrated one -----------------------

test('T6b.4 the poller polls the relay URL hydrated from the Even App', async () => {
  // D12's failure was the relay URL being gone after a restart. Once it comes back from the host
  // store, the poller has to see it — it re-reads the settings on every attempt, so the only thing
  // that matters is that the hydrated store is the one it was handed.
  const host = new Map<string, string>([
    [SETTINGS_KEY, JSON.stringify({ relayUrl: RELAY, pollIntervalMin: 10 })],
    [CACHE_KEY, JSON.stringify(DEMO_PAYLOAD)],
  ]);
  const store = new BridgeStore(
    {
      setLocalStorage: async () => true,
      getLocalStorage: async (key: string) => host.get(key) ?? '',
    },
    new MemoryStorage(),
  );
  await store.hydrate([SETTINGS_KEY, CACHE_KEY]);

  // The cache is on the glasses before the network is tried, and it came from the host store too.
  assert.deepEqual(readCachedPayload(store), DEMO_PAYLOAD);

  const requests: string[] = [];
  const timers = new FakeTimers();
  const poller = new Poller({
    storage: store,
    clock: () => new Date('2026-09-07T12:04:00+10:00'),
    setTimer: timers.set,
    clearTimer: timers.clear,
    fetchImpl: (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return jsonResponse(DEMO_PAYLOAD);
    }) as typeof fetch,
  });
  const delivered: PollOutcome[] = [];
  poller.start((outcome) => delivered.push(outcome));
  await poller.idle();

  assert.deepEqual(requests, [USAGE], 'the poller did not use the hydrated relay address');
  assert.equal(delivered.at(-1)?.settings.pollIntervalMin, 10, 'the hydrated interval was ignored');
  poller.stop();
});

// ---- the payload the real daemon sends ------------------------------------------

test('a payload with a null 5h window survives the round trip (the owner’s Codex account)', async () => {
  const h = new Harness();
  const oneRow: UsagePayload = {
    ...DEMO_PAYLOAD,
    codex: { ...DEMO_PAYLOAD.codex, fiveHour: null, credits: null },
  };
  h.respond = async () => jsonResponse(oneRow);
  await h.start();
  assert.equal(h.last().payload?.codex.fiveHour, null);
  assert.equal(h.last().errorCode, null);
});
