---
name: memory-fork
description: >-
  Fork agent memory into parallel branches to explore competing hypotheses.
  Use whenever a task has two or more genuinely competing approaches worth
  testing in isolation — whether the user names them explicitly ("explore
  both", "compare A vs B") OR asks an open decision question (e.g. "what's the
  fastest way to X?") where you can identify two credible, mutually-exclusive
  solutions.
---

# Memory Fork

Fork the MemForks memory tree whenever a task has two or more genuinely
competing approaches that deserve to be tested in isolation. Never collapse
competing ideas into a single stream. The decision to fork is **yours** — you
do not need the user to ask for branching; you need only to recognise that two
real alternatives exist.

## When to trigger

Trigger this skill in either case:

**Explicit multi-hypothesis prompts** — the user names the alternatives:
- "explore both paths" / "try both" / "compare X and Y"
- "what if we did X instead of Y" (two real alternatives)
- "should we do A or B?" (genuine decision fork, not a rhetorical question)

**Implicit decision questions** — the user asks an open question and *you*
identify two credible competing approaches:
- "What's the fastest way to cut our auth latency?" → e.g. Redis caching vs.
  bcrypt cost tuning
- "How should we make this query cheaper?" → e.g. add an index vs. denormalise
- Any open "how do we improve / fix / speed up X?" where two distinct,
  mutually-exclusive strategies are worth measuring before committing

**Do NOT fork** when there is only one sensible approach, when the question is
rhetorical or informational, or when the alternatives are trivial variations of
each other. Forking is for real, competing, separately-testable hypotheses —
not for every question.

When you fork off an implicit question, name the two approaches you inferred so
the user can see your reasoning (see the announce format below).

## Procedure

### 1. Announce the fork

Name the two approaches you identified, then announce the fork. Print exactly
this shape (substitute the real approaches and current branch):

```
[memforks] Two viable approaches detected — <approach A> vs. <approach B>.
[memforks] Branching memory so each can be tested without contamination.
[memforks] Forking from <current-branch>@HEAD
```

Then list the branches you will create, one per hypothesis:

```
           ├── dev/<short-hypothesis-a>
           └── dev/<short-hypothesis-b>
```

Use kebab-case branch names derived from the hypothesis (e.g. `dev/redis-first`,
`dev/bcrypt-first`, `dev/approach-a`).

> Naming the two approaches in the first line is what makes the fork read as
> *your* decision rather than a command you were handed — especially when the
> user asked an open question and never named the alternatives.

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
