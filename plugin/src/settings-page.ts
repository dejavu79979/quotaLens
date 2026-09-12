// QuotaLens plugin — the phone-side settings page (PLAN T3.5, §7 phone side tokens, §7 V8; M9).
//
// The page is split in two so it can be tested without a DOM: `SettingsController` holds every
// rule (the interval choice, save-or-say-so, Test connection) and talks to a narrow `SettingsView`;
// `mountSettingsPage` builds the markup and adapts it to that view. The repo's runner is
// `tsx --test` with no jsdom, so the rules are covered by tests and the markup is checked by eye
// through `plugin/settings-preview.html` (PLAN T3.5 acceptance).
//
// M9 (2026-09-11 owner ruling): the relay address is the daemon's origin, `http://<tailnet IP>:8787`,
// and nothing in it is secret. Failures are still reported as short codes (§7 V2 vocabulary) —
// that keeps the phone and the glasses naming the same failure the same way.
import { parseUsagePayload } from '@quotalens/shared';
import { usageUrl } from './poll.ts';
import {
  commitSettings,
  loadSettings,
  parseSettings,
  POLL_INTERVAL_CHOICES,
  type SaveOutcome,
  type SettingsField,
  type StorageLike,
  type StoredSettings,
} from './settings.ts';

/** §7 V8: the one row above the button. `idle` is the state before the button has ever been used. */
export type TestRow =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; ms: number }
  | { kind: 'fail'; code: string };

/**
 * §7 V8's notice row: one of the four outcomes, or `null` for the blank row.
 *
 * `null` is not a fifth message — it is the absence of one, the state the row is in before anything
 * has been saved and the state it goes back to while a newer value is on its way to the host. The
 * row is a promise about the value on screen, so no answer is the only honest thing to show while
 * that value has no answer yet (PLAN T6b.4 spec item 3).
 */
export type SavedRow = SaveOutcome | null;

/** Everything the controller can paint. Deliberately tiny: it is the whole seam to the DOM. */
export interface SettingsView {
  showRelay(text: string): void;
  showPollInterval(min: number): void;
  showTestRow(row: TestRow): void;
  /** Anything but `persisted` is a value the next launch may not have, and the user is told so. */
  showSaved(row: SavedRow): void;
}

export interface TestDeps {
  fetch: typeof fetch;
  /** Monotonic milliseconds; injected so the round trip is measurable in a test. */
  now: () => number;
}

export interface ControllerDeps extends Partial<TestDeps> {
  storage?: StorageLike;
  /** Wake the poller after any relay change, including clearing it (§7 V10). */
  onRelaySaved?: () => void;
}

/** A relay that never answers must not leave the row on `Testing…` for ever. */
export const TEST_TIMEOUT_MS = 10_000;

/** §7 phone side (M9): the field's label, placeholder and the hint under it, verbatim. */
export const RELAY_LABEL = 'Relay address';
export const RELAY_PLACEHOLDER = 'http://100.x.y.z:8787';
export const RELAY_HINT = "Your desktop's tailnet address — the installer prints it.";

/** §7 V8 verbatim: `✓ <ms> ms` / `✗ <error>`. `idle` prints nothing — an empty row, not a placeholder. */
export function formatTestRow(row: TestRow): string {
  switch (row.kind) {
    case 'idle':
      return '';
    case 'busy':
      return 'Testing…';
    case 'ok':
      return `✓ ${row.ms} ms`;
    case 'fail':
      return `✗ ${row.code}`;
  }
}

/**
 * §7 V8's notice row, verbatim (PLAN T6b.4 spec item 3).
 *
 * Only the Even App's own store survives the packaged app being closed and reopened, so plain
 * `Saved` is reserved for a write it acknowledged. The browser-only line is the honest answer while
 * the glasses are not connected — which is exactly when the owner is pasting the relay address —
 * and it says what to do about it rather than pretending the value is safe.
 */
