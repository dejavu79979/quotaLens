#!/usr/bin/env bash
# QuotaLens statusline wrapper (PLAN.md T1.2, C8).
# 1. Capture the `rate_limits` subset of the JSON Claude Code pipes to the status line
#    into ~/.quotalens/claude.json as {"rate_limits":{...}} (atomic: tmp file in the same
#    dir + mv). Written only when stdin is valid JSON AND .rate_limits is non-null;
#    before the session's first API response rate_limits is absent, so the previous
#    file is kept. Nothing else from stdin (session_id, cwd, transcript_path…) lands on disk.
# 2. Feed the same stdin to the user's original status line command — the one
#    scripts/install.sh saved to ~/.quotalens/statusline-original.cmd (M8 T8.2) — and
#    print its output unchanged. No saved command → print nothing. Any failure here must
#    never break the status line: always exit 0, never print stdin or errors to stdout/stderr.
set -u
umask 077

OUT_DIR="${QUOTALENS_DIR:-$HOME/.quotalens}"
OUT_FILE="$OUT_DIR/claude.json"

input="$(cat)"

# jq -e exits 1 when the result is null/false, so an absent or null .rate_limits skips the write.
subset="$(printf '%s' "$input" | jq -ce 'select(.rate_limits != null) | {rate_limits}' 2>/dev/null)" || subset=""

if [ -n "$subset" ]; then
  if mkdir -p "$OUT_DIR" 2>/dev/null; then
    tmp="$(mktemp "$OUT_DIR/.claude.json.XXXXXX" 2>/dev/null)" || tmp=""
    if [ -n "$tmp" ]; then
      if printf '%s\n' "$subset" >"$tmp" 2>/dev/null; then
        mv -f "$tmp" "$OUT_FILE" 2>/dev/null || rm -f "$tmp" 2>/dev/null
      else
        rm -f "$tmp" 2>/dev/null
      fi
    fi
  fi
fi

# --- original status line (whatever statusLine.command was before the installer ran) ---
# Read back from the file the installer wrote rather than inlined, so the same wrapper
# serves every machine (M8 T8.2). The file holds one shell command line; it is run the
# way Claude Code would have run it, with the same stdin.
ORIG_CMD_FILE="$OUT_DIR/statusline-original.cmd"
if [ -r "$ORIG_CMD_FILE" ]; then
  orig_cmd="$(cat "$ORIG_CMD_FILE")"
  # Never run ourselves: a `.cmd` that names this wrapper (an installer mistake, or a hand edit)
  # would recurse until the process table fills. Print nothing instead.
  case "$orig_cmd" in
    *claude-statusline.sh*) : ;;
    *) printf '%s' "$input" | bash -c "$orig_cmd" 2>/dev/null || : ;;
  esac
fi
exit 0
