#!/usr/bin/env bash
# Cursor stop hook: auto-commit the turn's learned facts to the current branch.
# Non-blocking — failures are silent so the user is never interrupted.
#
# Escape hatch: set MEMFORK_NO_CAPTURE=1 to disable.

INPUT=$(cat)

if [ "${MEMFORK_NO_CAPTURE:-0}" = "1" ]; then
  echo '{}'
  exit 0
fi

# Infinite-loop guard.
STOP_ACTIVE=$(python3 -c "
import json,sys
d=json.loads(sys.argv[1])
print(str(d.get('stop_hook_active', False)).lower())
" "$INPUT" 2>/dev/null || echo "false")

if [ "$STOP_ACTIVE" = "true" ]; then
  echo '{}'
  exit 0
fi

# Resolve CLI.
if command -v memfork &>/dev/null; then
  MEMFORK_CMD="memfork"
elif [ -x "./node_modules/.bin/memfork" ]; then
  MEMFORK_CMD="./node_modules/.bin/memfork"
else
  echo '{}'
  exit 0
fi

BRANCH="${MEMFORK_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")}"

# Extract the agent's final response text.
RESPONSE=$(python3 -c "
import json,sys
d=json.loads(sys.argv[1])
print(d.get('response', ''))
" "$INPUT" 2>/dev/null || echo "")

if [ ${#RESPONSE} -lt 40 ]; then
  echo '{}'
  exit 0
fi

# Commit with --auto-extract: the CLI calls the configured LLM to distill
# durable facts from the response before writing to MemWal/Sui.
$MEMFORK_CMD commit \
  --branch "$BRANCH" \
  --message "auto: cursor turn" \
  --from-response "$RESPONSE" \
  --auto-extract \
  >/dev/null 2>&1 &

echo '{}'
exit 0