export function savedRowText(outcome: SaveOutcome): string {
  switch (outcome) {
    case 'persisted':
      return 'Saved';
    case 'browserOnly':
      return 'Saved (browser only — connect the glasses to keep it)';
    case 'refused':
      return 'Not saved — the Even App refused to store it';
    case 'blocked':
      return 'Not saved — this browser is blocking storage';
  }
}

/**
 * Failures carry a short code, never the exception message. The codes are §7 V2's vocabulary
 * (`net err` / `bad schema`), so the phone and the glasses name the same failure the same way.
 */
function failureCode(error: unknown): string {
  const aborted =
    error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
  return aborted ? 'timeout' : 'net err';
}

/**
 * One fetch of `<relay base>/usage.json`, resolved into the §7 V8 row. Never rejects: the button
 * is on the settings page, and a rejected promise there is an unhandled rejection.
 *
 * The response is run through the shared validator, so a host that answers 200 with something
 * other than a v1 payload reads as `bad schema` rather than a false ✓.
 */
export async function testConnection(relayBase: string, deps: TestDeps): Promise<TestRow> {
  if (relayBase.trim() === '') return { kind: 'fail', code: 'no relay address' };
  let target: string;
  try {
    target = usageUrl(relayBase, false);
  } catch {
    return { kind: 'fail', code: 'net err' };
  }
  const started = deps.now();
  try {
    const response = await deps.fetch(target, {
      cache: 'no-store',
      signal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    });
    // Measured at the response, not after the body: `✓ <ms>` is the round trip to the relay, which
    // is what the owner is testing. The body is a few hundred bytes and would only add noise.
    const elapsed = Math.round(deps.now() - started);
    if (!response.ok) return { kind: 'fail', code: `HTTP ${response.status}` };
    try {
      parseUsagePayload(await response.json());
    } catch {
      return { kind: 'fail', code: 'bad schema' };
    }
    return { kind: 'ok', ms: elapsed };
  } catch (error) {
    return { kind: 'fail', code: failureCode(error) };
  }
}

/**
 * The settings page's behaviour, with no DOM in it.
 *
 * Every change writes through to storage immediately — there is no Save button in §7 frame D, so
 * "did it save?" is answered by the notice line instead. Since T6b.4 that answer waits for the Even
 * App: the value is live for this session as soon as the change lands, but the row only says `Saved`
 * once the host has acknowledged it, because the row is a promise about the NEXT launch — and only
 * the NEWEST change's acknowledgement may paint it, since the row can only promise what is on screen.
 */
export class SettingsController {
  readonly view: SettingsView;
  private storage: StorageLike | undefined;
  private readonly deps: TestDeps;
  private readonly onRelaySaved: (() => void) | undefined;
  private state: StoredSettings;
  private inFlight: Promise<TestRow> | null = null;
  /**
   * The fields the owner changed in THIS session, and only those (PLAN T6b.4 rule 9).
   *
   * Kept as the edits rather than as a flag because the page's copy of everything else can be
   * out of date — it is mounted and handed the store before the hydrate — and a control must write
   * what it changed, not the whole record as the page last saw it.
   *
   * Held as given, not as validated: a value `parseSettings` rejects is rejected again on every
   * merge, so the page keeps showing the same fallback it showed when the control was used.
   */
  private edits: Partial<StoredSettings> = {};
  /**
   * Which commit the notice row is allowed to answer for (PLAN T6b.4 spec item 3).
   *
   * Same rule as §7 V7's `refreshing…` generation in `app.ts`, and it exists for the same reason:
   * two commits can be outstanding at once — a keystroke's write is still with the host when a
   * press starts its own — and the acks come back in whatever order the host answers them. The
   * 2026-09-10 codex review found the older ack painting `Saved` over the NEWER value, which the
   * host had not answered for and might still refuse.
   */
  private saveGeneration = 0;
  /** What the row is showing, so a commit knows whether it has a stale promise to take down. */
  private savedShown: SavedRow = null;

  constructor(view: SettingsView, deps: ControllerDeps = {}) {
    this.view = view;
    this.storage = deps.storage;
    this.deps = {
      fetch: deps.fetch ?? ((input, init) => globalThis.fetch(input, init)),
      now: deps.now ?? (() => performance.now()),
    };
    this.onRelaySaved = deps.onRelaySaved;
    this.state = this.read();
  }

