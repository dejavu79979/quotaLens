// T3.2 stand-in data. The relay does not exist for the plugin yet (T3.4 adds poll.ts), so the
// screens are driven by these hardcoded payloads — in the dev build and in the layout tests alike,
// so that what the tests measure is what the simulator draws.
//
// Every payload goes through `parseUsagePayload` from `@quotalens/shared`: a fixture that the real
// contract would reject is worse than no fixture, because the layout would be tuned to data the
// daemon can never send.
import { parseUsagePayload, type UsagePayload } from '@quotalens/shared';

/** §7's reference moment: `now` = 12:04 on Mon 2026-09-07 (+10:00, matching §3's example). */
export const DEMO_NOW = new Date('2026-09-07T12:04:00+10:00');

/**
 * §7 "merged page" frame G1 — one payload, both sections. The two tools carry independent `fetchedAt`, so
 * at 12:04 the CLAUDE section row reads `12:03 · ok` (21s old) and CODEX reads `11:41 · stale 23m`:
 * the per-tool staleness §3 asks for, on one page, with the machine still LIVE because one section is
 * fresh.
 *
 * Codex's shape is the owner's real account (T1.4): weekly only, no 5h window and no credits, so its
 * section is one data row. Claude's `weeklySonnet.resetsAt` is null, which is what makes the third
 * Claude row read `8% █▒▒…` with no `resets` suffix (§7 V4). Card = 2 section + 3 + 1 = 6 rows.
 */
export const DEMO_PAYLOAD: UsagePayload = parseUsagePayload({
  version: 1,
  generatedAt: '2026-09-07T12:04:00+10:00',
  claude: {
    ok: true,
    source: 'statusline',
    fiveHour: { usedPct: 63, resetsAt: '2026-09-07T14:20:00+10:00' },
    weekly: { usedPct: 28, resetsAt: '2026-09-10T09:00:00+10:00' },
    weeklySonnet: { usedPct: 8, resetsAt: null },
    credits: null,
    fetchedAt: '2026-09-07T12:03:41+10:00',
  },
  codex: {
    ok: true,
    source: 'app_server',
    fiveHour: null,
    weekly: { usedPct: 64, resetsAt: '2026-09-14T08:00:00+10:00' },
    weeklySonnet: null,
    credits: null,
    fetchedAt: '2026-09-07T11:41:00+10:00',
  },
  ext: { claudeScopedModel: 'Fable' },
});

/**
 * §7 V1 (re-judged 2026-09-10) / §3 `source:"none"`: the daemon has never succeeded for EITHER tool,
 * so there is no section to draw — frame F1''' is the two-line card `No usage data` / `tap refresh`.
 * Staleness is not computed at all.
 */
export const NO_DATA_PAYLOAD: UsagePayload = parseUsagePayload({
  version: 1,
  generatedAt: '2026-09-07T12:04:00+10:00',
  claude: { ok: false, source: 'none', fiveHour: null, weekly: null, weeklySonnet: null, credits: null, fetchedAt: null },
  codex: { ok: false, source: 'none', fiveHour: null, weekly: null, weeklySonnet: null, credits: null, fetchedAt: null },
  ext: {},
});

/**
 * The M5 S9/S10 worst case, which is ALSO §7 "merged page" frame G2's three-plus-three worst case: every
 * window present on both tools, so the card is 2 section rows + 3 + 3 = **8 rows**, the hard maximum
 * (`MAX_CARD_ROWS`) that fills the band between header and footer exactly (card y=27, h=234).
 *
 * It is sized so the layout tests measure the longest line the UI can produce: 100% and 99% (a full
 * and a nearly-full 12-cell bar, and the widest percentage the percent column has to hold) plus a
 * `resets Wed 23:59` suffix that carries a weekday. These were also §7 V3's marker cases; T6b.2
 * withdrew the marker and they stay, because the widths are what the S9/S10 tests measure. Codex here
 * also exercises the rows the owner's account lacks — a 5h window with no reset time (§7 V4) and a
 * credits row.
 */
export const EXTREME_PAYLOAD: UsagePayload = parseUsagePayload({
  version: 1,
  generatedAt: '2026-09-07T12:04:00+10:00',
  claude: {
    ok: true,
    source: 'oauth_usage',
    fiveHour: { usedPct: 100, resetsAt: '2026-09-09T23:59:00+10:00' },
    weekly: { usedPct: 0, resetsAt: '2026-09-09T23:59:00+10:00' },
    weeklySonnet: { usedPct: 99, resetsAt: '2026-09-09T23:59:00+10:00' },
    credits: null,
    fetchedAt: '2026-09-07T12:03:41+10:00',
  },
  codex: {
    ok: true,
    source: 'app_server',
    fiveHour: { usedPct: 1, resetsAt: null },
    weekly: { usedPct: 100, resetsAt: '2026-09-09T23:59:00+10:00' },
    weeklySonnet: null,
    credits: { remainingUsd: 4.2 },
    fetchedAt: '2026-09-07T12:03:41+10:00',
  },
  ext: { claudeScopedModel: 'Sonnet' },
});

/** §3 `source:"none"` for one tool — every field null, as the contract requires. */
const NEVER_FETCHED = {
  ok: false,
  source: 'none',
  fiveHour: null,
  weekly: null,
  weeklySonnet: null,
  credits: null,
  fetchedAt: null,
} as const;

/**
 * §7 V1 frame F1' — Codex has never fetched, so ONLY the CLAUDE section is drawn (section row
 * included). Card = 1 section + 3 data = 4 rows; nothing on the page says Codex exists.
 */
export const CLAUDE_ONLY_PAYLOAD: UsagePayload = parseUsagePayload({
  version: 1,
  generatedAt: '2026-09-07T12:04:00+10:00',
  claude: {
    ok: true,
    source: 'statusline',
    fiveHour: { usedPct: 63, resetsAt: '2026-09-07T14:20:00+10:00' },
    weekly: { usedPct: 28, resetsAt: '2026-09-10T09:00:00+10:00' },
    weeklySonnet: { usedPct: 8, resetsAt: null },
    credits: null,
    fetchedAt: '2026-09-07T12:03:41+10:00',
  },
  codex: NEVER_FETCHED,
  ext: { claudeScopedModel: 'Fable' },
});

/** §7 V1 frame F1'' — the mirror case: Claude has never fetched, so only CODEX is drawn (2 rows). */
export const CODEX_ONLY_PAYLOAD: UsagePayload = parseUsagePayload({
  version: 1,
  generatedAt: '2026-09-07T12:04:00+10:00',
  claude: NEVER_FETCHED,
  codex: {
    ok: true,
    source: 'app_server',
    fiveHour: null,
    weekly: { usedPct: 64, resetsAt: '2026-09-14T08:00:00+10:00' },
    weeklySonnet: null,
    credits: null,
    fetchedAt: '2026-09-07T11:41:00+10:00',
  },
  ext: {},
});
