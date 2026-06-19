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

MemWal namespaces are scoped to the tree in the form `memforks/<treeId>/<branch>`.
Get the correct namespace first:

```bash
memfork namespace                  # current branch
memfork namespace feat/auth        # specific branch
```

Then recall:

```
memwal_recall(
  query="<natural language — what you want to find>",
  namespace="memforks/<treeId>/<current-git-branch>",
  limit=5
)
```

If you cannot run `memfork namespace`, omit `namespace` entirely — MemWal will search
the full account across all branches.

Examples:
```
memwal_recall(query="auth system design", namespace="memforks/<treeId>/main")
memwal_recall(query="database schema decisions", namespace="memforks/<treeId>/feature/payments")
memwal_recall(query="what do we know about the API rate limits?", limit=10)
```

## Rules

- Always scope to the current Git branch namespace unless the user asks for cross-branch context.
  Use `memfork namespace` to get the exact string; never guess `branch/<name>`.
- High relevance scores = verified prior context.
- If recall returns nothing, tell the user memory is empty for this branch and offer to start capturing.
- Never fabricate facts — only use what `memwal_recall` returns.

## After recalling

If relevant facts were found, summarise them briefly before answering. Cite them as
"from memory" so the user knows they come from a prior session.
