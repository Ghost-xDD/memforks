#!/usr/bin/env bash
# UserPromptSubmit hook: if the prompt looks like it might benefit from a
# memory recall (e.g. contains recall-triggering keywords), inject the top
# matching facts as additional context. Short/conversational prompts are
# skipped to avoid unnecessary latency.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/common.sh"

# ─── Gate: skip trivial prompts ───────────────────────────────────────────────

PROMPT=$(_json_val "$INPUT" "userPrompt" "")
PROMPT_LEN=${#PROMPT}

# Prompts under 20 chars are almost certainly "ok", "thanks", etc.
if [ "$PROMPT_LEN" -lt 20 ]; then
  echo '{}'
  exit 0
fi

# ─── Gate: CLI not available ──────────────────────────────────────────────────

if [ -z "$MEMFORK_CMD" ]; then
  echo '{}'
  exit 0
fi

# ─── Semantic recall against the prompt ──────────────────────────────────────

BRANCH=$(_current_git_branch)
RECALL_JSON=$($MEMFORK_CMD recall "$PROMPT" --branch "$BRANCH" --limit 3 --json 2>/dev/null)

if [ -z "$RECALL_JSON" ] || [ "$RECALL_JSON" = "[]" ]; then
  echo '{}'
  exit 0
fi

# Check if any result is close enough to be useful (distance < 0.35).
RELEVANT=$(python3 -c "
import json, sys
items = json.loads(sys.argv[1])
relevant = [i for i in items if i.get('distance', 1) < 0.35]
print(json.dumps(relevant))
" "$RECALL_JSON" 2>/dev/null)

if [ -z "$RELEVANT" ] || [ "$RELEVANT" = "[]" ]; then
  echo '{}'
  exit 0
fi

# Format as a short injected context block.
CONTEXT=$(python3 -c "
import json, sys
items = json.loads(sys.argv[1])
lines = ['[MemForks] Relevant prior memory for this prompt:']
for i, item in enumerate(items, 1):
    text = item.get('text', '').strip()
    if text:
        lines.append(f'  {i}. {text}')
print('\n'.join(lines))
" "$RELEVANT" 2>/dev/null)

json_ctx=$(_json_encode_str "$CONTEXT")
echo "{\"contextInjection\": \"$json_ctx\"}"
exit 0
