#!/usr/bin/env bash
# SessionStart hook: recall memory for the current Git branch and inject it
# as a system message so Codex has full project context from the first turn.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# ─── Guard: CLI not installed ─────────────────────────────────────────────────

if [ -z "$MEMFORK_CMD" ]; then
  status="[MemForks] $MEMFORK_INSTALL_HINT — memory recall disabled for this session."
  json_status=$(_json_encode_str "$status")
  echo "{\"systemMessage\": \"$json_status\"}"
  exit 0
fi

# ─── Detect current branch ────────────────────────────────────────────────────

BRANCH=$(_current_git_branch)

# ─── Recall top facts from this branch ───────────────────────────────────────
# `memfork recall` returns a JSON array of { text, distance, blobId } objects.
# We take the top 10 and format them as a numbered list.

RECALL_JSON=$($MEMFORK_CMD recall --branch "$BRANCH" --limit 10 --json 2>/dev/null)
RECALL_EXIT=$?

if [ $RECALL_EXIT -ne 0 ] || [ -z "$RECALL_JSON" ] || [ "$RECALL_JSON" = "[]" ]; then
  status="[MemForks] Branch: $BRANCH | No prior memory — start working and I'll learn as we go."
  json_status=$(_json_encode_str "$status")
  echo "{\"systemMessage\": \"$json_status\"}"
  exit 0
fi

# Format recall output as a readable list.
MEMORY_LIST=$(python3 -c "
import json, sys
items = json.loads(sys.argv[1])
lines = []
for i, item in enumerate(items, 1):
    text = item.get('text', '').strip()
    if text:
        lines.append(f'{i}. {text}')
print('\n'.join(lines))
" "$RECALL_JSON" 2>/dev/null)

# ─── Compose system message ───────────────────────────────────────────────────

HEADER="[MemForks] Branch: $BRANCH | Recalled ${#MEMORY_LIST} facts from on-chain memory:"
FULL_MSG="$HEADER

$MEMORY_LIST

These facts are verified on Sui and anchored in MemWal. Use them as ground truth for this session."

json_msg=$(_json_encode_str "$FULL_MSG")
echo "{\"systemMessage\": \"$json_msg\"}"
exit 0
