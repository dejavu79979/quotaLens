// Daemon configuration (PLAN.md T1.1 / T1.2 / T1.5 / M2 / M9).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Always bound. A second listener on the tailnet IPv4 is added from config.json (`readExtraHost`, PLAN M2). */
export const HOST = '127.0.0.1';
export const PORT = 8787;

/** ~/.quotalens — statusline capture (T1.2) and config.json with the tailnet host (M2 / M8). */
export const QUOTALENS_DIR = join(homedir(), '.quotalens');

/**
 * `QUOTALENS_*` environment overrides exist ONLY so the T1.5 degradation acceptance can be run against
 * the real daemon without touching the Keychain, /etc/hosts, or the network (see daemon/scripts/README.md).
 */
function envOverride(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v.length > 0 ? v : fallback;
}

/**
 * A URL override is honoured only when it points at loopback, and `sendsCredentials()` below then
 * refuses to attach the token to it. A token may leave this machine ONLY towards the provider's own
 * HTTPS endpoint (§6 rule 1); an unvalidated override would have shipped it anywhere, in clear text
 * (codex review 2026-09-08). Anything else falls back to the canonical URL.
 */
function loopbackOnlyOverride(name: string, canonical: string): string {
  const v = process.env[name];
  if (v === undefined || v.length === 0) return canonical;
  let host: string;
  try {
    host = new URL(v).hostname;
  } catch {
    return canonical;
  }
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
  if (!loopback) {
    console.error(`quotalens: ${name} must point at loopback; ignoring it and using the provider endpoint`);
    return canonical;
  }
  return v;
}

/** True only for the provider's own canonical endpoint: the only place a token may be sent (§6 rule 1). */
export function sendsCredentials(url: string, canonical: string): boolean {
  return url === canonical;
}

/** Written atomically by daemon/scripts/claude-statusline.sh; raw statusline stdin JSON (PLAN §10.1 D1). */
export const CLAUDE_STATUSLINE_PATH = join(QUOTALENS_DIR, 'claude.json');

// ---- T1.3 Claude oauth/usage fallback (PLAN T1.3, §6 rules 1–3) -------------------

/** statusline file newer than this is used directly; older → oauth fallback. */
export const CLAUDE_STATUSLINE_FRESH_MS = 30 * 60_000;

/** The only host a Claude OAuth token may ever reach (§6 rule 1). */
export const CLAUDE_OAUTH_CANONICAL_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_USAGE_URL = loopbackOnlyOverride('QUOTALENS_CLAUDE_OAUTH_URL', CLAUDE_OAUTH_CANONICAL_URL);
export const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';
/** Hard floor between two requests, also binding for `?refresh=1` (§6 rule 3). */
export const CLAUDE_OAUTH_MIN_INTERVAL_MS = 5 * 60_000;
/** Back-off after a 429 (§6 rule 3). */
export const CLAUDE_OAUTH_BACKOFF_MS = 15 * 60_000;
export const CLAUDE_OAUTH_TIMEOUT_MS = 10_000;

/** macOS: Claude Code keeps its OAuth credentials in the login Keychain under this service name. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';
/** Linux: plain file. Read-only in every code path (§6 rule 1). */
export const CLAUDE_CREDENTIALS_PATH = join(homedir(), '.claude', '.credentials.json');

// ---- T1.4 Codex app-server JSON-RPC + backend fallback (PLAN T1.4, §6 rules 1–3) ----------

/** `codex app-server` over stdio (JSON-lines JSON-RPC; `initialize` handshake required — probed 2026-09-08). */
export const CODEX_BIN = envOverride('QUOTALENS_CODEX_BIN', 'codex');
export const CODEX_APP_SERVER_ARGS = ['app-server'];
/** Per-request RPC timeout. */
export const CODEX_RPC_TIMEOUT_MS = 10_000;
/** Child restart back-off after it exits: 1 s → 2 s → 4 s … capped here; reset once a child completes `initialize`. */
export const CODEX_RESTART_BACKOFF_INITIAL_MS = 1_000;
export const CODEX_RESTART_BACKOFF_MAX_MS = 60_000;
/** A child that ignores SIGTERM for this long gets SIGKILL, so wedged children cannot pile up while the daemon runs. */
export const CODEX_KILL_GRACE_MS = 5_000;
/**
 * Hard floor between two upstream reads, binding for `?refresh=1` (implementer's call, T1.4 report):
 * the RPC is a local CLI call backed by the same backend as the CLI itself, so 1 min is the floor.
 */
