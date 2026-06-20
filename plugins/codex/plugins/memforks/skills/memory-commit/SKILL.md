---
name: memory-commit
description: >-
  Commit facts to the MemForks memory DAG using memfork commit --facts.
  Use whenever the user says "remember that", "commit this", "save that",
  "note that", "don't forget", or any phrasing that asks you to persist
  a decision, convention, or finding for future sessions.
---

# Memory Commit

When the user asks you to remember something — a decision, a convention, a
finding — **always use `memfork commit --facts`**, not `memwal_remember`.

`memfork commit --facts` does two things in one command:

1. Indexes the facts in MemWal for semantic recall (same as `memwal_remember`)
2. Anchors them on-chain on Sui, tagged to the current Git branch

The raw MemWal write tools (`memwal_remember`, `memwal_remember_bulk`,
`memwal_analyze`) are **disabled** under MemForks — they save to
`namespace=default` with no branch scoping and no on-chain anchor, which
defeats the purpose of a version-controlled memory DAG. `memfork commit` is
the only write path, so every saved memory is provably anchored on Sui.

## Procedure

### 1. Identify the facts

Extract 1–3 concrete, standalone facts from what the user said. Facts should
be self-contained sentences — readable out of context in a future session.

Good:
```
"error handling convention: always wrap in AppError, never throw raw"
"auth latency target: p99 < 200ms on bcrypt verify"
```

Bad (too vague, depends on context):
```
"we agreed on this"
"the thing we discussed"
```

### 2. Run the commit

```bash
memfork commit \
  --message "<one-line summary of the decision>" \
  --facts "<fact 1>" "<fact 2>"
```

The CLI auto-detects the current Git branch — do **not** pass `--branch`
unless explicitly targeting a different branch.

**This command performs a network write to Walrus and an on-chain transaction
on Sui. It takes 20–60 seconds to complete — this is normal.** Run it in the
foreground and wait for the `✓ Committed to <branch>` line before concluding
it succeeded or failed. Do not retry if output is slow; only retry if the
process exits with a non-zero code or prints an error.

### 3. Confirm to the user

After the commit succeeds, print a confirmation in this form:

```
[memforks] Committed to <branch> — "<message>"
```

Do not print the full CLI output. One line is enough.

## Rules

- The raw `memwal_remember*` / `memwal_analyze` tools are disabled — `memfork
  commit` is the only way to persist memory. Never look for a workaround.
- Never commit task state, in-progress work, or temporary findings.
- If `memfork commit` fails (e.g. no tree initialised), tell the user to
  run `memfork init` first and offer to retry.
- One commit per logical decision — don't batch unrelated facts together.
