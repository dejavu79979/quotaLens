#!/usr/bin/env bash
# scripts/install.sh self-check (PLAN M8 T8.2). Runs the installer against a throwaway HOME with
# stubbed launchctl / curl / security / tailscale / codex, so nothing on this machine changes.
# Usage: bash scripts/install.test.sh   (exit 0 = all assertions held)
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
STUBS="$T/bin"; mkdir -p "$STUBS" "$T/home/.claude"
LOG="$T/calls.log"

stub() { printf '#!/bin/sh\necho "%s $*" >> "%s"\n%s\n' "$1" "$LOG" "$2" > "$STUBS/$1"; chmod +x "$STUBS/$1"; }
stub launchctl 'case "$1" in print) exit 1;; esac; exit 0'
stub security 'exit 0'
stub tailscale 'echo 100.64.0.9'
stub codex 'exit 0'
stub curl 'printf "{\"version\":1,\"claude\":{\"source\":\"statusline\"},\"codex\":{\"source\":\"app_server\"}}\n200"'

# A pre-existing statusline the installer must preserve, not clobber — including the OTHER keys
# inside `statusLine` (`padding` here), which a whole-object replace would drop — and its 0600 mode.
printf '{"model":"opus","statusLine":{"type":"command","command":"echo ORIGINAL-STATUSLINE","padding":2}}\n' > "$T/home/.claude/settings.json"
chmod 600 "$T/home/.claude/settings.json"
# The checkout's app.json as it is now. A default install and the test itself must leave it byte-for-byte
# unchanged; only the explicit --self-pack path may edit the throwaway copy below.
cp "$REPO/plugin/app.json" "$T/app.before.json"

n=0; ok() { n=$((n+1)); echo "  ok $n: $*"; }
die() { echo "  FAIL: $*" >&2; exit 1; }

# The self-pack fallback edits the plugin whitelist; tests point it at a copy so the checkout stays clean.
cp "$REPO/plugin/app.json" "$T/app.json"
export QUOTALENS_APP_JSON="$T/app.json"
run() { HOME="$T/home" PATH="$STUBS:$PATH" bash "$REPO/scripts/install.sh" --skip-npm-install "$@"; }

# 1. dry run writes nothing and renders a complete plist
out=$(run --dry-run)
[ ! -e "$T/home/Library" ] || die "dry run created files"
grep -q '<key>Label</key>' <<<"$out" || die "dry run did not render the plist"
grep -q '@@' <<<"$out" && die "dry run left a placeholder" || true
grep -q 'would add .* whitelist' <<<"$out" && die "default dry run would edit the plugin whitelist" || true
ok "dry run renders and writes nothing"

# 2. full run
run > "$T/run1.out"
PLIST="$T/home/Library/LaunchAgents/dev.bruce.quotalens.plist"
[ -f "$PLIST" ] || die "plist not written"
grep -q '@@' "$PLIST" && die "placeholder survived" || true
plutil -lint -s "$PLIST" || die "plist does not lint"
grep -q "<string>$REPO/daemon/src/index.ts</string>" "$PLIST" || die "repo path not substituted"
grep -q "$(dirname "$(command -v node)")" "$PLIST" || die "node dir not in PATH"
ok "plist rendered, linted, paths substituted"

grep -q 'launchctl bootstrap gui/' "$LOG" || die "bootstrap not called"
ok "launchctl bootstrap called"

host=$(jq -r .host "$T/home/.quotalens/config.json"); [ "$host" = 100.64.0.9 ] || die "host not recorded: $host"
[ "$(jq -r '.secret // "none"' "$T/home/.quotalens/config.json")" = none ] || die "M9: the installer must not create a secret"
[ "$(stat -f %Lp "$T/home/.quotalens/config.json")" = 600 ] || die "config.json not 0600"
ok "config.json has the tailnet host and no secret, mode 0600"

cmp -s "$T/app.json" "$T/app.before.json" || die "default install changed app.json"
cmp -s "$REPO/plugin/app.json" "$T/app.before.json" || die "the CHECKOUT's app.json was modified by the test"
grep -q 'would add .* whitelist\|added .* whitelist\|whitelist already lists' "$T/run1.out" && die "default install touched the plugin whitelist" || true
ok "default install leaves app.json byte-for-byte unchanged"

