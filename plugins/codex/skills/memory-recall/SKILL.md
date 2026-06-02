---
name: memory-recall
description: >-
  Recall relevant memory for the current task using the MemWal MCP tool.
  Use when the user asks about prior decisions, past context, or what you remember.
---

# Memory Recall

Memory is stored via the **MemWal MCP server** — use `memwal_recall` directly as a tool call.
Do not run `memfork recall` from the shell; the MCP tool is faster and context-aware.

## Usage

```
memwal_recall(
  query="<natural language — what you want to find>",
  namespace="branch/<current-git-branch>",
  limit=5
)
```

Examples:
```
memwal_recall(query="auth system design", namespace="branch/main")
memwal_recall(query="database schema decisions", namespace="branch/feature/payments")
memwal_recall(query="what do we know about the API rate limits?", limit=10)
```

## Rules

- Always scope to the current Git branch namespace unless the user asks for cross-branch context.
- High relevance scores = verified prior context.
- If recall returns nothing, tell the user memory is empty for this branch and offer to start capturing.
- Never fabricate facts — only use what `memwal_recall` returns.

## After recalling

If relevant facts were found, summarise them briefly before answering. Cite them as
"from memory" so the user knows they come from a prior session.
