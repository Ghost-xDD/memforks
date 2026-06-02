#!/usr/bin/env bash
# Standalone tests for the Codex plugin hooks.
# No network, no credentials — tests shell behaviour and JSON output only.
#
# Run: bash test-hooks.sh

set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../plugins/codex/hooks" && pwd)"
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
echo "── Codex plugin hook tests ────────────────────────────────────────────────"
echo ""

# ── session-start: no CLI ─────────────────────────────────────────────────────
(
  export PATH="/nonexistent:$PATH"
  OUT=$(run_hook "session-start.sh" '{}')
  if valid_json "$OUT"; then
    ok "session-start returns valid JSON when CLI is missing"
  else
    fail "session-start JSON invalid: $OUT"
  fi
  if echo "$OUT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'systemMessage' in d" 2>/dev/null; then
    ok "session-start returns systemMessage key"
  else
    fail "session-start missing systemMessage: $OUT"
  fi
)

# ── user-prompt-submit: short prompt is skipped ───────────────────────────────
OUT=$(run_hook "user-prompt-submit.sh" '{"userPrompt": "ok"}')
if [ "$OUT" = "{}" ]; then
  ok "user-prompt-submit returns {} for short prompt (<20 chars)"
else
  fail "user-prompt-submit should skip short prompts: $OUT"
fi

# ── user-prompt-submit: no CLI → returns {} ───────────────────────────────────
(
  export PATH="/nonexistent:$PATH"
  OUT=$(run_hook "user-prompt-submit.sh" '{"userPrompt": "what do we know about the database architecture?"}')
  if [ "$OUT" = "{}" ]; then
    ok "user-prompt-submit returns {} gracefully when CLI is missing"
  else
    fail "user-prompt-submit should fail silently: $OUT"
  fi
)

# ── stop: re-entrant guard ────────────────────────────────────────────────────
OUT=$(run_hook "stop.sh" '{"stop_hook_active": true}')
if [ "$OUT" = "{}" ]; then
  ok "stop returns {} when stop_hook_active=true"
else
  fail "stop re-entrant guard failed: $OUT"
fi

# ── stop: MEMFORK_NO_CAPTURE=1 ────────────────────────────────────────────────
OUT=$(MEMFORK_NO_CAPTURE=1 run_hook "stop.sh" '{"response": "this is a long response with architectural decisions and project preferences that should be remembered"}')
if [ "$OUT" = "{}" ]; then
  ok "stop returns {} when MEMFORK_NO_CAPTURE=1"
else
  fail "stop should respect MEMFORK_NO_CAPTURE: $OUT"
fi

# ── stop: short response skipped ─────────────────────────────────────────────
OUT=$(run_hook "stop.sh" '{"response": "ok done"}')
if [ "$OUT" = "{}" ]; then
  ok "stop returns {} for short response"
else
  fail "stop should skip short responses: $OUT"
fi

# ── stop: no CLI → {} ────────────────────────────────────────────────────────
(
  export PATH="/nonexistent:$PATH"
  OUT=$(run_hook "stop.sh" '{"response": "here is a long response about the system design and architecture we discussed today for the project"}')
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