grep -q 'loopback  127.0.0.1:8787 → 200 claude=statusline codex=app_server' "$T/run1.out" || die "verify line missing"
grep -q 'http://100.64.0.9:8787 ' "$T/run1.out" || die "the relay address for the phone was not printed at the end"
grep -q 'Install QuotaLens from the Even Hub store' "$T/run1.out" || die "store install instruction missing"
grep -q 'usage.json' "$LOG" || die "the probe did not hit /usage.json"
grep -q '/u/' "$LOG" && die "the probe still uses the pre-M9 secret path" || true
ok "verification prints status + sources; the relay address is printed for the phone; the probe hits /usage.json"

cmd=$(jq -r .statusLine.command "$T/home/.claude/settings.json")
[ "$cmd" = "bash '$REPO/daemon/scripts/claude-statusline.sh'" ] || die "statusLine not wired: $cmd"
[ "$(jq -r .model "$T/home/.claude/settings.json")" = opus ] || die "other settings keys lost"
[ "$(jq -r .statusLine.padding "$T/home/.claude/settings.json")" = 2 ] || die "statusLine.padding lost: only .command may change"
[ "$(jq -r .statusLine.type "$T/home/.claude/settings.json")" = command ] || die "statusLine.type wrong"
[ "$(cat "$T/home/.quotalens/statusline-original.cmd")" = "echo ORIGINAL-STATUSLINE" ] || die "original command not saved"
[ "$(stat -f %Lp "$T/home/.quotalens/statusline-original.cmd")" = 600 ] || die ".cmd not 0600"
[ -f "$T/home/.claude/settings.json.quotalens-bak" ] || die "no settings backup"
[ "$(stat -f %Lp "$T/home/.claude/settings.json")" = 600 ] || die "settings.json mode loosened to $(stat -f %Lp "$T/home/.claude/settings.json")"
[ "$(stat -f %Lp "$T/home/.claude/settings.json.quotalens-bak")" = 600 ] || die "backup mode loosened"
ok "statusline wired; only statusLine changed; original saved 0600; backup taken; settings.json stays 0600"

# 3. the wrapper runs the saved original with the same stdin, and captures rate_limits
sl=$(printf '{"session_id":"x","rate_limits":{"five_hour":{"used_percentage":1}}}' | HOME="$T/home" QUOTALENS_DIR="$T/home/.quotalens" bash "$REPO/daemon/scripts/claude-statusline.sh")
[ "$sl" = ORIGINAL-STATUSLINE ] || die "wrapper did not run the original: '$sl'"
[ "$(jq -c .rate_limits.five_hour.used_percentage "$T/home/.quotalens/claude.json")" = 1 ] || die "claude.json not written"
grep -q session_id "$T/home/.quotalens/claude.json" && die "session_id leaked into claude.json" || true
ok "wrapper: original statusline output preserved, rate_limits captured, nothing else"

