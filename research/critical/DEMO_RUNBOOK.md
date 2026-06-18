# MemForks — DEMO_RUNBOOK.md

**Companion to DEMO2.md.** DEMO2 is the *shooting script* (what the viewer sees).
This is the *operator's manual* (what you type, in order, and what must be true
before you hit record).

**Core principle: staged ≠ faked.**
Nothing is pre-injected into a database. Everything that exists before the
recording was created by running the same commands documented here. A judge
can clone the repo, follow this file, and reproduce every beat — with the
auth/billing scenario or with their own.

The runbook is itself a submission artifact. Link it in the README.

---

## Cast

| Persona | Tool             | Reality                                                        |
| ------- | ---------------- | -------------------------------------------------------------- |
| Dev A   | Codex CLI        | You, in a terminal with the Codex plugin installed             |
| Dev B   | Cursor           | You, in a Cursor window with the MemForks rule + MemWal MCP    |
| Jury    | 3 judge wallets  | Resolver service, 3 `JuryWorker`s with different LLM providers |
| Viewer  | —                | Sees only what DEMO2.md specifies                              |

**Honesty rule on timestamps:** the captions use "Dev A · Codex · earlier
session" precisely because we do not fake timestamps. If you seed the AppError
commit the same day you record, the UI will show "2h ago" — so the caption
stays:

```text
Dev A · Codex · earlier session
```

(If you genuinely seed Phase 1 a few days before recording, the original
caption is true. Either way: the screen never lies.)

---

# Phase 0 — Environment (off-camera, one-time, ~45 min)

Everything here is replicable by a judge. No step touches a database directly.

## 0.1 Install + provision

```bash
npm install -g @memfork/cli        # or: npm link from packages/cli
memfork init --quick               # keygen → faucet → MemWal account → tree
memfork doctor                     # must be all green before continuing
```

Record the output of `memfork init --quick` — note the **tree ID** and
**package ID**. Everything downstream uses them.

## 0.2 Resolver service (the jury)

```bash
cd services/resolver
cp .env.example .env.local
```

Fill in:

- `MEMFORKS_PACKAGE_ID`, `MEMFORKS_TREE_ID` — from 0.1
- `FINALIZER_PRIVATE_KEY` — fund via faucet; needs MERGE permission
- `JUDGE_0..2_KEY` — three fresh funded keypairs
- Judge LLMs — **use three different providers/models** (e.g. gpt-4o,
  claude, gpt-4o-mini). This makes the "not one model deciding" beat real,
  and the model names render in the visualizer ceremony card.
- `MEMFORKS_MEMWAL_KEY`, `MEMWAL_ACCOUNT_ID` — from 0.1

```bash
npm start    # leave running for the entire recording session
```

Verify the startup log lists all three judge addresses.

## 0.3 Jury resolver object

```bash
memfork resolver create --jury <judge0>,<judge1>,<judge2> -k 2
# → ResolverRef: 0xRESOLVER...     (save this — used in every merge)
```

Set it in your shell for convenience:

```bash
export MEMFORK_RESOLVER_ID=0xRESOLVER...
```

## 0.4 Plugins

```bash
memfork install codex     # Dev A's terminal
memfork install cursor    # Dev B's Cursor project (installs rule + MemWal MCP)
```

Smoke-test each: ask Cursor a question, confirm it calls `memwal_recall`.

## 0.5 Visualizer

```bash
memfork ui                # serves on :4242, live mode against your tree
```

Confirm the TopBar shows your real branch list (not demo data) and the
History view shows live events. **Do not use `?demo=1` anywhere in the
recording.**

## 0.6 Pre-flight checklist

- [ ] `memfork doctor` green
- [ ] Resolver running, 3 judges logged
- [ ] ResolverRef created, ID saved in `MEMFORK_RESOLVER_ID`
- [ ] Cursor plugin recalls successfully
- [ ] Codex plugin commits successfully
- [ ] `memfork ui` live mode shows the tree
- [ ] Wallets funded: owner, finalizer, 3 judges (testnet faucet)
- [ ] Screen recorder configured (see Recording Mechanics at the bottom)

---

# Phase 1 — Seed session ("Dev A, earlier")

This *is* the pre-seed from DEMO2 — and you record the teaching half of it as
**Beat 1a**, the [0:05–0:15] cold open. The agent-driven plugin path below is
the one to capture; the CLI path is the fallback.

