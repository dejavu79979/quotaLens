# Installing QuotaLens

QuotaLens shows Claude Code and Codex subscription usage on Even Realities G2 glasses.

```text
desktop daemon ── Tailscale/WireGuard ──> Even App plugin ── Bluetooth ──> G2 glasses
```

Credentials stay on the desktop. The daemon reads the OAuth credentials already stored by Claude Code and Codex CLI and sends them only in HTTPS authorization headers to the Anthropic and OpenAI usage endpoints. It never writes, refreshes, logs, or relays those tokens. Only the usage summary reaches the phone and glasses.

## Requirements

| Component | Requirement |
|---|---|
| Glasses and phone | Even Realities G2 and Even App 2.2.10 or later |
| Desktop | macOS; a Linux systemd template and manual path are included but untested |
| Node.js | 20.19+, 22.13+, or 24+ |
| Local tools | `jq` and Tailscale |
| Usage source | Claude Code and/or Codex CLI, signed in to a subscription account |

The desktop and phone must be signed in to the same tailnet, with the Tailscale VPN enabled on the phone. Using only Claude Code or only Codex CLI is supported; the unavailable section is omitted from the glasses display.

## 1. Install the desktop daemon

On macOS:

```bash
git clone https://github.com/dejavu79979/quotaLens.git ~/quotaLens
cd ~/quotaLens
bash scripts/install.sh
```

The installer is safe to rerun. It:

1. Checks Node.js, `jq`, Tailscale, Codex CLI, and Claude Code credentials. Missing Codex or Claude credentials produce a warning so either source can be used alone.
2. Runs `npm install`.
3. Writes the address from `tailscale ip -4` to `~/.quotalens/config.json` with mode 0600. Only literal tailnet IPv4 addresses in `100.64.0.0/10` are accepted; LAN addresses, hostnames, and wildcards are rejected.
4. Renders `daemon/deploy/quotalens.plist.template`, installs it as a per-user LaunchAgent, and restarts an existing agent cleanly.
5. Probes `/usage.json` over both loopback and the tailnet address. It prints only the HTTP result and each tool's `source`, never a token.
6. By default, backs up the existing Claude Code statusline command to `~/.quotalens/statusline-original.cmd` and installs the QuotaLens wrapper. Pass `--no-statusline` to skip this step.

A normal install does not modify `plugin/app.json`, so later pulls do not conflict with a machine-specific whitelist entry. `--dry-run` performs checks and prints the rendered LaunchAgent without writing files or starting services.

At the end, copy the printed relay address:

```text
http://100.x.y.z:8787
```

See [the daemon guide](../daemon/README.md) for manual launchd setup and [the statusline guide](../daemon/scripts/README.md) for wrapper details and restoration.

## 2. Install the phone plugin

1. Install **QuotaLens** from the Even Hub store.
2. Open QuotaLens and its settings page in the Even App.
3. Paste the relay address printed by the desktop installer into **Relay address**.
4. Select **Test connection**. `✓ <ms> ms` confirms that the phone can reach the daemon.

Starting with v0.3.1, the first glasses launch displays a `Set the relay address` prompt card until a relay address is saved.

The store package uses a generic placeholder in the `plugin/app.json` network whitelist. Store installation has been tested without that whitelist being enforced, so a user's own tailnet origin works even though the platform documentation describes strict per-origin entries. If the platform begins enforcing the whitelist, use the self-packed fallback in Appendix A.

## 3. Relay address and connection test

The settings page accepts `100.x.y.z`, `100.x.y.z:8787`, or a complete `http://100.x.y.z:8787` address and normalizes it to an origin when the field loses focus. The plugin adds `/usage.json`. Settings save immediately; there is no Save button.

| Result | Meaning |
|---|---|
| `✓ <ms> ms` | Connection succeeded |
| `✗ HTTP 404` | The address responded, but it is not the QuotaLens daemon; another service may own port 8787, or the address may identify another machine |
| `✗ bad schema` | The response is not a valid QuotaLens payload |
| `✗ net err` / `✗ timeout` | The phone is not connected to Tailscale, the daemon is not running, or the address cannot be reached |
| `✗ no relay address` | The field is empty |

`Saved (browser only — connect the glasses to keep it)` means the glasses are disconnected, so the value currently exists only in the WebView. If the glasses reconnect while QuotaLens remains open, the changed value is copied to Even App persistent storage. Closing QuotaLens first discards that browser-only value.

## 4. Glasses controls

| Gesture | Main screen | Menu |
|---|---|---|
| tap | Refresh usage now | Confirm the selected item |
| swipe up/down | Show the single-page hint | Move the cursor |
| long-press | Open the menu | — |
| double-tap | Open the system exit confirmation | Return to the main screen |

When an update fails, QuotaLens keeps the last good values and marks them `stale`; it does not clear the display to black.

## 5. Troubleshooting

| Symptom | Check |
|---|---|
| Stuck on `Connecting…` | Run **Test connection** in settings, then confirm that Tailscale is connected on both the phone and desktop |
| Need to inspect the daemon sources | `curl -s http://127.0.0.1:8787/usage.json \| jq '{claude:.claude.source, codex:.codex.source}'` |
| `claude.source` is `none` | Confirm that Claude Code is signed in, then start a new Claude Code session so the statusline wrapper can capture usage |
| `codex.source` is `none` or `cache` | Confirm that `codex` is on `PATH` and that `codex app-server --help` runs |
| Installer reports `Bootstrap failed` | Wait for the previous LaunchAgent to unload, then rerun `bash scripts/install.sh` |
| Port 8787 is occupied | Run `lsof -t -nP -iTCP:8787 -sTCP:LISTEN` |
| QuotaLens disappears after Bluetooth reconnects | Use the Even App's send-to-glasses control to reopen it |

The macOS log is `~/Library/Logs/quotalens.log`. It contains no tokens. The relay address is not a credential, but the service must remain available only inside the tailnet.

## 6. Security boundary and whitelist limitation

- Tokens are read only by the desktop daemon and sent only to the official Anthropic or OpenAI HTTPS endpoint. They never enter the relay payload, logs, or git.
- The relay carries only the `UsagePayload` defined in `shared/schema.ts`: usage percentages and reset times, fetch timestamps, `ok` and `source` values, reported prepaid credits in USD, `generatedAt`, and the display name for the Claude model-specific weekly limit. It includes no account identity, session data, or credentials.
- The daemon binds only `127.0.0.1` and the desktop's validated tailnet IPv4 address.
- The tailnet is the only authentication layer. Any node inside the tailnet can read the usage summary.
- Never expose port 8787 with `tailscale funnel`.
- The store-package whitelist is not currently enforced in the tested installation path and must not be treated as a security boundary. Use a self-packed build if enforcement prevents a connection.

Known limitations:

- The macOS installer is tested; the Linux systemd template is not.
- After the G2 reconnects over Bluetooth, QuotaLens may need to be sent to the glasses again from the Even App.
- The phone must keep its Tailscale VPN enabled.

## Appendix A: Self-packed fallback

If the store build cannot connect because the network whitelist is being enforced:

```bash
cd ~/quotaLens
bash scripts/install.sh --self-pack
cd plugin
npm run build
npx evenhub pack app.json dist -o quotalens.ehpk --sdk-ver 0.0.15
```

Only `--self-pack` adds this desktop's `http://<tailnet IP>:8787` origin to `plugin/app.json`. Upload `plugin/quotalens.ehpk` through the Even Hub Developer Center and install it. This fallback intentionally modifies the checkout's `plugin/app.json`; the normal store flow does not.
