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

## Merge branches

When two branches need to reconcile their memory:

```bash
# Zero-config — LastWriteWins, self-finalizes immediately
memfork merge <from-branch> <into-branch>

# Governed — jury / LLM resolver (requires MEMFORK_RESOLVER_ID env var or --resolver flag)
memfork merge <from-branch> <into-branch> --resolver <resolver-id>
```

With no `--resolver` flag and no `MEMFORK_RESOLVER_ID` set, the merge uses
LastWriteWins and finalizes immediately — no resolver service required.

When a resolver is configured, the command waits for the on-chain resolver service
to collect attestations and finalize before returning.

---

## Suggesting a merge — proactive but not autonomous

You may **suggest** a merge when you notice the current branch has accumulated
durable facts not yet on `main`. Phrase it as an offer:

> "This branch has several facts that aren't on main yet — want me to merge them?
> I'll run `memfork merge <branch> main`."

**Never run `memfork merge` without the user explicitly confirming.** Merging
changes shared team memory and creates an on-chain anchor — it is a governance
act, not a routine commit.

Suggest a merge when:
- The user says "we're done with this branch" or "I'm about to open a PR"
- You've committed 3+ significant facts this session and the user hasn't merged
- The user asks "what should I do next?" at the end of a long session

Once the user confirms, run:

```bash
memfork merge <current-branch> main
```

---

## When to use this skill

- User asks "what's the status of my memory?"
- User asks "are there any pending merges?"
- User says "commit what we decided today"
- User confirms they want to merge memory from one branch into another
- User wants to open the DAG visualizer
