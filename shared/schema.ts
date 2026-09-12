// QuotaLens shared contract — the ONLY definition of UsagePayload (PLAN.md §3, §10.2).
// daemon and plugin both import this file; never copy these types elsewhere.
// Zero dependencies on purpose (runs under tsx in the daemon and Vite in the plugin).

export type SourceKind =
  | 'statusline'
  | 'oauth_usage'
  | 'app_server'
  | 'backend_api'
  | 'cache'
  | 'none';

export type ToolId = 'claude' | 'codex';

export interface UsageWindow {
  usedPct: number;
  /** Server-returned value; never computed locally (PLAN §6 rule 6). null when the server gave none (§7 V4). */
  resetsAt: string | null;
}

export interface Credits {
  remainingUsd: number;
}

export interface ToolUsage {
  ok: boolean;
  source: SourceKind;
  fiveHour: UsageWindow | null;
  weekly: UsageWindow | null;
  weeklySonnet: UsageWindow | null;
  credits: Credits | null;
  fetchedAt: string | null;
}

export interface UsagePayload {
  version: 1;
  generatedAt: string;
  claude: ToolUsage;
  codex: ToolUsage;
  /**
   * v2 reserve; unknown keys are passed through and must be ignored by consumers.
   * The only defined v1 key is `ext[EXT_CLAUDE_SCOPED_MODEL]`: `string | null`.
   */
  ext: Record<string, unknown>;
}

/**
 * PLAN §3: server-returned display name of the model behind `claude.weeklySonnet`
 * (e.g. "Fable", or "Sonnet" when the value came from `seven_day_sonnet`); null when unknown.
 * The plugin's frame A third-row label reads this and falls back to "Sonnet" when absent.
 */
export const EXT_CLAUDE_SCOPED_MODEL = 'claudeScopedModel';

// ---- staleness constants (PLAN §3 "threshold formula") -------------------------------

/** Upstream cadence per tool, in minutes: Claude = oauth fallback poll (T1.3), Codex = RPC period (T1.4). */
export const UPSTREAM_INTERVAL_MIN: Readonly<Record<ToolId, number>> = {
  claude: 15,
  codex: 5,
};

/** staleThreshold(tool) = max(2 × plugin poll interval, upstream interval + 5). */
export function staleThresholdMin(tool: ToolId, pollIntervalMin: number): number {
  return Math.max(2 * pollIntervalMin, UPSTREAM_INTERVAL_MIN[tool] + 5);
}

// ---- runtime validation ------------------------------------------------------

/** Allowed `source` literals per tool (PLAN §3 example comments). */
const SOURCE_KINDS_BY_TOOL: Readonly<Record<ToolId, ReadonlySet<string>>> = {
  claude: new Set<SourceKind>(['statusline', 'oauth_usage', 'cache', 'none']),
  codex: new Set<SourceKind>(['app_server', 'backend_api', 'cache', 'none']),
};

function fail(path: string, msg: string): never {
  throw new Error(`UsagePayload invalid at ${path}: ${msg}`);
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function parseString(x: unknown, path: string): string {
  if (typeof x !== 'string' || x.length === 0) fail(path, 'expected non-empty string');
  return x;
}

function parseNumber(x: unknown, path: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) fail(path, 'expected finite number');
  return x;
}

function parseIsoDate(x: unknown, path: string): string {
  const s = parseString(x, path);
  if (Number.isNaN(Date.parse(s))) fail(path, 'expected ISO 8601 date-time');
  return s;
}

function parseWindow(x: unknown, path: string): UsageWindow | null {
  if (x === null) return null;
  if (!isRecord(x)) fail(path, 'expected object or null');
  return {
    usedPct: parseNumber(x.usedPct, `${path}.usedPct`),
    resetsAt: x.resetsAt === null ? null : parseIsoDate(x.resetsAt, `${path}.resetsAt`),
  };
}

function parseCredits(x: unknown, path: string): Credits | null {
  if (x === null) return null;
  if (!isRecord(x)) fail(path, 'expected object or null');
  return { remainingUsd: parseNumber(x.remainingUsd, `${path}.remainingUsd`) };
}

