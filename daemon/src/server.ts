// QuotaLens daemon — HttpServer (PLAN.md §2, §10.2 HttpServer.handle, T1.5, M9).
//
// Route: GET /usage.json (optionally `?refresh=1`, PLAN §3). Everything else — other paths (the
// pre-M9 `/u/<secret>/usage.json` included), other methods — is 404 with the same body.
// Every JSON reply carries `Content-Type: application/json`, `Access-Control-Allow-Origin: *` and
// `Cache-Control: no-store` (T1.5); an OPTIONS pre-flight answers 204 with the CORS headers.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HOST, USAGE_PATH } from './config.ts';
import type { Aggregator } from './aggregator.ts';

/** Headers shared by every response (CORS for the Even Hub WebView, no caching anywhere in between). */
const COMMON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Cache-Control': 'no-store',
} as const;

const PREFLIGHT_HEADERS = {
  ...COMMON_HEADERS,
  'Access-Control-Allow-Methods': 'GET',
  'Access-Control-Allow-Headers': '*',
} as const;

export interface HttpServerOptions {
  aggregator: Aggregator;
  /** Wall clock handed to the Aggregator; injected in tests. */
  clock?: () => Date;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { ...COMMON_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Parse the request-target; returns null for anything WHATWG URL rejects (e.g. `//[`). */
function parseRequestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? '/', `http://${HOST}`);
  } catch {
    return null;
  }
}

/** What `listenWithRetry` needs from `node:http`'s Server; narrowed so a test can hand it a fake. */
export interface Listener {
  listen(port: number, host: string, onListening: () => void): unknown;
  on(event: 'error', handler: (e: NodeJS.ErrnoException) => void): unknown;
  close(): unknown;
}

export const LISTEN_RETRY_INITIAL_MS = 5_000;
export const LISTEN_RETRY_MAX_MS = 60_000;

/**
 * Bind the tailnet listener without ever taking the daemon down (codex review 2026-09-09).
 *
 * A bind error on an `http.Server` with no `error` handler is an uncaught exception — one bad
 * address would have killed the loopback listener with it. And the failure is not exotic: at login
 * the daemon (launchd, RunAtLoad) can start before tailscaled has brought the 100.x address up, which
 * is `EADDRNOTAVAIL`. So: log a fixed code (never the error object), retry with back-off
 * 5 s → 60 s, and let loopback carry on meanwhile. Returns a stop function for shutdown.
 */
export function listenWithRetry(
  make: () => Listener,
  host: string,
  port: number,
  opts: { log?: (line: string) => void; setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (t: unknown) => void } = {},
): () => void {
  const log = opts.log ?? ((line) => console.error(line));
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms).unref());
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let delay = LISTEN_RETRY_INITIAL_MS;
  let timer: unknown = null;
  let server: Listener | null = null;
  let stopped = false;

  const attempt = (): void => {
    if (stopped) return;
    server = make();
    server.on('error', (e) => {
      server?.close();
      server = null;
      log(`quotalens daemon: cannot listen on ${host}:${port} (${e.code ?? 'ERR'}); retrying in ${delay / 1000}s`);
      timer = setTimer(attempt, delay);
      delay = Math.min(delay * 2, LISTEN_RETRY_MAX_MS);
    });
    server.listen(port, host, () => {
      delay = LISTEN_RETRY_INITIAL_MS;
      console.log(`quotalens daemon listening on http://${host}:${port}${USAGE_PATH}`);
    });
  };
  attempt();
  return () => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    server?.close();
  };
}

export class HttpServer {
  private readonly aggregator: Aggregator;
  private readonly clock: () => Date;

  constructor(opts: HttpServerOptions) {
    this.aggregator = opts.aggregator;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** Bound so it can be passed straight to `createServer(http.handle)`. */
  readonly handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = parseRequestUrl(req);
    if (url === null) {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }
    if (req.method === 'OPTIONS') {
      // CORS pre-flight from the Even Hub WebView (T2.2 verifies whether one is actually sent).
      res.writeHead(204, PREFLIGHT_HEADERS);
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === USAGE_PATH) {
      try {
        const payload = await this.aggregator.buildPayload(this.clock(), {
          refresh: url.searchParams.get('refresh') === '1',
        });
        sendJson(res, 200, payload);
      } catch (e) {
        // Contract violation or unexpected throw: never crash the daemon (PLAN §6 rule 3).
        console.error('usage payload failed:', e instanceof Error ? e.message : String(e));
        sendJson(res, 500, { error: 'internal error' });
      }
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  };
}