## 1.1 The AppError convention

In Dev A's terminal (Codex persona), on branch `feat/auth`:

```bash
memfork branch feat/auth -f main
memfork checkout feat/auth
memfork commit \
  -m "error handling convention" \
  -b feat/auth \
  -f "error handling: always use AppError wrapper, never throw raw errors from handlers"
```

Expected output (this exact frame appears at [0:05] in the video):

```text
✓ Committed to feat/auth
  blob: <blobId>
```

For Beat 1a, drive this through the Codex plugin in a real session (type the
teaching sentence from Beat 1a, let the plugin commit) so the terminal frame
is authentic. The CLI commands above are the fallback and produce the same
on-chain result.

## 1.2 Land the convention on main

Merge `feat/auth → main` now. This builds real DAG history that the reveal
beat wants, and it's a live rehearsal of the jury pipeline before the
on-camera merge in Beat 5. Recall walks to the fork parent and then `main`
automatically, so Dev B on `feat/billing` will inherit the AppError fact even
before this merge — but running it here gives the History view the prior
merge anchor row that makes Beat 2 look alive.

```bash
# Jury path (recommended — exercises the full pipeline before recording):
memfork merge feat/auth main -r 0xRESOLVER

# LWW shortcut (faster; use when re-seeding a throwaway tree):
memfork merge feat/auth main --lww
```

```bash
memfork recall "error handling" -b main     # must return the AppError fact
```

Use LWW for Phase 1 seed merges; use `-r 0xRESOLVER` for the on-camera
merge beats (Beats 5–6) where the jury ceremony is the story.

Do not proceed to Phase 2 until that recall returns the fact.

---

# Phase 2 — Recording, beat by beat

Record **one segment per beat**, not one continuous take. Every segment is
still live — segmenting just means a Walrus upload or LLM judge being slow
costs you one retake, not the whole session.

Screen setup per beat is in DEMO2.md (Layouts A/B/C). The visualizer views
referenced below are: **Memory**, **History**, **Merges**, **Map**.

## Who drives each beat

This split is deliberate — it is the story. The Walrus track's first listed
interest is "long-running workflows where agents track state over time," so
the memory-producing beats must visibly be the *agents'* actions, not yours.
The governance beats stay human because proposing a merge and auditing the
memory are human acts.

| Beat | Driver               | What the viewer sees typed                       |
| ---- | -------------------- | ------------------------------------------------ |
| 1a   | **Agent (Codex)**    | A plain teaching sentence — zero MemForks commands |
| 1b   | **Agent (Cursor)**   | A plain question — zero MemForks commands        |
| 2    | Operator             | Nothing — visualizer scroll only                 |
| 3    | **Agent (Codex)**    | "Explore both paths" — agent forks itself        |
| 4    | **Agent (Codex)**    | Nothing — commits stream in as the agent works   |
| 5    | Operator             | `memfork merge` ×2                               |
| 6    | Operator             | `memfork recall` ×2                              |
| 7    | Operator             | `memfork pr-comment`                             |

Dev A (Codex) is the memory *producer*: teaches the convention (1a) and runs
the branch exploration (3–4). Dev B (Cursor) is the memory *consumer*: a
different tool inheriting Dev A's knowledge (1b). The Operator handles the
governance beats (5–7). The split is the story, "two tools, one memory" needs
A ≠ B; "agents produce, humans govern" needs agent ≠ operator.

The raw CLI commands listed under each beat below are the **replication
floor**: what the agent runs under the hood, what a judge can type to
reproduce a beat without the plugins, and your fallback if a live agent
misbehaves on camera. For beats 1a, 1b, 3, and 4, the agent-driven path is the
one to record.

## Beat 1a — [0:05–0:15] The teaching (cold open)

**Driver: agent (Codex).** You type only a natural teaching sentence, no
MemForks commands. This is the Phase 1.1 session, recorded; "earlier session"
is literally true.

**On screen:** Codex terminal, tab `feat/auth`.

1. In Dev A's Codex terminal, on `feat/auth`, type a plain sentence:

```text
We're standardizing error handling — always wrap in AppError, never throw raw. Remember that.
```

2. The Codex plugin commits it. The frame shows the commit landing:

```text
[memforks] Committing to feat/auth…
[memforks] ✓ Committed  "error handling: always use AppError wrapper, never throw raw"
```

**Caption:** `earlier session · Dev A · Codex`

The viewer *watches the memory get taught* — not a fact that is simply already
there. Off-camera between 1a and 1b, the convention lands on `main` (Phase 1.2
merge), so Dev B's recall resolves it.

**Fallback:** if the plugin's committed fact comes out vaguely worded, retake
with a cleaner sentence, or use the Phase 1.1 CLI commit. Never edit the frame.

## Beat 1b — [0:15–0:30] The inheritance (magic moment)

**Driver: agent (Cursor).** You type only the developer question.

**On screen:** Cursor (left) + visualizer **Memory view** (right).

1. Dev B's Cursor project, on `feat/billing` (`memfork branch feat/billing -f main && memfork checkout feat/billing` beforehand — branch creation can be off-camera, it's not this beat's story).
2. Type into Cursor: `How should I handle errors in this billing module?`
3. Cursor's rule fires `memwal_recall` → the ancestor-fallback walks to `main` and returns the AppError convention Dev A just taught.
4. In the Memory view, click the AppError fact row → drawer opens showing
   branch + commit provenance (authored by Dev A · Codex).

**Caption:** `current session · Dev B · Cursor`

A *different tool* inherited what Codex was taught one beat ago. That is the
whole pitch in fifteen seconds.

**Fallback:** if Cursor paraphrases weirdly, retake with a fresh chat. Never
paste the answer in.

## Beat 2 — [0:30–0:45] Reveal the MemoryTree

**On screen:** visualizer **History view**, slow scroll. It already contains
real history from Phase 1: commit rows, a fork row (⑂ + ◈ on-chain), and a
merge anchor row (◈) from the feat/auth → main merge.

Optionally cut to the **Map view** for 2–3 seconds for the literal
tree-shape shot, then back. The History view is the star.

**Time-travel gesture (~3 seconds):** With the History or Memory view visible,
drag the scrubber at the top of the view slowly leftward — commit rows disappear
as if peeling back time. Slide back to live before moving on. No narration;
caption reads: *The whole history is scrubable.*

This is the only appearance of the scrubber in the 3-minute cut. Do not demo
`memfork checkout --at` on camera unless the segment is visually flawless.

## Beat 3 — [0:45–1:10] Branch into two futures

**Driver: agent (Codex).** You type only the prompt; the agent forks its own
memory.

**On screen:** Codex terminal (left) + **History view** (right).

You type:

```text
codex "Should we add Redis caching, or fix bcrypt cost first? Explore both paths."
```

The `memory-fork` skill detects the multi-hypothesis prompt and responds:

```text
[memforks] Multi-hypothesis detected.
[memforks] Forking agent memory from main@HEAD

           ├── dev/redis-first
           └── dev/bcrypt-first
```

Two fork rows pop into the History view live (the `is-new` pop-in animation
fires on real BranchCreated events — no special demo code).

**Replication floor / fallback:**

```bash
memfork branch dev/redis-first  -f main
memfork branch dev/bcrypt-first -f main
```

## Beat 4 — [1:10–1:35] Evidence commits

**Driver: agent (Codex).** Same session as Beat 3 — the agent investigates
both paths and commits evidence as it goes. You type nothing; commit rows
stream into the History view as the agent works. This is the "agents track
state over time" shot.

**On screen:** Codex terminal (left) + **History view** (right).

Then click one commit row on `dev/redis-first` in the History view → the
**commit drawer** opens (message, branch, keys changed, parent blob, Walrus
link).

**Do not** open the Walrus link on camera. The drawer showing the blob ID is
the proof; the link is for judges replicating.

**Replication floor / fallback** (also your retake path if the agent's
evidence facts come out unusably vague):

```bash
memfork commit -b dev/redis-first -m "hypothesis" \
  -f "hypothesis: cache auth sessions in Redis"
memfork commit -b dev/redis-first -m "baseline measured" \
  -f "fact: bcrypt cost=12, avg auth latency=340ms"
memfork commit -b dev/redis-first -m "redis result" \
  -f "result: Redis hit rate 87%, projected auth latency=48ms"

memfork commit -b dev/bcrypt-first -m "hypothesis" \
  -f "hypothesis: reduce bcrypt cost factor"
memfork commit -b dev/bcrypt-first -m "no new deps" \
  -f "fact: bcrypt tuning requires no external dependency"
memfork commit -b dev/bcrypt-first -m "bcrypt result" \
  -f "result: cost=10 gives auth latency=190ms"
```

