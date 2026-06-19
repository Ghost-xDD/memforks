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

`memwal_remember` alone does only step 1. It saves to `namespace=default`
with no branch scoping and no on-chain anchor. Use it only for transient,
throwaway notes that don't warrant a permanent record.

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

### 3. Confirm to the user

After the commit succeeds, print a confirmation in this form:

```
[memforks] Committed to <branch> — "<message>"
```

Do not print the full CLI output. One line is enough.

## Rules

- Never use `memwal_remember` for facts the user explicitly asks to save.
- Never commit task state, in-progress work, or temporary findings.
- If `memfork commit` fails (e.g. no tree initialised), tell the user to
  run `memfork init` first and offer to retry.
- One commit per logical decision — don't batch unrelated facts together.
