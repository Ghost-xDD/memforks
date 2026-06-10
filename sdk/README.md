# @memfork/core

TypeScript SDK for [MemForks](https://github.com/memfork/memforks) — git for AI agent memory on Sui.

Branch-aware commits, semantic recall via MemWal, merge proposals, and delegate access control — with mainnet defaults and optional gas sponsorship.

## Install

```bash
npm install @memfork/core
```

Peer stack (installed automatically):

- `@mysten/sui`
- `@mysten-incubation/memwal`

## Quick start

```typescript
import { MemForksClient } from "@memfork/core";

// Auto-config from .memfork/config.json + ~/.memfork/credentials.json
const client = await MemForksClient.connect();

// Or explicit config
const client = await MemForksClient.connect({
  treeId: "0x…",
  signer: process.env.MEMFORK_PRIVATE_KEY!,
  network: "mainnet",
});

// Write facts to the current branch
await client.commit({
  branch: "main",
  message: "Chose PostgreSQL over MongoDB",
  facts: ["Database: PostgreSQL", "Reason: ACID + team familiarity"],
});

// Semantic recall
const facts = await client.recall("database decision", { branch: "main", limit: 5 });
```

## Auto-configuration

`MemForksClient.connect()` with no arguments resolves config from:

1. Environment variables (`MEMFORK_TREE_ID`, `MEMFORK_PRIVATE_KEY`, `MEMFORK_NETWORK`, …)
2. `.memfork/config.json` in the project directory
3. `~/.memfork/credentials.json` for secrets

Run `npx @memfork/cli init` once to generate these files.

## Gas sponsorship (mainnet)

On mainnet, on-chain operations can be gas-sponsored — developers don't need SUI in their wallet:

```bash
export MEMFORK_SPONSOR_URL=https://sponsor.memfork.ai
```

The SDK sends unsigned transactions to the sponsor, receives gas-included bytes, signs, and submits.

## API surface

| Export | Purpose |
|--------|---------|
| `MemForksClient` | Primary client — `commit`, `recall`, `branch`, `proposeMerge`, … |
| `MemoryClient` | Alias for `MemForksClient` |
| `MemForksIndexer` | Event-driven branch head + merge state |
| `resolvers` | Decode on-chain resolver configs |
| `PERM` / `perms` | Delegate permission bitflags |

## Framework adapters

| Package | Use case |
|---------|----------|
| `@memfork/langgraph` | LangGraph checkpointer |
| `@memfork/vercel-ai` | Vercel AI SDK middleware |

## Mainnet package ID

```
0x7df9719d799386d34d657c49ae8cd6f5f03b39036f7c428b556095e42afd852f
```

Override with `MEMFORK_PACKAGE_ID` or `packageId` in config.

## Links

- [MemForks repo](https://github.com/memfork/memforks)
- [Developer guide](https://github.com/memfork/memforks/blob/main/docs/developer-guide.md)
- [MemWal docs](https://docs.memwal.ai/)

## License

Apache-2.0
