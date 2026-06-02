#!/usr/bin/env bash
# Cursor sessionStart hook: recall memory for the current Git branch and
# return it as `additional_context` for the agent.

INPUT=$(cat)

_json_encode_str() {
  printf '%s' "$1" \
    | python3 -c "import json,sys; print(json.dumps(sys.stdin.read()))" 2>/dev/null \
    | sed 's/^"//; s/"$//'
}

# Resolve memfork CLI.
if command -v memfork &>/dev/null; then
  MEMFORK_CMD="memfork"
elif [ -x "./node_modules/.bin/memfork" ]; then
  MEMFORK_CMD="./node_modules/.bin/memfork"
else
  echo '{"additional_context": "[MemForks] CLI not found. Run: npm install -g @memfork/cli"}'
  exit 0
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")

RECALL_JSON=$($MEMFORK_CMD recall --branch "$BRANCH" --limit 8 --json 2>/dev/null)

if [ -z "$RECALL_JSON" ] || [ "$RECALL_JSON" = "[]" ]; then
  echo "{\"additional_context\": \"[MemForks] Branch: $BRANCH | No prior memory yet.\"}"
  exit 0
fi

MEMORY_TEXT=$(python3 -c "
import json, sys
items = json.loads(sys.argv[1])
lines = [f'[MemForks] Branch: {sys.argv[2]} | Recalled memory:']
for i, item in enumerate(items, 1):
    text = item.get('text', '').strip()
    if text:
        lines.append(f'  {i}. {text}')
print('\n'.join(lines))
" "$RECALL_JSON" "$BRANCH" 2>/dev/null)

CTX=$(python3 -c "import json,sys; print(json.dumps(sys.argv[1]))" "$MEMORY_TEXT" 2>/dev/null)
echo "{\"additional_context\": $CTX}"
exit 0