## Beat 5 — [1:35–2:05] Jury merge + Sui proof

**Driver: operator.** Proposing a merge is a governance act — you type it.

**On screen:** terminal briefly, then visualizer **Merges view** for the
ceremony. Keep the terminal block ≤4s as DEMO2 says.

```bash
memfork merge dev/redis-first  main -r 0xRESOLVER
memfork merge dev/bcrypt-first main -r 0xRESOLVER
```

The resolver detects both proposals targeting `main` and passes each judge
the competing branch's evidence alongside its own, instructing them to
approve at most one. The expected result: redis wins 2-of-3 and is finalized;
bcrypt is rejected and aborted — both real on-chain events.

While votes land (5s poll interval), the ceremony card fills in live: judge
labels, model names, vote reasoning, threshold bar, then the settled row.
Click **one** judge vote → its Sui tx on Suiscan (`submit_attestation`). Back
to the Merges view for the finalize.

**Fallback:** if an LLM judge times out on camera, the resolver retries on
the next poll — keep rolling, the pause reads as deliberation. If a judge
hard-fails, restart the segment after checking the resolver log.

## Beat 6 — [2:05–2:35] The rejected path remains queryable

**Driver: operator.** You are auditing the memory — that should visibly be a
human act.

**On screen:** terminal (left) + **Merges view, Graveyard section** (right).
The graveyard row for `dev/bcrypt-first` exists because the abort in Beat 5
was real.

After the competitor was finalized, the resolver automatically wrote a
rejection rationale to `dev/bcrypt-first` and a pointer fact to `main`. The
recall queries return live results — no simulation.

```bash
memfork recall "why didn't we reduce bcrypt cost?" --branch dev/bcrypt-first
```

Use the TopBar **branch filter dropdown** to scope every view to
`dev/bcrypt-first`. The on-screen label reads:

```text
Asking the branch that LOST.
```

Then immediately:

```bash
memfork recall "what did we decide for auth performance?" --branch main
```

Switch the branch filter to `main`. Label: `Asking the settled memory.`

The main recall output includes a pointer to the rejected path: `"Rejected
bcrypt-only path remains available for audit: dev/bcrypt-first@latest"`.

## Beat 7 — [2:35–2:55] GitHub PR artifact

**Driver: operator.**

```bash
memfork pr-comment --pr 12
```

This reads the latest merge anchor, proposal, and attestations and posts via
the `gh` CLI: decision, vote count, anchor ID, Sui tx, Walrus blob, the
rejected-branch pointer, and the visualizer URL. Record the real comment
rendering on a real PR in a public repo.

**Fallback:** if `gh` auth is not set up, `memfork pr-comment` prints the
comment body to stdout — paste it manually and keep rolling.

## Beat 8 — [2:55–3:00] End card

Editing only. No commands.

---

# Phase 3 — Judge-facing verification artifacts

Collect after recording, link from the README and the video description:

- **Tree ID + package ID** (testnet) — so judges can query events themselves
- **Suiscan links**: both fork txs, all attestation txs, the finalize tx, the abort tx
- **Walrus blob IDs** for the evidence commits and resolved merge blob
- **`memfork ui --share`** — publish the visualizer as a Walrus Site pointed
  at the real tree; judges browse the exact DAG from the video
- **This runbook** — the replication path
- Optionally a `scripts/demo-replay.sh` that runs Phases 1–2 commands
  end-to-end against a fresh tree (doubles as a regression test)

---

# Recording mechanics

- 1080p minimum; terminal at ≥16pt font, dark theme matching the visualizer
- One segment per beat; slate each segment with the beat number out loud
- Keep the resolver log visible on a second monitor — it's your early warning
  for a stuck proposal (poll interval 5s; a jury round normally settles in
  15–45s with LLM latency)
- Testnet hygiene: fund all wallets with 2× expected gas before recording;
  a faucet outage mid-session is the most likely unrecoverable flake
- Do a full dress rehearsal on a throwaway tree (`memfork init --quick`
  again) the day before — the rehearsal doubles as a full integration test
