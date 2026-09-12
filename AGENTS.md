# QuotaLens Agent Instructions

## What this is

QuotaLens runs a desktop daemon that reads Claude Code and Codex CLI subscription usage.
The daemon serves `GET /usage.json` on `127.0.0.1:8787` and the desktop's Tailscale IPv4 address.
The Even Hub plugin on the phone fetches that relay over the tailnet and renders it on Even Realities G2 glasses.
Read `README.md`, `docs/INSTALL.md`, `docs/PRIVACY.md`, `daemon/README.md`, and `daemon/scripts/README.md` before changing installation, security, or data-flow behavior.

## Layout

| Path | Responsibility |
|---|---|
| `daemon/` | Node.js/TypeScript relay, the launchd template in `daemon/deploy/`, and the Claude Code statusline wrapper in `daemon/scripts/` |
| `plugin/` | Vite/TypeScript Even Hub plugin and `app.json` manifest |
| `shared/` | `shared/schema.ts`, the single `UsagePayload` definition imported by both sides |
| `scripts/` | The macOS installer and its isolated test |

## Verification toolchain

From `<repo>`, run every command below and read its output before claiming work is complete. All tests must be green.

```bash
npm ci
npm run typecheck
npm test
bash scripts/install.test.sh
cd plugin && npm run build
```

`npm test` runs the daemon and plugin tests through npm workspaces. The installer test uses a temporary home and command stubs, so it is isolated and safe on any machine.

## Installing for a user (macOS)

Before installation, confirm Node.js 20.19+, 22.13+, or 24+ and `jq` are available. Confirm Tailscale is installed, connected, and signed in on both the desktop and phone. Confirm Claude Code and/or Codex CLI is installed and signed in to a subscription account.

From `<repo>`, run:

```bash
bash scripts/install.sh
```

The installer is idempotent. When unsure and dependencies are already installed, inspect its actions first with `bash scripts/install.sh --dry-run`. Use `bash scripts/install.sh --no-statusline` to leave the Claude Code statusline unchanged.

The normal install writes `~/.quotalens/config.json` with mode 0600 and installs the QuotaLens plist under `~/Library/LaunchAgents/`. Unless statusline setup is skipped, it merges the wrapper into `~/.claude/settings.json` and preserves the previous file as `~/.claude/settings.json.quotalens-bak` before first wiring.

On the phone, install QuotaLens from the Even Hub store. Paste the printed `http://100.x.y.z:8787` relay address into the settings page and select **Test connection**. The included Linux systemd template is untested; do not describe Linux installation as verified.

## Debugging runbook

| Symptom | Command or check |
|---|---|
| Daemon does not answer | Find the QuotaLens label in `~/Library/LaunchAgents/`, run `launchctl print "gui/$(id -u)/<label>"`, then inspect `~/Library/Logs/quotalens.log`. |
| Need a credential-safe source check | Run `curl -s http://127.0.0.1:8787/usage.json \| jq '{claude:.claude.source, codex:.codex.source}'`. |
| Loopback works but the phone fails | Replace the placeholder and compare `curl -s http://100.x.y.z:8787/usage.json` with loopback; confirm the saved address and that Tailscale is connected on both devices. |
| `codex.source` is `none` or `cache` | Confirm `codex` is on `PATH` and run `codex app-server --help`. |
| `claude.source` is `none` | Confirm Claude Code is signed in, then start a new Claude Code session so statusline capture can begin. |
| Port 8787 is occupied | Run `lsof -t -nP -iTCP:8787 -sTCP:LISTEN`. Stop the conflicting process only after identifying it. |
| Need direct daemon output | Stop the LaunchAgent or resolve the port conflict, then run `npm run dev --workspace @quotalens/daemon` from `<repo>`. |
| LaunchAgent bootstrap fails | Wait for the previous agent to unload, then rerun `bash scripts/install.sh`. |

Interpret sources exactly: `statusline` is a Claude Code statusline capture; `oauth_usage` is a live Claude usage response; `app_server` is a Codex app-server response; `backend_api` is the Codex HTTP fallback; `cache` is retained last-good data after a failed current read and has `ok:false`; `none` means no source has succeeded and has `ok:false`. `stale` means retained data is older than its source-specific freshness threshold; keep displaying it with the stale marker.

