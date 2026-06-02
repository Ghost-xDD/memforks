---
name: memforks-status
description: >-
  Show MemForks branch status, open merge proposals, and recent commits.
  Use when the user asks for memory status, proposals, or the commit log.
---
# MemForks Status

Use these commands to surface the current state of the memory tree.

## Commands

```bash
# Show current branch, head commit, and open proposals
memfork status

# List recent commits on this branch
memfork log --branch <branch> --limit 10

# List all open merge proposals
memfork proposals

# Open the MemForks visualizer UI
memfork ui
```

## Merge proposals

If there are open proposals, summarise them:
- Who proposed (address)
- Source → target branch
- Resolver type (jury / LLM)
- Current attestation count vs. threshold

## When to use this skill

- User asks "what's the status of my memory?"
- User asks "are there any pending merges?"
- User asks "show me the memory log"
- User wants to open the DAG visualizer