  get settings(): StoredSettings {
    return { ...this.state };
  }

  /**
   * Has the owner changed anything since this page was mounted? PLAN T6b.4 rule 9.
   *
   * The page goes up on browser storage before the bridge exists, because that is exactly when the
   * owner pastes the relay address — so their value is in the browser mirror and NOT in the store
   * that hydrate is about to fill. `main.ts` passes this on as a dirty key, which is what stops the
   * host's older copy replacing a value typed a second earlier.
   */
  get touched(): boolean {
    return this.editedFields.length > 0;
  }

  /**
   * WHICH fields, not just whether one of them changed — PLAN T6b.4 rule 9 per field.
   *
   * `touched` alone was doing both jobs, and the 2026-09-10 codex review found what that costs: one
   * press on the interval segments made the page's whole blob outrank the host's, so an empty
   * `relayUrl` the page had not hydrated yet went over a configured one. `main.ts` hands these names
   * to the store's merge, so the hydrate keeps the fields the owner touched and takes the rest.
   *
   * The keys of a `Partial<StoredSettings>` are by construction fields of `StoredSettings`, which is
   * the one thing `Object.keys` cannot say in its type.
   */
  get editedFields(): readonly SettingsField[] {
    return Object.keys(this.edits) as SettingsField[];
  }

  /** Paint the stored values. Called once, after the view exists; the read happened in the ctor. */
  start(): void {
    this.paint();
    this.view.showTestRow({ kind: 'idle' });
  }

  /**
   * PLAN T6b.4 boot order: the page goes up on browser storage, before `waitForEvenAppBridge()` has
   * resolved. Once the host-backed store exists it replaces this one, and the page re-reads.
   *
   * A repaint, never a save: nothing is written, so the notice row stays as it was.
   */
  useStorage(storage: StorageLike): void {
    this.storage = storage;
    this.resync();
  }

  /**
   * Read the store again and repaint — what the boot calls once the hydrate has answered (PLAN
   * T6b.4 rules 2 and 9; `boot.ts`'s `SettingsSink`).
   *
   * `useStorage` alone was not enough and this is the 2026-09-10 codex finding: rule 10 puts the
   * first glasses page in FRONT of the hydrate, so the store `main.ts` hands over at that point is
   * still empty, and on the packaged app (empty browser mirror, relay address only on the host) the
   * page stayed blank over an address the hydrate recovered milliseconds later.
   *
   * Rule 9 decides the collisions: a field the owner has touched in this session is theirs and is
   * kept, and the hydrated values fill the ones they have not. Nothing is written here.
   */
  resync(): void {
    this.state = this.merge();
    this.paint();
  }

  /**
   * The field owns its own text while it is being typed in, so this only stores. The value is
   * normalised on the way in (`parseSettings`), and the field shows the normalised form on blur.
   *
   * PLAN T6b.4 rule 8: a keystroke touches memory and the browser mirror, and nothing else. The
   * host write leaves once the typing stops — every character used to be its own round trip to the
   * Even App, queued in front of the next glasses redraw on the one serial link they share.
   */
  editRelay(text: string): Promise<void> {
    return this.persist({ relayUrl: text }, false);
  }

  /** M9: on blur the field shows what was actually stored — `100.x.y.z` → `http://100.x.y.z:8787`. */
  blurRelay(): void {
    this.view.showRelay(this.state.relayUrl);
  }

  /** An interval off the §7 menu falls back to the default — `parseSettings` is the only judge. */
  setPollInterval(min: number): Promise<void> {
    // The stored state is updated synchronously inside `persist`, so the segment lights up on the
    // press; only the notice row waits for the Even App to answer.
    const saving = this.persist({ pollIntervalMin: min }, true);
    this.view.showPollInterval(this.state.pollIntervalMin);
    return saving;
  }

