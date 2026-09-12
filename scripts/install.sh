#!/usr/bin/env bash
# QuotaLens desktop installer — macOS only (PLAN M8 T8.2).
#
# One command after `git clone`: checks the toolchain, installs dependencies, records the tailnet
# address, renders and loads the launchd agent, and wires the Claude Code statusline capture.
# Idempotent: re-running updates the same files and restarts the same agent.
#
# Flags:
#   --no-statusline     leave ~/.claude/settings.json alone (Claude falls back to the oauth poll)
#   --skip-npm-install  do not run `npm install` (tests; a checkout that already has node_modules)
#   --dry-run           checks + rendered plist to stdout; works before npm install; writes nothing
#   --self-pack         add this machine's origin to plugin/app.json for a locally packed build
#
# Since M9 there is no path secret: the relay address is `http://<tailnet IPv4>:8787`, printed at the
# end for the phone. Tokens never appear anywhere here (PLAN §6 rule 1).
set -euo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
LABEL=dev.bruce.quotalens
NO_STATUSLINE=0
SKIP_NPM=0
DRY_RUN=0
SELF_PACK=0
for arg in "$@"; do
  case "$arg" in
    --no-statusline) NO_STATUSLINE=1 ;;
    --skip-npm-install) SKIP_NPM=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --self-pack) SELF_PACK=1 ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '▸ %s\n' "$*"; }
warn() { printf '⚠ %s\n' "$*" >&2; }
fail() { printf '✗ %s\n' "$*" >&2; exit 1; }

# ---- 1. prerequisites -------------------------------------------------------------------------
[ "$(uname -s)" = Darwin ] || fail "this installer is macOS-only (Linux: see daemon/deploy/quotalens.service)"

NODE=$(command -v node) || fail "node not found — install Node 20.19+, 22.13+ or 24+ (docs/INSTALL.md §0)"
"$NODE" -e '
  const [a, b] = process.versions.node.split(".").map(Number);
  process.exit((a === 20 && b >= 19) || (a === 22 && b >= 13) || a >= 24 ? 0 : 1);
' || fail "node $("$NODE" --version) is outside the supported range (20.19+ / 22.13+ / 24+)"

command -v jq >/dev/null || fail "jq not found (ships with macOS 15+; brew install jq)"

