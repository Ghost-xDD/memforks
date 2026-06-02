---
name: memforks-status
description: >-
  Show MemForks on-chain status: branch DAG, open merge proposals, recent commits.
  Use when the user asks about memory status, proposals, or the commit log.
  Also use when committing decisions or proposing a merge.
---

# MemForks On-Chain Operations

MemForks is the version-control layer on top of MemWal. Use the `memfork` CLI for
DAG operations — not for routine recall/remember (that's the MCP server's job).

## Check status

```bash
memfork status                    # current tree, branch, signer, head commit
memfork log --branch <branch>     # recent on-chain commits
memfork proposals                 # open merge proposals
memfork ui                        # open the DAG visualizer
```

## Commit a decision on-chain

Use this after significant architectural decisions — not for routine facts.
(Routine facts go through `memwal_remember` via MCP.)

```bash
memfork commit \
  --branch $(git rev-parse --abbrev-ref HEAD) \
  --message "decided: <one-line summary>" \
  --facts "<fact 1>" "<fact 2>"
```

## Propose a merge

When two branches need to reconcile their memory:

```bash
memfork merge <from-branch> <into-branch> --resolver <resolver-id>
```

The on-chain resolver handles attestation and reconciliation automatically.
The user does not need to do anything after proposing — the resolver runs in the background.

## When to use this skill

- User asks "what's the status of my memory?"
- User asks "are there any pending merges?"
- User says "commit what we decided today"
- User wants to merge memory from one branch into another
- User wants to open the DAG visualizer