export const CODEX_MIN_INTERVAL_MS = 60_000;
/** Back-off after a 429 from either the RPC or the backend fallback (§6 rule 3: Codex = 5 min). */
export const CODEX_BACKOFF_MS = 5 * 60_000;

/** Fallback: direct backend read with the CLI's own tokens (read-only, PLAN T1.4). */
export const CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json');
/** The only host a Codex token may ever reach (§6 rule 1). */
export const CODEX_BACKEND_CANONICAL_URL = 'https://chatgpt.com/backend-api/codex/usage';
export const CODEX_BACKEND_USAGE_URL = loopbackOnlyOverride('QUOTALENS_CODEX_BACKEND_URL', CODEX_BACKEND_CANONICAL_URL);
export const CODEX_BACKEND_TIMEOUT_MS = 10_000;

// ---- T1.5 aggregation + the one route (PLAN T1.5, §3 `?refresh=1`; M9 dropped the path secret) --

/** Daemon-side `?refresh=1` throttle: at most one real upstream refresh per minute (§3). */
export const REFRESH_THROTTLE_MS = 60_000;

/**
 * The §3 route (PLAN M9, 2026-09-11 owner ruling): no path secret. The tailnet is the only
 * authentication layer (§6 rule 4), Funnel is permanently off, and the payload is percentages.
 * Up to M8 this was `/u/<32-char secret>/usage.json`; that path now answers 404 like any other.
 */
export const USAGE_PATH = '/usage.json';

/** The address the phone pastes into the settings page: the origin only, the plugin adds the path. */
export function relayBase(host: string): string {
  return `http://${host}:${PORT}`;
}

/** `{ "host": "<tailnet IPv4>" }` — never committed (lives outside the repo). An older `secret` key is ignored. */
export const CONFIG_PATH = join(QUOTALENS_DIR, 'config.json');

/** The parsed config object, or null when the file is missing / not a JSON object (never throws). */
function readConfigObject(path: string): Record<string, unknown> | null {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
  return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/**
 * Atomic, owner-only write of a PATCH: 0700 dir, 0600 temp file, rename over the target. Keys the
 * patch does not name survive (a pre-M9 `secret` key stays where it is, unread).
 */
function writeConfig(path: string, patch: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...readConfigObject(path), ...patch }) + '\n', { mode: 0o600, flag: 'w' });
  renameSync(tmp, path);
}

/** Tailscale hands every node an IPv4 in the CGNAT block 100.64.0.0/10 — second octet 64..127. */
const TAILNET_IPV4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.(\d{1,3})\.(\d{1,3})$/;

/** The one rule `readExtraHost` and the installer's `setup.ts` share: a literal tailnet IPv4, nothing else. */
export function isTailnetIPv4(host: unknown): host is string {
  return typeof host === 'string' && TAILNET_IPV4.test(host) && !host.split('.').some((o) => Number(o) > 255);
}

/**
 * M8 T8.2: the installer writes the tailnet address here. Refused (returns false, file untouched)
 * for anything `readExtraHost` would refuse, so the two can never disagree about what a host is.
 */
export function writeExtraHost(host: string, path: string = CONFIG_PATH): boolean {
  if (!isTailnetIPv4(host)) return false;
  writeConfig(path, { host });
  return true;
}

/**
 * PLAN M2 (2026-09-09 owner ruling): the daemon always binds loopback, and ALSO binds the address in
 * config.json's `host` when — and only when — it is a literal tailnet IPv4. Anything else (`0.0.0.0`,
 * a LAN address, a hostname) is refused here so a typo cannot open the port to the Wi-Fi, and the
 * refusal is logged so the owner sees why the tailnet URL does not answer. Loopback is not "extra".
 */
export function readExtraHost(path: string = CONFIG_PATH): string | null {
  const host = readConfigObject(path)?.host;
  if (host === undefined) return null;
  if (!isTailnetIPv4(host)) {
    // The rejected value is NOT echoed: nothing pasted here is expected to be sensitive since M9,
    // but a stray value in a 644 launchd log is still noise nobody asked for. The type and a length
    // are enough for the owner to spot the typo.
    console.error(`quotalens: config.json "host" must be this machine's tailnet IPv4 (100.64.0.0/10); ignoring it (${typeof host}, ${typeof host === 'string' ? `${host.length} chars` : 'not a string'})`);
    return null;
  }
  return host;
}