TAILSCALE=$(command -v tailscale || true)
[ -n "$TAILSCALE" ] || [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] || TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
[ -n "$TAILSCALE" ] || fail "tailscale not found — install Tailscale and sign in on this machine and on the phone"
TS_IP=$("$TAILSCALE" ip -4 2>/dev/null | head -1 || true)
[ -n "$TS_IP" ] || fail "tailscale has no IPv4 for this machine — is it signed in and connected?"
# Shape-checked BEFORE it is ever printed (M8 QA): setup.ts applies the real 100.64.0.0/10 rule, but a
# value that is not even an IPv4 must not reach the terminal or the daemon's config.
# A regex, not a case glob (M8 QA round five): in a glob `*` matches anything, so
# `100.7http://…/usage.2.3` slipped through and was printed. And the full 100.64.0.0/10
# rule, the same one `isTailnetIPv4` in daemon/src/config.ts applies (round six): a value outside the
# block — `100.128.0.1` — must not be printed either, and a dry run must reach this verdict itself.
[[ "$TS_IP" =~ ^100\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] \
  && [ "${BASH_REMATCH[1]}" -ge 64 ] && [ "${BASH_REMATCH[1]}" -le 127 ] \
  && [ "${BASH_REMATCH[2]}" -le 255 ] && [ "${BASH_REMATCH[3]}" -le 255 ] \
  || fail "tailscale ip -4 answered something that is not a tailnet IPv4 in 100.64.0.0/10 (${#TS_IP} chars); not printing it"

CODEX=$(command -v codex || true)
[ -n "$CODEX" ] || warn "codex not found in PATH — the CODEX section will not appear on the glasses"

if security find-generic-password -s "Claude Code-credentials" >/dev/null 2>&1; then :; else
  warn "no Claude Code credentials in the Keychain — sign in to Claude Code, or the CLAUDE section stays empty"
fi

say "node $("$NODE" --version) at $NODE; tailnet IPv4 $TS_IP; codex ${CODEX:-(missing)}"

# ---- 2. dependencies ---------------------------------------------------------------------------
if [ "$SKIP_NPM" = 1 ] || [ "$DRY_RUN" = 1 ]; then
  say "npm install skipped"
else
  say "npm install"
  (cd "$REPO" && npm install --no-fund --no-audit --loglevel=error)
fi
if [ ! -f "$REPO/node_modules/tsx/dist/cli.mjs" ]; then
  [ "$DRY_RUN" = 1 ] && say "would run: npm install" \
    || fail "node_modules/tsx missing — run npm install in $REPO"
fi

# ---- 3. tailnet host (M9: no secret) -----------------------------------------------------------
if [ "$DRY_RUN" = 1 ]; then
  say "would run: npm run setup -- --host $TS_IP"
else
  (cd "$REPO" && "$NODE" node_modules/tsx/dist/cli.mjs daemon/src/setup.ts --host "$TS_IP")
fi

# ---- 3b. self-packed build: this machine's origin in the plugin network whitelist --------------
# The store build keeps a generic placeholder so an ordinary install never dirties the checkout.
# `--self-pack` is the fallback if Even begins enforcing its documented one-origin-per-entry list.
if [ "$SELF_PACK" = 1 ]; then
  APP_JSON=${QUOTALENS_APP_JSON:-$REPO/plugin/app.json}
  ORIGIN="http://$TS_IP:8787"
  if [ "$DRY_RUN" = 1 ]; then
    say "would add $ORIGIN to the network whitelist in $APP_JSON (if missing)"
  elif jq -e --arg o "$ORIGIN" '.permissions[] | select(.name == "network") | .whitelist | index($o)' "$APP_JSON" >/dev/null 2>&1; then
    say "plugin whitelist already lists $ORIGIN"
  else
    jq --arg o "$ORIGIN" '(.permissions[] | select(.name == "network") | .whitelist) += [$o]' "$APP_JSON" > "$APP_JSON.tmp" \
      && mv -f "$APP_JSON.tmp" "$APP_JSON" || fail "could not update the whitelist in $APP_JSON"
    say "added $ORIGIN to the plugin network whitelist — rebuild and repack the plugin (docs/INSTALL.md appendix A)"
  fi
fi

# ---- 4. launchd agent --------------------------------------------------------------------------
BIN_PATH=$(dirname "$NODE")
[ -z "$CODEX" ] || BIN_PATH="$BIN_PATH:$(dirname "$CODEX")"
BIN_PATH="$BIN_PATH:/usr/bin:/bin:/usr/sbin:/sbin"
# Paths go into XML text nodes through a sed replacement, so two escapes apply (codex 2026-09-11:
# a clone under `~/Dev & Tools/` or a name with `|`, `<`, `>` used to corrupt the plist silently):
# XML first (& < > " '), then sed's own specials in the replacement (\ & and the | delimiter).
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e "s/'/\&apos;/g" -e 's/"/\&quot;/g'; }
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }
render_plist() {
  local node repo path home
  node=$(sed_escape "$(xml_escape "$NODE")")
  repo=$(sed_escape "$(xml_escape "$REPO")")
  path=$(sed_escape "$(xml_escape "$BIN_PATH")")
  home=$(sed_escape "$(xml_escape "$HOME")")
  sed -e "s|@@NODE@@|$node|g" -e "s|@@REPO@@|$repo|g" -e "s|@@PATH@@|$path|g" -e "s|@@HOME@@|$home|g" \
    "$REPO/daemon/deploy/quotalens.plist.template"
}
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [ "$DRY_RUN" = 1 ]; then
  say "would write $PLIST:"
  render_plist
  say "dry run complete — nothing written"
  exit 0
