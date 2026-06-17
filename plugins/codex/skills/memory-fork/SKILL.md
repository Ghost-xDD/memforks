---
name: memory-fork
description: >-
  Fork agent memory into parallel branches to explore competing hypotheses.
  Use when the user asks to explore multiple approaches, compare options, or
  says phrases like "explore both", "try two paths", "compare A vs B".
---

# Memory Fork

When you detect a multi-hypothesis prompt — the user wants to explore two or
more competing approaches — fork the MemForks memory tree so each path stays
isolated.  Never collapse competing ideas into a single stream.

## When to trigger

Trigger this skill when the user prompt contains signals like:
- "explore both paths" / "try both" / "compare X and Y"
- "what if we did X instead of Y" (two real alternatives)
- "should we do A or B?" (genuine decision fork, not a rhetorical question)
- Any request to investigate multiple competing solutions side-by-side

## Procedure

### 1. Announce the fork

Print exactly:

```
[memforks] Multi-hypothesis detected.
[memforks] Forking agent memory from <current-branch>@HEAD
```

Then list the branches you will create, one per hypothesis:

```
           ├── dev/<short-hypothesis-a>
           └── dev/<short-hypothesis-b>
```

Use kebab-case branch names derived from the hypothesis (e.g. `dev/redis-first`,
`dev/bcrypt-cost`, `dev/approach-a`).

### 2. Create the branches

For each hypothesis, run:

```bash
memfork branch dev/<hypothesis> --from <current-branch>
```

### 3. Investigate hypothesis A

Switch to the first branch and investigate:

```bash
memfork checkout dev/<hypothesis-a>
```

Work through the hypothesis.  As you discover facts, commit them:

```bash
memfork commit \
  --branch dev/<hypothesis-a> \
  --message "<what you found>" \
  --facts "<concrete measurable fact>" "<another fact>"
```

Commit at each meaningful step — hypothesis statement, baseline measurement,
result.  Three commits is normal; more is fine.

### 4. Investigate hypothesis B

```bash
memfork checkout dev/<hypothesis-b>
```

Repeat the same commit cadence.

### 5. Summarise

After both branches have evidence, summarise findings side by side and tell
the user which branch has stronger evidence.  Do NOT merge — merging is a
human governance act (`memfork merge`).

## Output format for each commit

Use this fact structure for clarity and later recall:

```
hypothesis: <one-sentence statement of what this branch is testing>
fact:        <measured or researched datum — numbers are better than adjectives>
result:      <conclusion or outcome of the investigation>
```

## Rules

- Never commit to `main` or the parent branch during a fork investigation.
- Never type `memfork merge` — that is the operator's call.
- If the user asks "which won?", answer from memory; do not merge.
- Keep branch names short and descriptive (`dev/redis-first` not `dev/add-redis-caching-to-auth-flow`).
- If `memfork branch` fails because the branch already exists, use `memfork checkout` and continue.
