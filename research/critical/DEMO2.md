 # MemForks — DEMO2.md

## 3-Minute Shooting Script

### Sui Overflow 2026 · Walrus Track

**Format:** Pre-recorded video
**Total runtime:** 3:00
**Core line:** Git for AI agent memory.
**Story:** A teammate teaches the memory. Another agent inherits it. Then the agent branches into two futures, merges the winner, and still remembers the loser.

---

# Runtime Map

| Time      |                    Beat | Purpose                        |
| --------- | ----------------------: | ------------------------------ |
| 0:00–0:05 |            Framing card | Set the scene in one sentence  |
| 0:05–0:30 |            Magic moment | Codex memory appears in Cursor |
| 0:30–0:45 |       Reveal MemoryTree | Explain the infrastructure     |
| 0:45–1:10 | Branch into two futures | Show the core primitive        |
| 1:10–1:35 |        Evidence commits | Show durable reasoning state   |
| 1:35–2:05 |  Jury merge + Sui proof | Show verifiable settlement     |
| 2:05–2:35 |    Rejected path recall | Show the differentiator        |
| 2:35–2:55 |      GitHub PR artifact | Show real workflow integration |
| 2:55–3:00 |                End card | Make the tagline stick         |

**Voiceover rule:** Never speak a commit ID, branch path, or tool flag aloud. They live on screen only. The voiceover says "the merge commit," "the losing branch," "the old commit" — never "c45."

**Driver rule:** Who is at the keyboard is part of the story (see DEMO_RUNBOOK.md → "Who drives each beat" for the operational detail).

- **Agent-driven** — magic moment, branching, evidence commits: the only thing a human types is a natural-language prompt. The agents call MemForks themselves via plugin hooks and the memory-fork skill. This is the "agents track state over time" proof.
- **Human-driven** — merge proposal, both recall queries, PR comment: governance and audit are deliberately human acts, typed on camera as `memfork` commands.

Never type a `memfork` command on camera during an agent-driven beat — it undercuts the autonomy story.

---

# Screen Layouts

## Layout A — Magic Moment

```text
┌──────────────────────────┬──────────────────────────────────────┐
│ Cursor IDE               │ MemForks DAG visualizer              │
│ Dev B · billing module   │ memforks.dev/<tree-id>               │
│                          │                                      │
│ > "How should I handle   │ main ── ... ── c38                  │
│   errors in billing?"    │        [AppError commit glows]       │
│                          │                                      │
│ Agent: use AppError...   │ "error handling: AppError"           │
│                          │ Dev A · Codex · earlier session      │
└──────────────────────────┴──────────────────────────────────────┘
```

## Layout B — Branch and Merge

```text
┌──────────────────────────┬──────────────────────────────────────┐
│ Codex terminal           │ MemForks DAG visualizer              │
│                          │                                      │
│ $ codex "Redis caching   │ main ── c41                         │
│   or bcrypt first?       │          ├── dev/redis-first         │
│   Explore both."         │          └── dev/bcrypt-first        │
│                          │                                      │
│ [memforks] Forking...    │ [branches fill, then converge]       │
└──────────────────────────┴──────────────────────────────────────┘
```

## Layout C — Close

```text
┌───────────────────────────────┬──────────────────────────────────┐
│ GitHub PR comment             │ DAG — merge commit c45           │
│ MemForks decision attached    │ rejected branch still visible    │
└───────────────────────────────┴──────────────────────────────────┘
```

---

# Full Shooting Script

---

## [0:00–0:05] Framing Card

Black background. One sentence, centered:

```text
Two developers. Two different AI tools. One shared memory.
```

Hold for 3 seconds. No voiceover. No music yet.

This is the only setup the viewer gets — it tells them exactly what to look for in the next 25 seconds. Without it, the magic moment is four context switches with no anchor.

---

## [0:05–0:30] The Magic Moment

**Visual:** Codex terminal fills the frame.
Tab title: `feat/auth`.

Dev A types a plain sentence — no command, just teaching the agent:

```text
We're standardizing error handling — always wrap in AppError,
never throw raw. Remember that.
```

The Codex plugin commits it live. On screen:

```text
[memforks] Committing to feat/auth…
[memforks] ✓ Committed  "error handling: always use AppError wrapper, never throw raw"
```

Caption:

```text
earlier session · Dev A · Codex
```

The viewer *watches the convention get taught* — not a fact that is already
sitting there.

**Cut to:** Layout A. Cursor on the left, DAG on the right.
Cursor tab title: `feat/billing`.

Caption:

```text
current session · Dev B · Cursor
```

Dev B types:

```text
How should I handle errors in this billing module?
```

Cursor agent replies:

```text
Use the project’s AppError wrapper.

Do not throw raw errors from billing handlers.
This matches the convention learned in feat/auth.
```

**Visual:** DAG panel highlights commit `c38`.

On DAG inspector:

```text
c38 · feat/auth
"error handling: always use AppError wrapper, never throw raw"
Author: Dev A · Codex
Time: earlier session
```

(The inspector renders the real authored timestamp — see the runbook's
honesty rule on timestamps. Never hand-edit it.)

**Pause. No music swell yet. Let the viewer process it.**

Voiceover:

> “Dev B never saw Dev A’s session.
> Cursor never read that Codex chat.
> But the project memory did.”

Short pause.

> “That is the moment MemForks is built for.”

---

## [0:30–0:45] Reveal the MemoryTree

**Visual:** Camera pulls back from the glowing AppError commit to show the full DAG.

Show:

```text
main
 ├── feat/auth
 ├── feat/billing
 ├── dev/cache-experiment
 ├── dev/bcrypt-first
 └── prior merge commits
```

Do not linger on every node. Just make the graph feel alive and historical.

Overlay:

```text
MemoryTree
A versioned graph of agent memory
```

Voiceover:

> “Behind the scenes, this project does not have a memory log.
> It has a memory tree.”

> “Every useful thing an agent learns becomes part of a graph: who learned it, when they learned it, what branch it belonged to, and what decision it later influenced.”

**Time-travel moment (~3 seconds):** While on the History or Memory view, drag the time-travel scrubber leftward — commit rows and facts disappear back in time. Slide it to live.

No voiceover needed. The scrubber moving is the statement.

Caption:

```text
The whole history is scrubable.
```

Overlay appears beneath the DAG:

```text
Walrus stores the memory.
Sui settles the decisions.
```

Voiceover:

> “Walrus keeps the reasoning trail.
> Sui records the moments the team agrees on.”

Short pause.

> “We picked a coding team for this demo — but the tree underneath is domain-agnostic.
> Any agents that need to share, branch, and settle memory plug into the same primitive.”

---

## [0:45–1:10] The Agent Branches Into Two Futures

**Cut to:** Layout B. Codex terminal on the left, DAG on the right.

Developer types:

```text
codex "Should we add Redis caching, or fix bcrypt cost first?
Explore both paths."
```

Terminal output:

```text
[memforks] Multi-hypothesis detected.
[memforks] Forking agent memory from main@c41

           ├── dev/redis-first
           └── dev/bcrypt-first
```

**Visual:** DAG animation. Two branches shoot out from `c41`.

Voiceover:

> “Now the agent hits a real engineering fork.”

> “One path says: add Redis caching.
> The other says: fix the bcrypt cost.”

> “In a normal memory system, those ideas collapse into one messy stream.”

Short pause.

> “In MemForks, the agent branches.”

Caption:

```text
Two futures.
Same starting point.
No contamination.
```

Voiceover:

> “Two futures. Same starting point. No contamination.”

---

## [1:10–1:35] Both Branches Gather Evidence

**Visual:** Commit dots appear quickly on both branches.

Terminal output:

```text
dev/redis-first
  c42  hypothesis: cache auth sessions
  c43  fact: bcrypt cost=12, avg auth=340ms
  c44  result: Redis hit rate 87%, projected auth=48ms

dev/bcrypt-first
  c42  hypothesis: reduce bcrypt cost
  c43  fact: no external dependency required
  c44  result: cost=10 gives auth=190ms
```

**Visual:** Click `c44` on `dev/redis-first`. Commit inspector opens.

Inspector:

