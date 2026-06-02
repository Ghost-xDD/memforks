#!/usr/bin/env bash
# common.sh — shared utilities for all MemForks Codex hooks.

# ─── JSON helpers ─────────────────────────────────────────────────────────────

_json_encode_str() {
  # Encode a string for safe embedding in a JSON value.
  printf '%s' "$1" \
    | sed 's/\\/\\\\/g; s/"/\\"/g; s/$/\\n/g' \
    | tr -d '\n' \
    | sed 's/\\n$//'
}

_json_val() {
  # Extract a scalar value from a JSON string using Python (always available).
  local json="$1" key="$2" default="${3:-}"
  python3 -c "
import json, sys
try:
    d = json.loads(sys.argv[1])
    print(d.get(sys.argv[2], sys.argv[3]))
except Exception:
    print(sys.argv[3])
" "$json" "$key" "$default" 2>/dev/null || echo "$default"
}

# ─── MemForks CLI resolution ───────────────────────────────────────────────────

# The plugin looks for a `memfork` binary in the following order:
#   1. $MEMFORK_CMD   — explicit override (e.g. for local dev)
#   2. ./node_modules/.bin/memfork — project-local install
#   3. memfork on $PATH           — global install via `npm i -g @memfork/cli`
#   4. npx @memfork/cli           — fallback (slower)

if [ -z "${MEMFORK_CMD:-}" ]; then
  if command -v memfork &>/dev/null; then
    MEMFORK_CMD="memfork"
  elif [ -x "./node_modules/.bin/memfork" ]; then
    MEMFORK_CMD="./node_modules/.bin/memfork"
  else
    MEMFORK_CMD=""
  fi
fi

MEMFORK_INSTALL_HINT="Install MemForks CLI: npm install -g @memfork/cli"

# ─── Git branch detection ─────────────────────────────────────────────────────

_current_git_branch() {
  git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main"
}

# ─── stdin capture (Codex passes the hook event payload on stdin) ─────────────

INPUT=$(cat)
export INPUT