# 4. --self-pack adds this machine's origin; other files stay idempotent, and bootstrap happens only AFTER the old job is gone
#    (launchctl bootout is asynchronous: `print` keeps answering for a moment; seen on macOS 26, 2026-09-11).
cp "$PLIST" "$T/plist1"; cp "$T/home/.claude/settings.json" "$T/settings1"; cp "$T/home/.quotalens/config.json" "$T/config1"
: > "$LOG"
# `print` says "loaded" for the first three asks (the initial check + two polls), then "gone".
stub launchctl 'case "$1" in print) n=$(grep -c "^launchctl print" "'"$LOG"'"); [ "$n" -le 3 ] && exit 0; exit 1;; esac; exit 0'
run --self-pack > "$T/run2.out"
cmp -s "$PLIST" "$T/plist1" || die "plist changed on re-run"
cmp -s "$T/home/.claude/settings.json" "$T/settings1" || die "settings changed on re-run"
cmp -s "$T/home/.quotalens/config.json" "$T/config1" || die "config changed on re-run"
[ "$(jq '.permissions[] | select(.name=="network") | .whitelist | length' "$T/app.json")" = "$(( $(jq '.permissions[] | select(.name=="network") | .whitelist | length' "$REPO/plugin/app.json") + 1 ))" ] || die "whitelist grew again on re-run"
[ "$(jq -r '.permissions[] | select(.name=="network") | .whitelist | index("http://100.64.0.9:8787")' "$T/app.json")" != null ] || die "--self-pack did not add this machine's origin"
grep -q 'added .* plugin network whitelist' "$T/run2.out" || die "--self-pack did not report the added origin"
grep -q 'launchctl bootout gui/' "$LOG" || die "re-run did not bootout the loaded agent"
# Order in the call log: bootout, then print until it fails, then bootstrap — never bootstrap while print still succeeds.
seq=$(grep -oE '^launchctl (bootout|print|bootstrap)' "$LOG" | awk '{print $2}' | paste -sd, -)
case "$seq" in
  print,bootout,print,print,print,print,bootstrap) ;;
  *) die "bootstrap did not wait for the unload: $seq" ;;
esac
grep -q 'statusline already wired' "$T/run2.out" || die "re-run rewired statusline"
cp "$T/app.json" "$T/app.self-pack.json"
stub launchctl 'case "$1" in print) exit 1;; esac; exit 0'
run --self-pack > "$T/run2c.out"
cmp -s "$T/app.json" "$T/app.self-pack.json" || die "--self-pack grew the whitelist on re-run"
grep -q 'whitelist already lists' "$T/run2c.out" || die "--self-pack re-run did not recognise the origin"
ok "--self-pack adds one origin idempotently; other files remain stable and restart waits for unload"

# 4b. an agent that never unloads: the installer stops instead of bootstrapping over it
: > "$LOG"
stub launchctl 'case "$1" in print) exit 0;; esac; exit 0'
if run > "$T/run2b.out" 2>&1; then die "bootstrapped over a job that never unloaded"; fi
grep -q 'still loaded after bootout' "$T/run2b.out" || die "no clear message when the unload never completes"
grep -q '^launchctl bootstrap' "$LOG" && die "bootstrap was attempted anyway" || true
ok "a job that never unloads stops the installer with a message, no bootstrap attempted"

# 5. --no-statusline leaves settings alone
stub launchctl 'case "$1" in print) exit 1;; esac; exit 0'   # back to "not loaded"
rm -rf "$T/home2"; mkdir -p "$T/home2/.claude"; printf '{"statusLine":{"type":"command","command":"echo X"}}\n' > "$T/home2/.claude/settings.json"
HOME="$T/home2" PATH="$STUBS:$PATH" bash "$REPO/scripts/install.sh" --skip-npm-install --no-statusline > /dev/null
[ "$(jq -r .statusLine.command "$T/home2/.claude/settings.json")" = "echo X" ] || die "--no-statusline touched settings"
ok "--no-statusline leaves settings.json untouched"

# 6. bad tailscale answer fails loudly, before anything is written — and the value is NOT echoed
rm -rf "$T/home3"; mkdir -p "$T/home3"
stub launchctl 'case "$1" in print) exit 1;; esac; exit 0'
stub tailscale 'echo http://192.168.1.7:8787/u/SHOULD-NOT-BE-ECHOED/usage.json'
if HOME="$T/home3" PATH="$STUBS:$PATH" bash "$REPO/scripts/install.sh" --skip-npm-install > "$T/run3.out" 2>&1; then die "LAN address accepted"; fi
grep -q 'not a tailnet IPv4' "$T/run3.out" || die "no clear message for a bad host"
grep -q 'SHOULD-NOT-BE-ECHOED' "$T/run3.out" && die "the rejected host value was echoed" || true
[ ! -e "$T/home3/Library" ] || die "plist written despite setup failure"
ok "a non-tailnet address stops the installer before the agent is written, without echoing it"

