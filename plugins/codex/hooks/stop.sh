#!/usr/bin/env bash
# Stop hook: extract memory-worthy facts from the agent's final response and
# commit them to the current branch via `memfork commit`.
#
# Escape hatches (env vars):
#   MEMFORK_NO_CAPTURE=1   disable auto-commit of facts
#   MEMFORK_BRANCH=<name>  override branch (defaults to current git branch)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# ─── Guard: re-entrant stop hook ─────────────────────────────────────────────

STOP_HOOK_ACTIVE=$(_json_val "$INPUT" "stop_hook_active" "false")
if [ "$STOP_HOOK_ACTIVE" = "true" ]; then
  echo '{}'
  exit 0
fi

# ─── Guard: capture disabled ──────────────────────────────────────────────────

if [ "${MEMFORK_NO_CAPTURE:-0}" = "1" ]; then
  echo '{}'
  exit 0
fi

# ─── Guard: CLI not available ──────────────────────────────────────────────────

if [ -z "$MEMFORK_CMD" ]; then
  echo '{}'
  exit 0
fi

# ─── Extract the assistant's final response ───────────────────────────────────

RESPONSE=$(_json_val "$INPUT" "response" "")
if [ -z "$RESPONSE" ] || [ ${#RESPONSE} -lt 40 ]; then
  echo '{}'
  exit 0
fi

BRANCH="${MEMFORK_BRANCH:-$(_current_git_branch)}"

# ─── Summarise into discrete facts via the LLM ───────────────────────────────
# We call `memfork commit --auto` which internally uses the configured LLM to
# extract memory-worthy facts from the turn transcript and commits them.
# Falls back to storing the summary as-is if the LLM call fails.

COMMIT_MSG="auto: session turn on branch $BRANCH"

$MEMFORK_CMD commit \
  --branch "$BRANCH" \
  --message "$COMMIT_MSG" \
  --from-response "$RESPONSE" \
  --auto-extract \
  > /tmp/memfork-commit.out 2>&1

COMMIT_EXIT=$?

if [ $COMMIT_EXIT -eq 0 ]; then
  DIGEST=$(grep -o '"digest":"[^"]*"' /tmp/memfork-commit.out | head -1 | cut -d'"' -f4)
  if [ -n "$DIGEST" ]; then
    msg=$(_json_encode_str "[MemForks] Committed to branch $BRANCH (tx: ${DIGEST:0:12}…)")
    echo "{\"systemMessage\": \"$msg\"}"
  else
    echo '{}'
  fi
else
  # Non-fatal: don't block the user.
  echo '{}'
fi

exit 0
