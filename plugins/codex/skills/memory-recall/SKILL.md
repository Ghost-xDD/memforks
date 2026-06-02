---
name: memory-recall
description: >-
  Recall relevant on-chain memory for the current task. Use when you need
  prior context, decisions, or facts about this project or branch.
---
# MemForks Memory Recall

When the user asks about prior decisions, past context, or what you "remember",
use the `memfork recall` command to search semantic memory for this branch.

## Usage

```bash
# Recall top 5 facts relevant to a query
memfork recall "what do we know about the auth system?" --branch <current-branch> --limit 5

# Get all recent facts (no query filter)
memfork recall --branch <current-branch> --limit 10
```

## Output

Each result includes:
- `text` — the recalled fact or summary
- `distance` — semantic distance (0 = exact, <0.3 = very relevant)
- `blobId` — MemWal blob ID (verifiable on-chain)

## Rules

- Always scope recall to the current Git branch unless the user asks for cross-branch context.
- Facts with `distance < 0.35` are considered relevant.
- If recall returns nothing, tell the user memory is empty for this branch and offer to start capturing.
- Never fabricate facts — only use what `memfork recall` returns.