# 6b. same, for a value that STARTS like an IP (M8 QA round five: a case glob let this one through)
#     …and for well-formed IPv4s OUTSIDE 100.64.0.0/10 (round six): the installer applies the same
#     range rule as daemon/src/config.ts, so a dry run reaches the verdict without setup.ts, and the
#     value is not printed on the way.
for bad in 'http://192.168.1.7:8787/u/SHOULD-NOT-BE-ECHOED/usage.json' '100.7http://relay/u/SHOULD-NOT-BE-ECHOED/usage.2.3' '100.64.0.9/u/SHOULD-NOT-BE-ECHOED/usage.json' '100.128.0.1' '100.63.255.255' '100.64.0.256'; do
  case "$bad" in *SHOULD-NOT-BE-ECHOED*) marker=SHOULD-NOT-BE-ECHOED ;; *) marker="$bad" ;; esac
  rm -rf "$T/home3"; mkdir -p "$T/home3"
  stub tailscale "echo '$bad'"
  if HOME="$T/home3" PATH="$STUBS:$PATH" bash "$REPO/scripts/install.sh" --skip-npm-install > "$T/run3.out" 2>&1; then die "accepted: $bad"; fi
  grep -qF "$marker" "$T/run3.out" && die "echoed: $bad" || true
  if HOME="$T/home3" PATH="$STUBS:$PATH" bash "$REPO/scripts/install.sh" --skip-npm-install --dry-run > "$T/run3d.out" 2>&1; then die "dry run accepted: $bad"; fi
  grep -qF "$marker" "$T/run3d.out" && die "dry run echoed: $bad" || true
  grep -q 'not a tailnet IPv4' "$T/run3d.out" || die "dry run did not reach the range verdict itself: $bad"
done
ok "junk and out-of-range addresses from tailscale are rejected without being echoed, in dry run too"

# 7. a daemon that does not answer (or answers something else) fails the install, after the plist is loaded
stub launchctl 'case "$1" in print) exit 1;; esac; exit 0'
stub tailscale 'echo 100.64.0.9'
for answer in 'printf "\n000"' 'printf "<html>proxy</html>\n200"' 'printf "{\"version\":1,\"claude\":{\"source\":\"statusline\"}}\n200"' 'exit 7'; do
  rm -rf "$T/home4"; mkdir -p "$T/home4"
  stub curl "$answer"
  if HOME="$T/home4" PATH="$STUBS:$PATH" bash "$REPO/scripts/install.sh" --skip-npm-install > "$T/run4.out" 2>&1; then die "installer said done over a dead/foreign endpoint: $answer"; fi
  grep -q 'not answering' "$T/run4.out" || die "no clear message for a failed probe: $answer"
  grep -q '▸ done' "$T/run4.out" && die "printed done after a failed probe" || true
done
# …and loopback fine but the tailnet address dead (the daemon never bound it) fails too, naming the tailnet side.
stub curl 'case "$*" in *127.0.0.1*) printf "{\"version\":1,\"claude\":{\"source\":\"statusline\"},\"codex\":{\"source\":\"app_server\"}}\n200";; *) printf "\n000";; esac'
rm -rf "$T/home4"; mkdir -p "$T/home4"
if HOME="$T/home4" PATH="$STUBS:$PATH" bash "$REPO/scripts/install.sh" --skip-npm-install > "$T/run4.out" 2>&1; then die "installer said done with the tailnet probe failing"; fi
grep -q 'tailnet address' "$T/run4.out" || die "the failure did not name the tailnet side"
ok "a dead, foreign or half-bound daemon fails the install with a clear message"

