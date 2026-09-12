# QuotaLens daemon

The daemon collects Claude Code and Codex subscription usage on the desktop and exposes a single `GET /usage.json` endpoint for the QuotaLens phone plugin. It always listens on `127.0.0.1:8787` and can add one listener on the desktop's Tailscale IPv4 address. `~/.quotalens/config.json` stores that `host` value with mode 0600; a legacy `secret` key may remain but is ignored.

For the Claude Code statusline integration, see [scripts/README.md](scripts/README.md).

## macOS installer

From the repository root:

```bash
bash scripts/install.sh
```

The command is idempotent and supports `--no-statusline`, `--dry-run`, and `--self-pack`. It performs these steps:

1. Validates the supported Node.js version, `jq`, Tailscale, and the available Claude Code and Codex usage sources.
2. Runs `npm install` unless explicitly skipped by the test-only `--skip-npm-install` flag.
3. Runs `npm run setup -- --host "$(tailscale ip -4)"`, which records the validated tailnet host in `~/.quotalens/config.json`.
4. Renders [deploy/quotalens.plist.template](deploy/quotalens.plist.template) with the local Node.js path, repository path, executable search path, and home directory.
5. Unloads any existing LaunchAgent, waits for it to disappear, installs the rendered plist, and bootstraps it.
6. Verifies valid QuotaLens responses over both loopback and the tailnet listener.
7. Unless `--no-statusline` is used, preserves the previous Claude Code statusline command and installs the wrapper.
8. Prints the relay address to paste into the phone settings.

A normal store installation leaves `plugin/app.json` unchanged. `--self-pack` adds the local origin only for a locally packed fallback build. The installer test uses a temporary home and command stubs:

```bash
bash scripts/install.test.sh
```

## Tailnet binding rule

The daemon does not use `tailscale serve`, public TLS certificates, or changes to Tailscale account settings. The phone connects to `http://<tailnet IP>:8787` while Tailscale carries that traffic inside its encrypted WireGuard tunnel. The plugin appends `/usage.json`.

Set or update the host with:

```bash
npm run setup -- --host "$(tailscale ip -4)"
```

The configured host must be a literal IPv4 address in `100.64.0.0/10`, the CGNAT range Tailscale uses. `0.0.0.0`, LAN addresses, hostnames, and values outside that range are rejected. A rejected value leaves the daemon loopback-only so a typo cannot expose the endpoint on Wi-Fi.

The tailnet is the only authentication layer. Never expose port 8787 with `tailscale funnel`.

To run the daemon in the foreground for development:

```bash
npm run dev --workspace @quotalens/daemon
```

## macOS launchd

[deploy/quotalens.plist.template](deploy/quotalens.plist.template) is the single LaunchAgent template. A per-user LaunchAgent is required because the daemon reads the logged-in user's Claude Code Keychain item, `~/.codex/auth.json`, and `~/.quotalens` data.

### Manual installation

The main installer is preferred because it safely escapes paths and handles an existing agent. The equivalent outline below is useful for diagnosis or a custom installation:

```bash
cd <repo>
npm install
npm run setup -- --host "$(tailscale ip -4)"

LABEL=$(plutil -extract Label raw -o - daemon/deploy/quotalens.plist.template)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE=$(command -v node)
BIN_PATH=$(dirname "$NODE")
CODEX=$(command -v codex || true)
[ -z "$CODEX" ] || BIN_PATH="$BIN_PATH:$(dirname "$CODEX")"
BIN_PATH="$BIN_PATH:/usr/bin:/bin:/usr/sbin:/sbin"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|@@NODE@@|$NODE|g" \
    -e "s|@@REPO@@|$PWD|g" \
    -e "s|@@PATH@@|$BIN_PATH|g" \
    -e "s|@@HOME@@|$HOME|g" \
    daemon/deploy/quotalens.plist.template > "$PLIST"
plutil -lint "$PLIST"
launchctl bootstrap "gui/$(id -u)" "$PLIST"
```

This abbreviated rendering assumes the expanded paths contain no XML or `sed` metacharacters. Use `scripts/install.sh` for arbitrary checkout paths. `RunAtLoad` starts the daemon when the user logs in, and `KeepAlive` restarts it after an unexpected exit.

### Verification

```bash
LABEL=$(plutil -extract Label raw -o - daemon/deploy/quotalens.plist.template)
launchctl print "gui/$(id -u)/$LABEL" | grep -E 'state = |pid = |last exit'
curl -s http://127.0.0.1:8787/usage.json | jq .
curl -s "http://$(tailscale ip -4):8787/usage.json" | jq .
```

### Restart or remove

```bash
LABEL=$(plutil -extract Label raw -o - daemon/deploy/quotalens.plist.template)
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl kickstart -k "gui/$(id -u)/$LABEL"   # restart after code or configuration changes
launchctl bootout "gui/$(id -u)/$LABEL"        # stop and unload
rm "$PLIST"                                    # remove after bootout
```

After changing the plist, unload it and then bootstrap the updated file again.

### Logs

launchd writes both output streams to `~/Library/Logs/quotalens.log`, normally with mode 0644. The daemon never logs tokens. It logs listener addresses and fixed error summaries so failures can be diagnosed without exposing credentials.

`~/.quotalens/config.json` has mode 0600 and stores the tailnet `host`. A legacy `secret` key may remain after an upgrade, but the daemon ignores it.

### Keychain behavior

The LaunchAgent reads the Claude Code OAuth credential from the login Keychain service named `Claude Code-credentials`. This path has been tested without an authorization prompt while the daemon runs under launchd. If a migrated Keychain item prompts on another Mac, approve access for the process once. The daemon only reads this item and does not update or refresh it.

## Linux systemd

[deploy/quotalens.service](deploy/quotalens.service) is an untested systemd user-unit template. Its header documents installation, path changes, linger setup, and journal access. The macOS path is tested; do not treat the Linux template as verified without testing it on the target distribution.

## Moving to another machine

Clone the repository and rerun `scripts/install.sh`. It derives the four template values locally:

| Placeholder | Value | Purpose |
|---|---|---|
| `@@NODE@@` | Absolute path from `command -v node` | launchd does not inherit Homebrew, nvm, or similar shell setup |
| `@@REPO@@` | Absolute repository path | `tsx` runs the daemon from source |
| `@@PATH@@` | Directories containing Node.js and Codex, followed by system paths | The daemon starts `codex app-server` by name |
| `@@HOME@@` | The current home directory | Locates logs and user configuration |

Sign in to Tailscale, Claude Code, and/or Codex CLI on the new machine before installation. Paste the newly printed relay address into QuotaLens on the phone.

## Troubleshooting

| Symptom | Check |
|---|---|
| `curl` cannot connect | Inspect the LaunchAgent with the verification command above, then check `~/Library/Logs/quotalens.log` for a nonzero exit or bind error |
| Tailnet URL fails but loopback works | Confirm that `tailscale ip -4` matches `~/.quotalens/config.json`, then restart the agent; a listener that starts before Tailscale is ready retries with backoff |
| `codex.source` never becomes `app_server` | Confirm that the rendered plist `PATH` contains the directory holding `codex`, and run `codex app-server --help` |
| `claude.source` is `none` | Confirm Claude Code is signed in and start a new Claude Code session; inspect the statusline guide if capture does not appear |
| Port 8787 is occupied | Run `lsof -t -nP -iTCP:8787 -sTCP:LISTEN`; another foreground `npm run dev` process is a common cause |
| LaunchAgent bootstrap fails during a reinstall | Wait for the previous agent to unload, then rerun `bash scripts/install.sh` |