  /**
   * §7 V8. The row goes `Testing…` before the fetch starts, so the button is never silent, and a
   * second press while one is in flight joins the first rather than starting another.
   */
  test(): Promise<TestRow> {
    if (this.inFlight !== null) return this.inFlight;
    this.view.showTestRow({ kind: 'busy' });
    // The row answers for the address that was on screen when the request went out (codex
    // stop-gate 2026-09-11): if the owner edits the field while it is in flight, a ✓ for the old
    // address would sit under the new one as if it had been checked. Same generation rule as `Saved`.
    const startedAt = this.saveGeneration;
    const run = testConnection(this.state.relayUrl, this.deps).then((row) => {
      this.inFlight = null;
      this.view.showTestRow(this.saveGeneration === startedAt ? row : { kind: 'idle' });
      return row;
    });
    this.inFlight = run;
    return run;
  }

  private read(): StoredSettings {
    return loadSettings(this.storage);
  }

  /**
   * What the record should be right now: whatever the store holds, with this session's edits on top
   * (PLAN T6b.4 rule 9). `parseSettings` in `loadSettings` and again here, so an edit is validated
   * the same way a stored value is.
   */
  private merge(): StoredSettings {
    return parseSettings({ ...this.read(), ...this.edits });
  }

  /**
   * The state moves before the first `await`, so the page and the poller see the new value at once;
   * the notice row is the only thing that waits for the Even App (PLAN T6b.4 spec item 3).
   *
   * A PATCH, not a record: the page's copy of the fields the control did not touch can be older than
   * the store's — it is mounted, and handed the store, before the hydrate — so writing `this.state`
   * wholesale meant one press on the interval segments put `{"relayUrl":""}` over the address the
   * hydrate had just brought back from the host (the 2026-09-10 codex review, with `Saved` on the
   * row). Merging over a fresh read makes each control write only what it changed, whether or not
   * anything re-synced the page first. `settings.ts` is still the only reader and writer.
   *
   * `flush` is the difference between a press and a keystroke (rule 8): a discrete control is a
   * save and gets its answer now, while typing rides the store's trailing debounce.
   */
  private async persist(patch: Partial<StoredSettings>, flush: boolean): Promise<void> {
    // Recorded before the merge, so this field wins every later re-sync too (rule 9).
    this.edits = { ...this.edits, ...patch };
    this.state = this.merge();
    const generation = (this.saveGeneration += 1);
    // There is a newer value on screen than the one the row is promising, and no answer for it yet.
    this.showSavedRow(null);
    const committing = commitSettings(this.state, this.storage, { flush });
    // `commitSettings` writes synchronously before waiting for the host ack. The poller's poke reads
    // that store, so it must run after the write but before the ack.
    if (patch.relayUrl !== undefined) this.onRelaySaved?.();
    const outcome = await committing;
    // Checked HERE rather than before the call, as §7 V7's generation rule is: the ack is what
    // arrives late, so only the state at the moment it lands can say whether it still speaks for
    // what the page is showing. A superseded ack is dropped, not painted — the write that replaced
    // it has its own ack coming, and that one answers for the value the owner can see.
    if (generation !== this.saveGeneration) return;
    this.showSavedRow(outcome);
  }

  /**
   * PLAN T6b.4 rule 14: the store has learned that the host's durable copy of the settings does, or
   * no longer does, match what this page is showing — a repair write was refused after a late write
   * had put an older value back, or a repair finally landed. The row is a promise about the next
   * launch, so it follows the durable copy, not the last commit's answer. Only a row that is already
   * making a promise is touched: before the first save there is nothing to take down.
   */
  durabilityChanged(durable: boolean): void {
    if (this.savedShown === null) return;
    this.showSavedRow(durable ? 'persisted' : 'refused');
  }

  /** One writer for the row, so `savedShown` cannot drift from what the view is displaying. */
  private showSavedRow(row: SavedRow): void {
    if (row === this.savedShown) return;
    this.savedShown = row;
    this.view.showSaved(row);
  }

