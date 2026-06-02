#!/usr/bin/env bash
# Standalone tests for the Cursor plugin hooks.
# No network, no credentials — tests shell behaviour and JSON output only.
#
# Run: bash test-hooks.sh
# Or:  chmod +x test-hooks.sh && ./test-hooks.sh

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../plugins/cursor/hooks" && pwd)"
PASS=0; FAIL=0

ok()  { echo "  ✓  $1"; PASS=$((PASS+1)); }
fail(){ echo "  ✗  $1"; FAIL=$((FAIL+1)); }

run_hook() {
  local hook="$1" input="$2"
  bash "$PLUGIN_DIR/$hook" <<< "$input" 2>/dev/null
}

valid_json() {
  echo "$1" | python3 -m json.tool > /dev/null 2>&1
}

echo ""
echo "── Cursor plugin hook tests ───────────────────────────────────────────────"
echo ""

# ── session-start: CLI missing ────────────────────────────────────────────────
# Temporarily hide memfork so the hook gets no CLI
(
  export PATH="/nonexistent:$PATH"
  OUT=$(run_hook "memforks-session-start.sh" '{}')
  if valid_json "$OUT"; then
    ok "session-start returns valid JSON when CLI is missing"
  else
    fail "session-start JSON invalid: $OUT"
  fi
  if echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'additional_context' in d" 2>/dev/null; then
    ok "session-start returns additional_context key"
  else
    fail "session-start missing additional_context"
  fi
)

# ── stop: re-entrant guard ────────────────────────────────────────────────────
OUT=$(run_hook "memforks-stop.sh" '{"stop_hook_active": true}')
if [ "$OUT" = "{}" ]; then
  ok "stop returns {} when stop_hook_active=true (re-entrant guard)"
else
  fail "stop re-entrant guard failed: $OUT"
fi

# ── stop: MEMFORK_NO_CAPTURE=1 ────────────────────────────────────────────────
OUT=$(MEMFORK_NO_CAPTURE=1 run_hook "memforks-stop.sh" '{"response": "here is a long response with facts about the project architecture and design decisions"}')
if [ "$OUT" = "{}" ]; then
  ok "stop returns {} when MEMFORK_NO_CAPTURE=1"
else
  fail "stop should respect MEMFORK_NO_CAPTURE: $OUT"
fi

# ── stop: short response is skipped ──────────────────────────────────────────
OUT=$(run_hook "memforks-stop.sh" '{"response": "ok"}')
if [ "$OUT" = "{}" ]; then
  ok "stop returns {} for short response (<40 chars)"
else
  fail "stop should skip short responses: $OUT"
fi

# ── stop: no CLI → returns {} ────────────────────────────────────────────────
(
  export PATH="/nonexistent:$PATH"
  OUT=$(run_hook "memforks-stop.sh" '{"response": "this is a long response about the project architecture and how the system works in detail"}')
  if [ "$OUT" = "{}" ]; then
    ok "stop returns {} gracefully when CLI is missing"
  else
    fail "stop should fail silently with no CLI: $OUT"
  fi
)

echo ""
echo "── Results ────────────────────────────────────────────────────────────────"
echo "  passed: $PASS   failed: $FAIL"
echo ""

[ $FAIL -eq 0 ] || exit 1