fi
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
render_plist > "$PLIST.tmp"
grep -q '@@' "$PLIST.tmp" && fail "plist still has an unfilled placeholder"
plutil -lint -s "$PLIST.tmp" >/dev/null || fail "rendered plist does not lint"
mv -f "$PLIST.tmp" "$PLIST"

DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  say "restarting $LABEL"
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
  # bootout returns before the job is gone; a bootstrap in that window fails with
  # "Bootstrap failed: 5: Input/output error" (seen on macOS 26, 2026-09-11).
  for i in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 || break
    sleep 1
  done
  # Still loaded after the wait: bootstrapping over it would be the same I/O error, so stop here.
  launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1 && fail "$LABEL is still loaded after bootout — retry in a moment, or: launchctl bootout $DOMAIN/$LABEL"
fi
launchctl bootstrap "$DOMAIN" "$PLIST" || fail "launchctl bootstrap failed — see ~/Library/Logs/quotalens.log; retry with: launchctl bootstrap $DOMAIN $PLIST"
say "loaded $PLIST"

# ---- 5. verify ---------------------------------------------------------------------------------
[ "$(jq -r '.host // empty' "$HOME/.quotalens/config.json")" = "$TS_IP" ] || fail "~/.quotalens/config.json does not hold the tailnet host after setup"
# A probe is a verdict, not a print (codex 2026-09-11): a daemon that crashed at start, or never
# bound the tailnet address, must fail the install — otherwise the address printed at the end
# answers nothing. 200 + a body with both `source` fields is the bar; the JSON is checked
# with jq so a proxy page or an HTML error does not pass as a daemon.
probe() { # $1 = host → prints the summary; returns 1 when the endpoint is not a healthy daemon
  local body code json
  body=$(curl -s -m 5 -w '\n%{http_code}' "http://$1:8787/usage.json" 2>/dev/null || true)
  code=${body##*$'\n'}
  json=${body%$'\n'*}
  if [ "$code" = 200 ] && printf '%s' "$json" | jq -e '.version == 1 and (.claude.source | type == "string") and (.codex.source | type == "string")' >/dev/null 2>&1; then
    printf '200 claude=%s codex=%s' "$(printf '%s' "$json" | jq -r '.claude.source')" "$(printf '%s' "$json" | jq -r '.codex.source')"
    return 0
  fi
  case "$code" in 200) printf '200 but not a QuotaLens payload' ;; '') printf 'no answer' ;; *) printf '%s' "$code" ;; esac
  return 1
}
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -s -m 2 -o /dev/null "http://127.0.0.1:8787/" 2>/dev/null && break
  sleep 1
done
loop=$(probe 127.0.0.1) || { say "loopback  127.0.0.1:8787 → $loop"; fail "the daemon is not answering on loopback — see ~/Library/Logs/quotalens.log"; }
say "loopback  127.0.0.1:8787 → $loop"
tail=$(probe "$TS_IP") || { say "tailnet   $TS_IP:8787 → $tail"; fail "the daemon is not answering on the tailnet address — see ~/Library/Logs/quotalens.log (is Tailscale up?)"; }
say "tailnet   $TS_IP:8787 → $tail"

# ---- 6. Claude Code statusline capture ---------------------------------------------------------
SETTINGS="$HOME/.claude/settings.json"
# Single-quoted for the shell Claude Code runs it in, so a repo path with spaces or shell
# metacharacters survives (codex 2026-09-11); a `'` inside the path becomes `'\''`.
WRAPPER_CMD="bash '$(printf '%s' "$REPO/daemon/scripts/claude-statusline.sh" | sed "s/'/'\\\\''/g")'"
ORIG_FILE="$HOME/.quotalens/statusline-original.cmd"
if [ "$NO_STATUSLINE" = 1 ]; then
  say "statusline left alone (--no-statusline); Claude usage comes from the oauth poll"
