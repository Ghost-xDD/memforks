# Core SDK

`@memfork/core` is the low-level TypeScript SDK for branch-aware memory.

Use it when you need direct control over branch operations, commits, recall, merge proposals, delegates, or custom server workflows.

## Install

```bash
npm install @memfork/core
```

Peer stack:

- `@mysten/sui`
- `@mysten-incubation/memwal`

## Connect

Auto-config:

```ts
import { MemForksClient } from "@memfork/core";

const client = await MemForksClient.connect();
```

Explicit config:

```ts
const client = await MemForksClient.connect({
  treeId: process.env.MEMFORK_TREE_ID!,
  signer: process.env.MEMFORK_PRIVATE_KEY!,
  network: "testnet",
  memwal: {
    accountId: process.env.MEMFORK_MEMWAL_ACCOUNT!,
    delegateKey: process.env.MEMFORK_MEMWAL_KEY!,
    serverUrl: process.env.MEMFORK_RELAYER_URL,
  },
});
```

## Commit Facts

```ts
const { blobId, contentHash } = await client.commit("main", {
  message: "record database decision",
  facts: [
    "Database: PostgreSQL",
    "Reason: ACID guarantees and team familiarity",
  ],
});
```

Commits write a MemWal/Walrus blob and update the local branch head tracker.

## Recall Facts

```ts
const facts = await client.recall("database decision", {
  branch: "main",
  limit: 5,
});

for (const fact of facts) {
  console.log(fact.distance, fact.blobId, fact.text);
}
```

Lower distance means a closer semantic match.

## Branch

```ts
await client.branch("experiment/redis-cache", { from: "main" });
```

Branch creation writes to Sui because it changes the `MemoryTree`.

## Merge Proposal

```ts
await client.proposeMerge({
  fromBranch: "experiment/redis-cache",
  intoBranch: "main",
  resolverId: process.env.MEMFORK_RESOLVER_ID!,
});
```

Use this for resolver-governed merges. For simple product workflows, you can also implement a semantic merge by recalling source facts and committing selected facts to the target branch.

## Delegate Access

```ts
await client.grantDelegate("0xagentAddress", {
  branches: ["feature/auth"],
  // perms can use exported permission helpers when needed
});

await client.revokeDelegate("0xagentAddress");
```

Delegates allow another signer or agent to operate on scoped parts of a memory tree.

## Mainnet Gas Sponsorship

```bash
export MEMFORK_SPONSOR_URL=https://sponsor.example.com
```

When configured, the SDK sends transactions through the sponsor flow so developers do not need to hold SUI directly in the app signer.

## When To Use Core Directly

Use `@memfork/core` directly for:

- branch creation buttons
- diff and merge panels
- server-side route handlers
- custom merge policies
- admin tools
- delegate management
- CLIs and scripts

For model calls, prefer the [Vercel AI SDK adapter](/sdk/vercel-ai). For graph state, prefer the [LangGraph adapter](/sdk/langgraph).
