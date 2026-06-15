# Developer Bounties

These bounty ideas are designed for junior developers building on MemForks with either `@memfork/vercel-ai` or `@memfork/langgraph`.

The goal is not to rebuild MemWal's flat `remember` and `recall`. A valid MemForks project must show branch lineage.

## Acceptance Gate

Every submission should show:

1. A branch created from a parent.
2. The branch answering the same question differently from its parent.
3. A merge, promotion, diff, or rewind that visibly changes what a branch knows.

If a submission cannot demonstrate fork, divergence, and merge or rewind, it is a MemWal app rather than a MemForks app.

## Adapter Requirement

Use at least one framework adapter:

- `@memfork/vercel-ai` for chat, generation, streaming, or structured output.
- `@memfork/langgraph` for graph checkpoints, workflows, agents, or multi-step state.

Use `@memfork/core` for helper operations such as `branch`, `commit`, `recall`, diff, and merge.

## Beginner-Friendly Project Ideas

### Decision Sandbox

Build a Next.js app where `main` holds real user context and a fork holds a hypothetical plan. The fork can learn "I quit my job in September" without teaching that to `main` until promotion.

Use: Vercel AI SDK.

### DraftRoom

Build a writing studio where a base brief lives on `main`, while `draft/friendly` and `draft/technical` explore different tones. Merge the winning draft back.

Use: Vercel AI SDK.

### Memory Diff

Build a GitHub-style side-by-side diff for branch memory. Show shared facts, unique source facts, and unique target facts.

Use: Vercel AI SDK or LangGraph.

### QuestFork

Build a choose-your-own-adventure game where each choice creates a branch. A castle path should not know what happened in a forest path.

Use: LangGraph recommended.

### SafeTeach

Build a sandbox teaching chat. The sandbox branch can learn experimental facts and then be discarded or promoted.

Use: Vercel AI SDK.

### SyncDesk

Build two workspace branches, `workspace/work` and `workspace/home`, then sync both into `main`.

Use: Vercel AI SDK or LangGraph.

### Research Forks

Build a topic notebook where each research topic gets a branch. Promote approved findings into `main`.

Use: LangGraph recommended.

### Persona Split Test

Build an A/B lab where `persona/formal` and `persona/casual` inherit the same base context but diverge by style facts.

Use: Vercel AI SDK.

### Twin Chats

Build two side-by-side chat panes backed by two branches. One shared input sends to both, and branch-specific notes make them diverge.

Use: Vercel AI SDK.

### Memory Time Machine

Build a save-point UI where users fork from an earlier checkpoint and continue with only the memory that existed then.

Use: LangGraph recommended.

## Deliverable

Each submission should include:

- public repository
- short demo video
- setup instructions
- `.env.example`
- a clear branch/diverge/merge demo script
