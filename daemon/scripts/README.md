# Daemon scripts

## `claude-statusline.sh`

Claude Code passes session JSON to `statusLine.command` on each turn. The QuotaLens wrapper:

1. Extracts only the `rate_limits` object.
2. Atomically writes `{"rate_limits": {...}}` to `~/.quotalens/claude.json` with mode 0600.
3. Excludes all other session fields, including `session_id`, `cwd`, and transcript paths.
4. Sends the unchanged input to the user's original statusline command and prints that command's output unchanged.

The original command is stored as one shell command line in `~/.quotalens/statusline-original.cmd` with mode 0600. If that file is absent, the wrapper prints nothing. A saved command that refers to `claude-statusline.sh` is not executed, which prevents accidental recursion.

An empty input, invalid JSON, or missing/null `rate_limits` leaves the previous capture untouched. Write or downstream statusline failures do not break Claude Code's statusline; the wrapper always exits successfully and does not print captured JSON or errors.

## Installer integration

Run this from the repository root:

```bash
bash scripts/install.sh
```

Unless `--no-statusline` is supplied, the installer:

1. Creates `~/.claude/settings.json` and `~/.quotalens` when needed.
2. Backs up the settings file to `~/.claude/settings.json.quotalens-bak` before first wiring.
3. Saves a nonempty existing `statusLine.command` to `~/.quotalens/statusline-original.cmd`.
4. Merges the wrapper command into `statusLine`, preserving sibling keys such as `padding` and preserving the settings file mode.

Rerunning the installer recognizes the current wrapper and the older unquoted wrapper form. It re-quotes the older form after creating a dated backup. Unknown custom commands that merely mention `claude-statusline.sh` are left unchanged with a warning.

Open a new Claude Code session after installation so the updated statusline command takes effect.

## Manual setup

The installer is preferred because it handles path quoting, backups, permissions, migrations, and idempotence. To wire the wrapper manually:

```bash
cd <repo>
mkdir -p ~/.claude ~/.quotalens
test -f ~/.claude/settings.json || (umask 077; printf '{}\n' > ~/.claude/settings.json)
cp -p ~/.claude/settings.json ~/.claude/settings.json.quotalens-bak

(umask 077; jq -r '.statusLine.command // empty' ~/.claude/settings.json > ~/.quotalens/statusline-original.cmd)
WRAPPER="bash '$PWD/daemon/scripts/claude-statusline.sh'"
MODE=$(stat -f %Lp ~/.claude/settings.json)
(umask 077; jq --arg command "$WRAPPER" \
  '.statusLine = ((.statusLine // {}) + {type:"command", command:$command})' \
  ~/.claude/settings.json > ~/.claude/settings.json.tmp)
chmod "$MODE" ~/.claude/settings.json.tmp
mv ~/.claude/settings.json.tmp ~/.claude/settings.json
```

This example assumes the repository path contains no single quote. Use `scripts/install.sh` when it does. If no original statusline command existed, remove the empty saved-command file:

```bash
test -s ~/.quotalens/statusline-original.cmd || rm -f ~/.quotalens/statusline-original.cmd
```

Confirm the settings change, then start a new Claude Code session and send any prompt:

```bash
diff ~/.claude/settings.json.quotalens-bak ~/.claude/settings.json
jq .rate_limits ~/.quotalens/claude.json
```

To change the downstream statusline later, edit the single command in `~/.quotalens/statusline-original.cmd`; the wrapper itself does not need to change.

## Restore the previous statusline

Restore the settings backup, then start a new Claude Code session:

```bash
cp -p ~/.claude/settings.json.quotalens-bak ~/.claude/settings.json
```

After verifying the restored statusline, `~/.quotalens/statusline-original.cmd` may be removed.

## Manual test

The following writes fake usage data to `~/.quotalens/claude.json` and may also run the saved original statusline command:

```bash
printf '{"session_id":"x","rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600}}}' \
  | bash daemon/scripts/claude-statusline.sh
echo "exit=$?"
cat ~/.quotalens/claude.json

before=$(stat -f %m ~/.quotalens/claude.json)
printf '{"session_id":"x"}' | bash daemon/scripts/claude-statusline.sh
after=$(stat -f %m ~/.quotalens/claude.json)
test "$before" = "$after"
```

The first capture contains `rate_limits` but not `session_id`. The second input has no `rate_limits`, so the file modification time remains unchanged. Fake percentages remain visible to the daemon until a later Claude Code turn replaces them.

For an isolated automated test that uses a temporary home and does not touch local settings, run:

```bash
bash scripts/install.test.sh
```
