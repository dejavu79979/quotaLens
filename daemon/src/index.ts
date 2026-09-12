// QuotaLens daemon — HTTP server on 127.0.0.1:8787, plus the tailnet IPv4 when configured
// (PLAN.md §2, T1.1, T1.5; M2 2026-09-09; M9 2026-09-11: no path secret).
import { createServer, type Server } from 'node:http';
import { Aggregator } from './aggregator.ts';
import { HOST, PORT, USAGE_PATH, readExtraHost } from './config.ts';
import { HttpServer, listenWithRetry } from './server.ts';
import { forceKillCodex, shutdownCodex } from './codex.ts';

const http = new HttpServer({ aggregator: new Aggregator() });

// Loopback is unconditional (README, simulator, QA relay) and a failure here is fatal as before:
// the port being taken means another daemon is running, and launchd's KeepAlive will retry.
const loopback: Server = createServer(http.handle);
loopback.listen(PORT, HOST, () => {
  // Since M9 the URL is not a secret, so the startup line can print it whole. Tokens still never
  // reach this log (§6 rule 1).
  console.log(`quotalens daemon listening on http://${HOST}:${PORT}${USAGE_PATH}`);
});

// The tailnet address is the phone's way in (PLAN M2), bound only when config.json names a valid
// one (`readExtraHost` refuses everything else, so no typo opens the port to the LAN). It is NOT
// allowed to take loopback down with it: at login it may not exist yet, so it retries instead.
const extraHost = readExtraHost();
const stopExtra = extraHost === null ? () => undefined : listenWithRetry(() => createServer(http.handle), extraHost, PORT);

/** Kill the `codex app-server` child and release the ports; no orphan survives the daemon (T1.4). */
function shutdown(signal: NodeJS.Signals): void {
  console.log(`quotalens daemon: ${signal}, shutting down`);
  shutdownCodex();
  loopback.close();
  stopExtra();
  // Give the child's SIGTERM a moment to land; whatever is still alive gets SIGKILL, then exit.
  setTimeout(() => {
    forceKillCodex();
    process.exit(0);
  }, 200).unref();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