## Rules the agent must follow (non-negotiable)

- Treat OAuth credentials as read-only: the macOS Keychain item `Claude Code-credentials` or `~/.claude/.credentials.json` on Linux, and `~/.codex/auth.json`. Never write, copy, print, log, or commit them. Never paste them into chat, an issue, or an error message. When debugging authentication, report only `source`/`ok` values and HTTP status codes.
- A token may leave the daemon process in exactly one way: as the `Authorization` header of an HTTPS request to the provider's canonical usage endpoint (`https://api.anthropic.com/api/oauth/usage` for Anthropic or `https://chatgpt.com/backend-api/codex/usage` for Codex). Never send it to any other host or put it in a URL, query string, body, log, relay payload, or error message. `sendsCredentials()` enforces this boundary; the `QUOTALENS_CLAUDE_OAUTH_URL` and `QUOTALENS_CODEX_BACKEND_URL` test overrides accept loopback URLs only and send them no token. Any change that adds a token to a request must go through this guard; never add a second credential send site.
- Never implement or trigger an OAuth token refresh. Refresh tokens are single-use and would race the CLI.
- Poll `/api/oauth/usage` every 15 minutes normally, never below 5 minutes, and back off for 15 minutes after HTTP 429. Back off the Codex source for 5 minutes after HTTP 429. Do not lower these limits.
- Never expose port 8787 with `tailscale funnel` or any public tunnel. Never bind the daemon to `0.0.0.0` or a LAN address. The tailnet is the only authentication layer.
- Never render a blank glasses screen. Give every input visible feedback. Support only tap, double-tap, swipe, and long-press. Show `resetsAt` exactly as returned by the server; never recompute it.
- Keep `shared/schema.ts` as the only `UsagePayload` definition. Never copy it. Put new fields under `ext` only.
- If a current read succeeds, return `ok:true` with its real source. If a read fails after an earlier success, retain the last-good values and `fetchedAt` with `ok:false` and `source:"cache"`; only the plugin decides whether to show `stale` from the age of `fetchedAt`. If that tool has never succeeded, return `ok:false` and `source:"none"` with every window, credits, and `fetchedAt` set to `null`; show no stale marker and omit that tool's section. If both tools are `none`, show `No usage data` and `tap refresh`. Never crash or clear the display.
- Limit each glasses page to at most 8 non-image containers and each text container's content to 1000 characters. Clamp untrusted payload strings, including `ext.claudeScopedModel`, at the display boundary before they reach a container.
- The glasses use a single non-monospaced firmware font. Never pad or align text by character count or by assuming a fixed glyph width. Spaces may be used only when every candidate string is measured with `@evenrealities/pretext` and the measured result is asserted by a test, as `padPercent` in `plugin/src/screens/tool.ts` does; do not remove that existing exception. Place containers at measured x coordinates, never allow an intended line to be truncated, and keep the layout tests that assert these rules.
- Build the glasses UI only from documented containers. Do not invent font, size, or color choices, animations, or arbitrary pixel drawing.

## Privacy and security boundary

The relay may carry usage percentages, reset times, fetch timestamps, `source`/`ok` flags, reported prepaid credits, `generatedAt`, and the model-limit display name.
It must never carry OAuth tokens, account identity, or session data; see `docs/PRIVACY.md`.
Bind only to `127.0.0.1` and the validated desktop Tailscale IPv4; every tailnet member can read the summary.
The store package whitelist is not a security boundary; see `docs/INSTALL.md` section 6.
Use the `--self-pack` fallback only if the platform starts enforcing that whitelist.

## Contributing

- Use conventional commits such as `feat:`, `fix:`, and `docs:`.
- Run the full verification toolchain before opening a pull request.
- Keep `plugin/app.json` unchanged during normal installs; only the documented `--self-pack` fallback may add a local origin.
- Never commit anything from `~/.quotalens` or any credential.
- Open issues without tokens or logs that contain them, even though the QuotaLens log is designed never to contain tokens.