```text
Commit: c44
Branch: dev/redis-first
Parent: c43
Type: memory_delta

Facts:
- bcrypt cost=12
- avg auth latency=340ms
- Redis projected auth latency=48ms

Blob:
walrus://bafk...8f2b

Author:
Codex delegate
```

Voiceover:

> “The Redis branch gathers performance evidence.
> The bcrypt branch gathers simplicity evidence.”

> “Each branch is allowed to believe its own hypothesis long enough to test it.”

Short pause.

> “That is the key difference: MemForks does not just remember conclusions.
> It preserves the path that produced them.”

Voiceover, while inspector shows the Walrus blob:

> “Each commit is structured memory stored on Walrus, with parent links that make the reasoning trail reconstructible later.”

**Important:** Do not download files. Do not open another inspector. Move on.

---

## [1:35–2:05] Merge With Jury Attestation

**Visual:** Terminal. Merge proposal starts.

Terminal:

```text
[memforks] Opening merge proposal:
           dev/redis-first → main
```

On-screen caption (large, plain language — do NOT show resolver syntax):

```text
3 independent AI judges.
2 must agree.
Enforced on Sui.
```

**Visual:** DAG shows three attestor badges under the merge proposal.

Terminal:

```text
[memforks] Dispatching to jury agents:

           judge-1  evaluating both branches
           judge-2  evaluating both branches
           judge-3  evaluating both branches
```

Voiceover:

> “Now the branches have to come back together.”

> “But the merge is not a vibe check from one model.”

**Visual:** Votes appear one by one. Badges pulse, then turn green.

Terminal:

```text
✓ judge-1 voted: Redis       tx 0x2a1f...
✓ judge-2 voted: bcrypt      tx 0x7b3c...
✓ judge-3 voted: Redis       tx 0x9e4d...
```

Voiceover:

> “Three independent attestors review the two paths.
> They sign their votes.
> The threshold is enforced on Sui.”

**Visual:** Click only `judge-1` tx. Sui Explorer opens briefly.

On screen, show:

```text
Transaction: 0x2a1f...
Function: submit_attestation
Vote: dev/redis-first
Signer: judge-1
```

Voiceover:

> “Click the vote. There is the transaction.”

Short pause.

> “This is not a screenshot of consensus.
> It is a verifiable attestation.”

**Cut back quickly to the DAG. Keep this terminal block on screen ≤4 seconds — the DAG convergence animation is the star, not the text.**

Terminal:

```text
[memforks] Threshold reached: 2 of 3
[memforks] Jury result: dev/redis-first wins
[memforks] Merge finalized: c45

Walrus:  bafk...8f2b
Sui:     0x3c2d...1a
```

**Visual:** DAG animation. `dev/redis-first` and `dev/bcrypt-first` converge into `c45` on `main`.

Voiceover:

> “Two of three choose Redis.
> The merge is written. Main moves forward.”

Short pause.

> “The winning memory becomes the team’s new context.”

---

## [2:05–2:35] The Rejected Path Remains Queryable

**Visual:** Terminal. Slow down. This is the emotional differentiator.

**The two queries in this beat MUST look visually distinct, or judges will see "terminal text… more terminal text" and miss the point. Do not rely on the `--branch` flag to carry the distinction.**

For this first query: the entire DAG dims EXCEPT `dev/bcrypt-first`. Large on-screen label:

```text
Asking the branch that LOST.
```

Terminal:

```text
memfork recall "why didn't we reduce bcrypt cost?" \
  --branch dev/bcrypt-first
```

Output:

```text
dev/bcrypt-first@c44

"Cost=10 improves auth to 190ms, but loses to Redis at 48ms.
Lower risk, lower upside.

Rejected because the team prioritized maximum latency reduction
and the jury voted 2-of-3 for Redis."
```

**Visual:** The greyed-out `dev/bcrypt-first` branch glows in the dimmed DAG.

Voiceover:

> “But this is the part normal memory systems lose.”

Pause.

> “The bcrypt path lost.
> It did not disappear.”

**Immediately run the main query. The DAG un-dims and `main` highlights instead. Swap the label:**

```text
Asking the settled memory.
```

Terminal:

```text
memfork recall "what did we decide for auth performance?" \
  --branch main
```

