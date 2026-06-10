# `@memfork/langgraph` — LangGraph Checkpointer Adapter

Drop-in LangGraph checkpointer that stores every graph state snapshot on Sui (via MemWal).  
Each LangGraph thread maps to a MemForks branch — enabling cross-agent memory merges.

## Install

```bash
npm install @memfork/langgraph @memfork/core

# First-run (one time per machine) — zero copy-paste on testnet:
memfork init --quick

# Or manual mode if you already have a Sui key + MemWal account:
memfork init
```

## Usage

```typescript
import { createMemForksCheckpointer } from "@memfork/langgraph";
import { resolveConfig, toClientConfig } from "@memfork/cli/config"; // reads ~/.memfork/credentials.json
import { StateGraph, MessagesAnnotation } from "@langchain/langgraph";

// Option A: use the CLI config layer (recommended — no secrets in source)
const { treeId, privateKey: signer, memwalAccountId, memwalKey } = resolveConfig();
const checkpointer = await createMemForksCheckpointer({
  treeId, signer,
  memwal: { accountId: memwalAccountId, delegateKey: memwalKey },
});

// Option B: explicit (CI / containerised environments)
const checkpointer = await createMemForksCheckpointer({
  treeId: process.env.MEMFORK_TREE_ID!,
  signer: process.env.MEMFORK_PRIVATE_KEY!,
  memwal: {
    accountId:   process.env.MEMFORK_MEMWAL_ACCOUNT!,
    delegateKey: process.env.MEMFORK_MEMWAL_KEY!,
  },
  // Optional: override the default branch name
  branch: "main",
  // Optional: customise how thread IDs map to branch names
  // threadToBranch: (id) => `session/${id}`,
});

const app = new StateGraph(MessagesAnnotation)
  .addNode("agent", myAgentNode)
  .addEdge("__start__", "agent")
  .compile({ checkpointer });

// Invoke with a thread ID — maps to branch "thread/abc123"
const result = await app.invoke(
  { messages: [{ role: "user", content: "Hello" }] },
  { configurable: { thread_id: "abc123" } },
);
```

## How it works

| LangGraph event | MemForks action |
|-----------------|-----------------|
| `put()` checkpoint | `mem.commit(branch, { facts: [serialised state] })` → on-chain tx |
| `getTuple()` | `mem.recall("checkpoint thread_id=…")` → MemWal semantic lookup |
| `putWrites()` | `mem.commit(branch, { facts: pending writes })` |
| `proposeMerge()` | `mem.proposeMerge(from, into, resolver)` → on-chain proposal |

## Cross-agent merges

When two agents working in parallel need to reconcile their state:

```typescript
const digest = await checkpointer.proposeMerge({
  fromThread: "agent-a-thread",
  intoThread: "main-thread",
  resolverId: process.env.MEMFORK_RESOLVER_ID!,
});
// The on-chain resolver handles jury voting / LLM reconciliation.
// Poll with: checkpointer.memforks.waitForFinalization(proposalId)
```

## Thread → Branch mapping

By default: `thread/<thread_id>`. Override with `threadToBranch`:

```typescript
createMemForksCheckpointer({
  ...
  threadToBranch: (id) => `agent/${id}`,
})
```