  private paint(): void {
    this.view.showRelay(this.state.relayUrl);
    this.view.showPollInterval(this.state.pollIntervalMin);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

/**
 * Build the page inside `root` and return the controller driving it.
 *
 * §7 phone side tokens live in `settings-page.css`; the classes here are the only contract between the
 * two. Nothing in this function knows a host or a port: the relay address is one string from the
 * field to `settings.ts`, which normalises it (PLAN §7 phone side, M9).
 */
export function mountSettingsPage(root: HTMLElement, deps: ControllerDeps = {}): SettingsController {
  root.classList.add('qs-root');
  root.replaceChildren();

  const page = el('div', 'qs-page');
  page.append(el('h1', 'qs-title', 'QuotaLens'));

  // — Relay address (M9: the daemon's origin, nothing secret) ———————————
  const relayCard = el('section', 'qs-card');
  const relayLabel = el('label', 'qs-label', RELAY_LABEL);
  const relayInput = el('input', 'qs-input');
  relayInput.type = 'text';
  relayInput.id = 'qs-relay';
  relayInput.spellcheck = false;
  relayInput.autocomplete = 'off';
  relayInput.setAttribute('autocapitalize', 'off');
  relayInput.setAttribute('inputmode', 'url');
  relayInput.placeholder = RELAY_PLACEHOLDER;
  relayLabel.htmlFor = relayInput.id;
  const relayHint = el('p', 'qs-hint', RELAY_HINT);
  relayCard.append(relayLabel, relayInput, relayHint);

  // — Poll interval ————————————————————————————————————————————
  const pollCard = el('section', 'qs-card');
  const pollRow = el('div', 'qs-row');
  pollRow.append(el('span', 'qs-row-name', 'Poll interval'));
  const pollGroup = el('div', 'qs-segments');
  pollGroup.setAttribute('role', 'group');
  pollGroup.setAttribute('aria-label', 'Poll interval');
  const pollButtons = POLL_INTERVAL_CHOICES.map((min) => {
    const button = el('button', 'qs-segment', `${min} min`);
    button.type = 'button';
    button.addEventListener('click', () => void controller.setPollInterval(min));
    pollGroup.append(button);
    return { min, button };
  });
  pollRow.append(pollGroup);
  pollCard.append(pollRow);
  // T6b.2 (2026-09-10 owner ruling): §7 V3's threshold row and its stepper are gone, so the poll
  // interval is the only control in this card and the settings contract is two fields.

  // — Test connection ——————————————————————————————————————————
  // §7 V8: the result row sits above the button.
  const testRow = el('p', 'qs-test-row');
  testRow.setAttribute('role', 'status');
  const testButton = el('button', 'qs-button', 'Test connection');
  testButton.type = 'button';
  testButton.addEventListener('click', () => void controller.test());
  const savedRow = el('p', 'qs-saved');
  savedRow.setAttribute('role', 'status');

  page.append(relayCard, pollCard, testRow, testButton, savedRow);
  root.append(page);

  const view: SettingsView = {
    showRelay(text) {
      relayInput.value = text;
    },
    showPollInterval(min) {
      for (const choice of pollButtons) {
        const selected = choice.min === min;
        choice.button.classList.toggle('is-selected', selected);
        choice.button.setAttribute('aria-pressed', String(selected));
      }
    },
    showTestRow(row) {
      testRow.textContent = formatTestRow(row);
      testRow.dataset.kind = row.kind;
      testButton.disabled = row.kind === 'busy';
    },
    showSaved(row) {
      // `null` empties the row rather than writing a fifth sentence into it — §7 V8 has four, and
      // a commit with no answer yet has nothing to say. `min-height` in `settings-page.css` keeps
      // the row's space, so nothing below it moves while a write is in flight.
      savedRow.textContent = row === null ? '' : savedRowText(row);
      savedRow.dataset.kind =
        row === null ? 'idle' : row === 'persisted' ? 'ok' : row === 'browserOnly' ? 'partial' : 'fail';
    },
  };

  const controller = new SettingsController(view, deps);

  relayInput.addEventListener('input', () => void controller.editRelay(relayInput.value));
  relayInput.addEventListener('blur', () => controller.blurRelay());

  controller.start();
  return controller;
}