else
  current=""
  [ -f "$SETTINGS" ] && current=$(jq -r '.statusLine.command // empty' "$SETTINGS" 2>/dev/null || true)
  # Three shapes of "it names our wrapper" (codex 2026-09-11, twice):
  #  - exactly the current form                 → already wired
  #  - exactly the pre-quoting form (`bash <path>`, no quotes) → re-quoted, after a dated backup,
  #    because the unquoted form breaks on a path with spaces; `.cmd` is not touched
  #  - anything else that mentions the wrapper  → the owner wrapped it in something of their own:
  #    left alone with a warning, and NEVER saved as the "original" (that would make the wrapper
  #    call itself for ever)
  # Rewrite settings.json without loosening it (codex 2026-09-11): the temp file is created under
  # umask 077 and then given the original file's mode, so a 0600 settings.json stays 0600 — plain
  # `> tmp && mv` under the usual umask 022 would have left it 0644.
  rewrite_settings() { # $1 = jq filter (uses $c)
    local mode
    mode=$(stat -f %Lp "$SETTINGS" 2>/dev/null || echo 600)
    (umask 077 && jq --arg c "$WRAPPER_CMD" "$1" "$SETTINGS" > "$SETTINGS.tmp") || fail "could not rewrite $SETTINGS"
    chmod "$mode" "$SETTINGS.tmp"
    mv -f "$SETTINGS.tmp" "$SETTINGS"
  }
  OLD_FORM="bash $REPO/daemon/scripts/claude-statusline.sh"
  if [ "$current" = "$OLD_FORM" ]; then
    cp -p "$SETTINGS" "$SETTINGS.quotalens-bak.$(date +%Y%m%d%H%M%S)"
    rewrite_settings '.statusLine = ((.statusLine // {}) + {type: "command", command: $c})'
    say "statusline command re-quoted to the current form (previous settings backed up next to it)"
    current="$WRAPPER_CMD"
  fi
  case "$current" in
    "$WRAPPER_CMD") ;;
    *claude-statusline.sh*)
      warn "statusLine.command references the QuotaLens wrapper inside a custom command — left as is; keep ~/.quotalens/statusline-original.cmd pointing at YOUR original statusline, never at the wrapper"
      current="$WRAPPER_CMD" ;;
  esac
  if [ "$current" = "$WRAPPER_CMD" ]; then
    # Already wired. A wrapper installed before M8 carried the original command inline; the backup
    # the T1.2 steps took is the only other copy, so recover it from there once.
    if [ ! -f "$ORIG_FILE" ] && [ -f "$SETTINGS.quotalens-bak" ]; then
      orig=$(jq -r '.statusLine.command // empty' "$SETTINGS.quotalens-bak" 2>/dev/null || true)
      case "$orig" in *claude-statusline.sh*) orig="" ;; esac   # a backup taken after wiring is not an original
      if [ -n "$orig" ]; then
        (umask 077 && printf '%s\n' "$orig" > "$ORIG_FILE")
        say "recovered the original statusline command into $ORIG_FILE"
      fi
    fi
    say "statusline already wired"
  else
    mkdir -p "$HOME/.claude" "$HOME/.quotalens"
    [ -f "$SETTINGS" ] || (umask 077 && printf '{}\n' > "$SETTINGS")
    cp -p "$SETTINGS" "$SETTINGS.quotalens-bak"
    if [ -n "$current" ]; then
      (umask 077 && printf '%s\n' "$current" > "$ORIG_FILE")
    else
      # No statusline configured right now: an ORIG_FILE left over from an earlier install would
      # make the wrapper resurrect a statusline the owner has since removed (codex 2026-09-11).
      rm -f "$ORIG_FILE"
    fi
    # Merge, not replace (M8 QA): `statusLine` can carry other keys (`padding`, …) that must survive.
    rewrite_settings '.statusLine = ((.statusLine // {}) + {type: "command", command: $c})'
    say "statusline wired (backup: $SETTINGS.quotalens-bak; open a NEW Claude Code session to activate)"
  fi
fi

# ---- 7. done -----------------------------------------------------------------------------------
say "done. Relay address for the phone:  http://$TS_IP:8787  — paste it into Even App → QuotaLens → Relay address"
say "Install QuotaLens from the Even Hub store, then paste the address into its settings page"