# 8. a checkout path with spaces and XML/sed/shell specials: the plist stays valid and the statusline command still runs
stub curl 'printf "{\"version\":1,\"claude\":{\"source\":\"statusline\"},\"codex\":{\"source\":\"app_server\"}}\n200"'
ODD="$T/odd dir & <x> | y'z"
mkdir -p "$ODD" && ln -s "$REPO/daemon" "$ODD/daemon" && ln -s "$REPO/scripts" "$ODD/scripts" && ln -s "$REPO/node_modules" "$ODD/node_modules" && ln -s "$REPO/package.json" "$ODD/package.json"
rm -rf "$T/home5"; mkdir -p "$T/home5/.claude"; printf '{"statusLine":{"type":"command","command":"echo ORIGINAL-STATUSLINE"}}\n' > "$T/home5/.claude/settings.json"
HOME="$T/home5" PATH="$STUBS:$PATH" bash "$ODD/scripts/install.sh" --skip-npm-install --self-pack > "$T/run5.out" 2>&1 || die "installer failed on an odd path: $(tail -3 "$T/run5.out")"
P5="$T/home5/Library/LaunchAgents/dev.bruce.quotalens.plist"
plutil -lint -s "$P5" || die "plist with specials does not lint"
[ "$(plutil -extract WorkingDirectory raw -o - "$P5")" = "$ODD" ] || die "WorkingDirectory round-trip lost the specials: $(plutil -extract WorkingDirectory raw -o - "$P5")"
sl=$(printf '{"rate_limits":{"five_hour":{"used_percentage":3}}}' | HOME="$T/home5" QUOTALENS_DIR="$T/home5/.quotalens" bash -c "$(jq -r .statusLine.command "$T/home5/.claude/settings.json")")
[ "$sl" = ORIGINAL-STATUSLINE ] || die "the stored statusline command does not run from an odd path: '$sl'"
ok "an odd checkout path survives the plist and the statusline command"

# 9. a fresh checkout without node_modules completes a dry run, but a real skipped install still fails
FRESH="$T/fresh clone"
mkdir -p "$FRESH" && ln -s "$REPO/daemon" "$FRESH/daemon" && ln -s "$REPO/scripts" "$FRESH/scripts" && ln -s "$REPO/package.json" "$FRESH/package.json"
rm -rf "$T/home-fresh"; mkdir -p "$T/home-fresh"
HOME="$T/home-fresh" PATH="$STUBS:$PATH" bash "$FRESH/scripts/install.sh" --dry-run > "$T/run-fresh-dry.out" 2>&1 || die "fresh-clone dry run failed: $(tail -3 "$T/run-fresh-dry.out")"
grep -q '▸ would run: npm install' "$T/run-fresh-dry.out" || die "fresh-clone dry run did not report npm install"
grep -q '<key>Label</key>' "$T/run-fresh-dry.out" || die "fresh-clone dry run did not render the plist"
[ -z "$(find "$T/home-fresh" -mindepth 1 -print -quit)" ] || die "fresh-clone dry run wrote under HOME"
if HOME="$T/home-fresh" PATH="$STUBS:$PATH" bash "$FRESH/scripts/install.sh" --skip-npm-install > "$T/run-fresh-real.out" 2>&1; then die "fresh checkout accepted --skip-npm-install without tsx"; fi
grep -q 'node_modules/tsx missing' "$T/run-fresh-real.out" || die "fresh checkout lost the missing-tsx error"
ok "fresh checkout dry-runs without node_modules; non-dry skipped install still fails"