Output:

```text
main@c45

"Use Redis caching for auth performance.
Jury voted 2-of-3.

Rejected bcrypt-only path remains available for audit:
dev/bcrypt-first@c44"
```

Voiceover:

> “Main does not become a transcript of every experiment.
> It becomes the settled memory.”

Short pause.

> “The experiments stay addressable.”

**Visual:** Main branch `c45` glows. Then rejected branch `dev/bcrypt-first` glows separately.

Voiceover:

> “Main carries the decision.
> The rejected branch keeps the evidence.”

Pause.

> “So the next agent does not inherit a mess — but it can still inspect the road not taken.”

Final line of the beat:

> “A log remembers what you chose.
> MemForks remembers what you rejected, and why.”

---

## [2:35–2:55] The Decision Becomes a Team Artifact

**Cut to:** Layout C. GitHub PR on the left, DAG on the right.

A bot comment appears on the PR:

```text
🔗 MemForks decision attached

Decision:
Prefer Redis caching for auth performance.

How it was decided:
Jury vote, 2 of 3 — enforced on Sui

Merge:
c45

Sui:
0x3c2d...1a

Walrus:
bafk...8f2b

Rejected path:
dev/bcrypt-first@c44 remains queryable

Full audit trail:
memforks.dev/0x3f2a...cd#c45
```

**Visual:** DAG beside the PR shows `c45` glowing. The rejected branch is still visible, greyed out but clickable.

Voiceover:

> “And the decision does not stay inside the agent.”

> “It lands where the team already works: in the pull request, linked to the merge, the attestations, the memory blobs, and the rejected alternative.”

Short pause.

> “A future teammate can audit the decision without replaying the whole conversation.”

---

## [2:55–3:00] End Card

Black background.

Text:

```text
MemForks
Git for AI agent memory
```

Then tagline appears line by line:

```text
Fork memory.
Merge reasoning.
Remember what lost.
```

Footer:

```text
Built on Sui · Walrus · MemWal
```

Voiceover:

> “MemForks is git for AI agent memory.”

Cut to silence.

---

# Must-Hit Moments

The demo only works if these moments land clearly:

1. **The memory did that.**
   Dev B gets Dev A’s AppError convention in Cursor.

2. **Two futures. Same starting point.**
   The DAG visibly branches.

3. **Not one model deciding.**
   Jury votes are shown and one Sui transaction is opened.

4. **Main carries the decision; the rejected branch keeps the evidence.**
   This is the cleanest explanation of branch isolation.

5. **A log remembers what you chose. MemForks remembers what you rejected, and why.**
   This is the most important line in the video.

---

# Minimal Pre-Recording Checklist

> **Superseded by DEMO_RUNBOOK.md.** Nothing is "pre-seeded" by hand — every
> precondition below is produced by running real commands in the runbook's
> Phase 0 (environment) and Phase 1 (seed session), which a judge can
> replicate. The list below remains as the what-must-be-true summary.

Required:

* AppError commit committed on `feat/auth` and merged to `main` (runbook Phase 1 — a real session, not an injected row).
* Cursor can retrieve the AppError convention from the shared tree.
* Codex can create `dev/redis-first` and `dev/bcrypt-first`.
* DAG visualizer shows branch split and merge.
* At least one real Sui attestation transaction opens cleanly.
* Merge commit shows both a Walrus blob ID and a Sui tx.
* Rejected branch recall works.
* Main branch recall shows the settled decision.
* DAG can dim everything except one branch (the "Asking the branch that LOST" beat depends on it).
* On-screen labels rendered: framing card, jury caption, both recall labels.
* GitHub PR comment appears or is pre-recorded cleanly.

Optional only if flawless:

* Real three-provider LLM jury.
* Downloadable benchmark artifact.
* Phone QR view.
* ~~Time-travel checkout.~~ Scripted in Beat 2 — scrubber gesture, ~3 seconds.
* Full six-week DAG browsing.

Do not include optional items in the 3-minute cut unless they are visually perfect.

One thing I’d keep sacred: **do not let the merge beat eat the rejected-path beat.** The jury is technically impressive, but the rejected branch is the thing people will remember.