/**
 * Parse one ToolUsage and enforce the PLAN §3 `source`/`ok` consistency rules:
 *  - `none`  → ok:false, every window/credits/fetchedAt null (never fetched)
 *  - `cache` → ok:false, fetchedAt non-null (values carried over from lastGood)
 *  - real source → ok:true, fetchedAt non-null
 */
function parseToolUsage(x: unknown, tool: ToolId, path: string): ToolUsage {
  if (!isRecord(x)) fail(path, 'expected object');
  if (typeof x.ok !== 'boolean') fail(`${path}.ok`, 'expected boolean');
  const allowed = SOURCE_KINDS_BY_TOOL[tool];
  if (typeof x.source !== 'string' || !allowed.has(x.source)) {
    fail(`${path}.source`, `expected one of ${[...allowed].join('|')} for ${tool}`);
  }
  const source = x.source as SourceKind;
  if (!('fetchedAt' in x)) fail(`${path}.fetchedAt`, 'missing (use null when never fetched)');
  for (const k of ['fiveHour', 'weekly', 'weeklySonnet', 'credits'] as const) {
    if (!(k in x)) fail(`${path}.${k}`, 'missing (use null when absent)');
  }
  const usage: ToolUsage = {
    ok: x.ok,
    source,
    fiveHour: parseWindow(x.fiveHour, `${path}.fiveHour`),
    weekly: parseWindow(x.weekly, `${path}.weekly`),
    weeklySonnet: parseWindow(x.weeklySonnet, `${path}.weeklySonnet`),
    credits: parseCredits(x.credits, `${path}.credits`),
    fetchedAt: x.fetchedAt === null ? null : parseIsoDate(x.fetchedAt, `${path}.fetchedAt`),
  };

  if (source === 'none') {
    if (usage.ok) fail(`${path}.ok`, 'must be false when source is "none"');
    for (const k of ['fiveHour', 'weekly', 'weeklySonnet', 'credits', 'fetchedAt'] as const) {
      if (usage[k] !== null) fail(`${path}.${k}`, 'must be null when source is "none"');
    }
    return usage;
  }
  if (source === 'cache') {
    if (usage.ok) fail(`${path}.ok`, 'must be false when source is "cache"');
    if (usage.fetchedAt === null) fail(`${path}.fetchedAt`, 'must be non-null when source is "cache"');
    return usage;
  }
  if (!usage.ok) fail(`${path}.ok`, `must be true when source is "${source}"`);
  if (usage.fetchedAt === null) fail(`${path}.fetchedAt`, `must be non-null when source is "${source}"`);
  return usage;
}

/**
 * Validate an unknown value as a v1 UsagePayload. Throws Error with a JSON-path
 * (e.g. `$.claude.source`) on failure. `version !== 1` is a failure (PLAN §3).
 * Unknown keys inside `ext` are kept as-is; unknown top-level keys are dropped.
 * `ext.claudeScopedModel`, when present, must be a non-empty string or null.
 */
export function parseUsagePayload(x: unknown): UsagePayload {
  if (!isRecord(x)) fail('$', 'expected object');
  if (x.version !== 1) fail('$.version', 'expected 1');
  const ext = x.ext === undefined ? {} : x.ext;
  if (!isRecord(ext)) fail('$.ext', 'expected object');
  if (EXT_CLAUDE_SCOPED_MODEL in ext && ext[EXT_CLAUDE_SCOPED_MODEL] !== null) {
    parseString(ext[EXT_CLAUDE_SCOPED_MODEL], `$.ext.${EXT_CLAUDE_SCOPED_MODEL}`);
  }
  return {
    version: 1,
    generatedAt: parseIsoDate(x.generatedAt, '$.generatedAt'),
    claude: parseToolUsage(x.claude, 'claude', '$.claude'),
    codex: parseToolUsage(x.codex, 'codex', '$.codex'),
    ext: { ...ext },
  };
}
