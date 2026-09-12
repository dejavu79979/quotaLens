// QuotaLens daemon — Aggregator (PLAN.md §10.2): merges the two UsageSources into one UsagePayload
// and owns the daemon-side `?refresh=1` throttle (PLAN §3: at most one real upstream refresh per
// 60 s; a throttled refresh is served like any plain request). lastGood lives inside each source
// (T1.3/T1.4), so the §10.2 `lastGood` map is realised there rather than duplicated here.
import { EXT_CLAUDE_SCOPED_MODEL, parseUsagePayload, type ToolUsage, type UsagePayload } from '@quotalens/shared';
import { REFRESH_THROTTLE_MS } from './config.ts';
import { getClaudeUsage, type ClaudeResult, type FetchOptions } from './claude.ts';
import { getCodexUsage, type CodexFetchOptions } from './codex.ts';

/** PLAN §3 cold-start semantics: never fetched → ok:false, source:"none", all null. */
const NONE: ToolUsage = {
  ok: false,
  source: 'none',
  fiveHour: null,
  weekly: null,
  weeklySonnet: null,
  credits: null,
  fetchedAt: null,
};

export interface AggregatorDeps {
  /** Claude usage lookup; tests inject a fake so no Keychain/network is touched. */
  claude: (now: Date, opts: FetchOptions) => Promise<ClaudeResult>;
  /** Codex usage lookup (null = never succeeded); tests inject a fake so no child process/network is touched. */
  codex: (now: Date, opts: CodexFetchOptions) => Promise<ToolUsage | null>;
}

export interface BuildOptions {
  /** `?refresh=1` was present on the request. */
  refresh?: boolean;
}

export class Aggregator {
  private readonly sources: AggregatorDeps;
  /** Wall-clock ms of the last refresh that was actually forwarded to the sources. */
  private lastRefreshAt: number | null = null;

  constructor(sources: AggregatorDeps = { claude: getClaudeUsage, codex: getCodexUsage }) {
    this.sources = sources;
  }

  /** Both sources read concurrently with the same `now`; the result is validated against the contract. */
  async buildPayload(now: Date, opts: BuildOptions = {}): Promise<UsagePayload> {
    const refresh = this.allowRefresh(now, opts.refresh === true);
    const [claude, codex] = await Promise.all([
      this.sources.claude(now, { refresh }),
      this.sources.codex(now, { refresh }),
    ]);
    return parseUsagePayload({
      version: 1,
      generatedAt: now.toISOString(),
      claude: claude.usage ?? NONE,
      codex: codex ?? NONE,
      // PLAN §3: the only defined v1 ext key — display name behind claude.weeklySonnet (string|null).
      ext: { [EXT_CLAUDE_SCOPED_MODEL]: claude.scopedModel },
    });
  }

  /** §3: forward `refresh` at most once per REFRESH_THROTTLE_MS; each source keeps its own floor on top. */
  private allowRefresh(now: Date, requested: boolean): boolean {
    if (!requested) return false;
    const t = now.getTime();
    if (this.lastRefreshAt !== null && t - this.lastRefreshAt < REFRESH_THROTTLE_MS) return false;
    this.lastRefreshAt = t;
    return true;
  }
}