# 10. a settings.json wired by the pre-quoting installer (`bash /path/claude-statusline.sh`) is "already
#    wired": the wrapper must never be saved as the original (that is a wrapper calling itself), and the
#    wrapper itself refuses a .cmd that names it.
stub launchctl 'case "$1" in print) exit 1;; esac; exit 0'
rm -rf "$T/home6"; mkdir -p "$T/home6/.claude" "$T/home6/.quotalens"
printf '{"statusLine":{"type":"command","command":"bash %s/daemon/scripts/claude-statusline.sh"}}\n' "$REPO" > "$T/home6/.claude/settings.json"
chmod 600 "$T/home6/.claude/settings.json"
printf '{"statusLine":{"type":"command","command":"bash %s/daemon/scripts/claude-statusline.sh"}}\n' "$REPO" > "$T/home6/.claude/settings.json.quotalens-bak"
HOME="$T/home6" PATH="$STUBS:$PATH" bash "$REPO/scripts/install.sh" --skip-npm-install > "$T/run6.out" 2>&1 || die "installer failed on an old-form wiring: $(tail -3 "$T/run6.out")"
grep -q 'statusline already wired' "$T/run6.out" || die "old-form wiring was not recognised as ours"
[ ! -e "$T/home6/.quotalens/statusline-original.cmd" ] || die "the wrapper was saved as the original command"
# …and the old unquoted form is upgraded to the quoted one (it breaks on a path with spaces), the original
# backup untouched and a dated backup of the pre-rewrite settings taken.
[ "$(jq -r .statusLine.command "$T/home6/.claude/settings.json")" = "bash '$REPO/daemon/scripts/claude-statusline.sh'" ] || die "old-form command was left unquoted: $(jq -r .statusLine.command "$T/home6/.claude/settings.json")"
grep -q 'claude-statusline.sh"' "$T/home6/.claude/settings.json.quotalens-bak" || die "the backup was rewritten"
ls "$T/home6/.claude/settings.json.quotalens-bak."2* >/dev/null 2>&1 || die "no dated backup taken before the re-quote"
[ "$(stat -f %Lp "$T/home6/.claude/settings.json")" = 600 ] || die "re-quote loosened settings.json to $(stat -f %Lp "$T/home6/.claude/settings.json")"
# A CUSTOM command that merely mentions the wrapper is the owner's: not rewritten, not saved as original.
custom="bash $T/mine.sh | bash '$REPO/daemon/scripts/claude-statusline.sh'"
rm -rf "$T/home7"; mkdir -p "$T/home7/.claude"; jq -n --arg c "$custom" '{statusLine:{type:"command",command:$c}}' > "$T/home7/.claude/settings.json"
HOME="$T/home7" PATH="$STUBS:$PATH" bash "$REPO/scripts/install.sh" --skip-npm-install > "$T/run7.out" 2>&1 || die "installer failed on a custom wrapping: $(tail -3 "$T/run7.out")"
[ "$(jq -r .statusLine.command "$T/home7/.claude/settings.json")" = "$custom" ] || die "custom statusline was rewritten"
grep -q 'custom command' "$T/run7.out" || die "no warning for a custom wrapping"
[ ! -e "$T/home7/.quotalens/statusline-original.cmd" ] || die "custom wrapping saved as original"
printf 'bash %s/daemon/scripts/claude-statusline.sh\n' "$REPO" > "$T/home6/.quotalens/statusline-original.cmd"
# No `timeout` here: macOS ships none, and the guard is a plain `case` — a recursion would show up
# as a process-table storm, not a hang the suite could wait out anyway.
sl=$(printf '{"rate_limits":{"five_hour":{"used_percentage":1}}}' | HOME="$T/home6" QUOTALENS_DIR="$T/home6/.quotalens" bash "$REPO/daemon/scripts/claude-statusline.sh"; echo "rc=$?")
[ "$sl" = "rc=0" ] || die "wrapper recursed or failed on a self-referencing .cmd: '$sl'"
ok "old-form wiring is recognised; the wrapper never runs itself"

# 11. the owner removed their statusline (no statusLine.command) but a .cmd from an earlier install is
#     still around: it must go, or the wrapper resurrects the removed statusline.
stub launchctl 'case "$1" in print) exit 1;; esac; exit 0'
rm -rf "$T/home8"; mkdir -p "$T/home8/.claude" "$T/home8/.quotalens"
printf '{"model":"opus"}\n' > "$T/home8/.claude/settings.json"
printf 'echo STALE-STATUSLINE\n' > "$T/home8/.quotalens/statusline-original.cmd"
HOME="$T/home8" PATH="$STUBS:$PATH" bash "$REPO/scripts/install.sh" --skip-npm-install > "$T/run8.out" 2>&1 || die "installer failed with no statusline configured: $(tail -3 "$T/run8.out")"
[ ! -e "$T/home8/.quotalens/statusline-original.cmd" ] || die "stale .cmd survived with no statusline configured"
sl=$(printf '{"rate_limits":{"five_hour":{"used_percentage":1}}}' | HOME="$T/home8" QUOTALENS_DIR="$T/home8/.quotalens" bash -c "$(jq -r .statusLine.command "$T/home8/.claude/settings.json")")
[ -z "$sl" ] || die "the removed statusline came back: '$sl'"
ok "a stale .cmd is removed when no statusline is configured; the wrapper prints nothing"

echo "install.test.sh: $n checks passed"
