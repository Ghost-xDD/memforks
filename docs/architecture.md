# MemForks Architecture

## The stack

```
┌─────────────────────────────────────────────────────────────┐
│                        Agent (Cursor / Codex / LangGraph)   │
│                                                             │
│   memwal_recall()          memfork commit                   │
│   memwal_remember()        memfork merge                    │
│   memwal_analyze()         memfork status / log             │
└────────────┬───────────────────────┬────────────────────────┘
             │                       │
             ▼                       ▼
┌────────────────────┐   ┌──────────────────────────────────┐
│   MemWal MCP       │   │   MemForks CLI / SDK              │
│                    │   │                                   │
│  Encrypted blob    │   │  Commit DAG                       │
│  storage + search  │   │  Branch semantics                 │
│                    │   │  Merge proposals                  │
│  Walrus (storage)  │   │  Resolver protocol                │
│  SEAL (encryption) │   │                                   │
│  pgvector (search) │   │  @memfork/core SDK                │
└────────────────────┘   └──────────────┬───────────────────┘
                                        │
                                        ▼
                          ┌─────────────────────────┐
                          │   Sui blockchain         │
                          │                         │
                          │  MemoryTree object       │
                          │  CommitCreated events    │
                          │  MergeProposed events    │
                          │  MergeFinalized events   │
                          │  Resolver attestations   │
                          └─────────────────────────┘
```

---

## MemWal vs MemForks — the distinction

The most important concept: **MemWal is the filesystem. MemForks is Git.**

| Concern | MemWal | MemForks |
|---------|--------|---------|
| Storing a memory blob | ✓ | delegates to MemWal |
| Retrieving memories by semantic search | ✓ | delegates to MemWal |
| Encryption at rest | ✓ (SEAL) | delegates to MemWal |
| Cross-client memory sharing | ✓ | inherits |
| Commit history (who recorded what, when) | ✗ | ✓ |
| Branch-scoped namespacing | namespaces (flat) | branch DAG (versioned) |
| Immutable on-chain anchoring | ✗ | ✓ (Sui tx per commit) |
| Merge proposals + resolution | ✗ | ✓ |
| Multi-party attestation | ✗ | ✓ |
| Cryptographic provenance | ✗ | ✓ |

Nobody says Git reinvents a filesystem. Same relationship here.

---

## Auth chain

A single provisioning step (`memfork init --quick`) creates all credentials.
Nothing else requires manual configuration.

```
memfork init --quick
    │
    ├─► Ed25519 keypair            (Sui wallet — signs transactions)
    │       │
    │       └─► testnet faucet    (fund the address for gas)
    │
    ├─► MemWal account             (on-chain identity via Move contract)
    │       accountId = 0x…
    │
    ├─► MemWal delegate key        (Ed25519 — authorises relayer access)
    │       delegateKey = hex(32 bytes)
    │
    └─► MemoryTree                 (on-chain DAG root object)
            treeId = 0x…

Saved to ~/.memfork/credentials.json  (chmod 600, gitignored)
Saved to .memfork/config.json         (treeId + network only, safe to commit)
```

When `memfork install cursor` runs, it reads `delegateKey` and `accountId` from
credentials and writes them directly into `~/.cursor/mcp.json` as Bearer auth
for the MemWal Streamable HTTP MCP endpoint. No second login step.

---

## Data flow: recall

```
User asks Cursor a question
    │
    ▼
Cursor agent calls:
  memwal_recall(
    query="auth system decisions",
    namespace="branch/feature/payments",
    limit=5
  )
    │
    ▼
MemWal MCP server (local stdio or Streamable HTTP)
    │
    ├─► authenticates with delegate key
    ├─► sends query to relayer
    │       │
    │       ├─► pgvector semantic search over namespace
    │       ├─► SEAL decrypt matching blobs
    │       └─► return ranked results
    │
    └─► results injected into agent context
```

---

## Data flow: commit

```
Agent makes a significant architectural decision
    │
    ▼
Agent calls:
  memfork commit \
    --branch feature/payments \
    --message "decided: use postgres not sqlite" \
    --facts "postgres chosen for ACID guarantees" "migration path via Alembic"
    │
    ├─► memfork recall: also saves blob to MemWal for future recall
    │
    └─► submits Sui transaction:
            CommitCreated {
              tree_id:     0x…,
              branch:      "feature/payments",
              parent:      0x… (previous head),
              memwal_blob: 0x… (Walrus blob ID),
              timestamp:   …
            }
            → immutable on-chain anchor
```

---

## Data flow: merge

```
Two branches have diverged — agent A and agent B both learned different things
    │
    ▼
memfork merge feature/A feature/B --resolver <resolver-id>
    │
    ├─► submits MergeProposed on Sui
    │
    ▼
Runtime resolver (off-chain daemon, watching Sui events)
    │
    ├─► sees MergeProposed event
    ├─► fetches both branches from MemWal
    ├─► runs reconciliation (jury vote or LLM)
    ├─► collects attestations from jurors
    │
    └─► once threshold reached:
            MergeFinalized on Sui
                → new head on target branch
                → merged blob in MemWal
```

---

## Config resolution order

When any MemForks component needs config, it resolves in this priority order:

```
1. Environment variables          MEMFORK_TREE_ID, MEMFORK_PRIVATE_KEY, …
   (highest priority — CI/CD, containers)

2. ~/.memfork/credentials.json    secrets: privateKey, memwalKey
   (user-global, chmod 600)

3. .memfork/config.json           project: treeId, network, branch
   (per-project, safe to commit)
```

`memfork doctor` checks all three layers and reports exactly what resolved and what's missing.

---

## Package map

| Package | Path | Role |
|---------|------|------|
| `@memfork/core` | `packages/core/` | TypeScript SDK — MemForksClient, indexer |
| `@memfork/cli` | `packages/cli/` | `memfork` binary + config API |
| `@memfork/langgraph` | `packages/langgraph/` | LangGraph BaseCheckpointSaver |
| `@memfork/vercel-ai` | `packages/vercel-ai/` | Vercel AI SDK middleware |
| MemForks contracts | `contracts/` | Sui Move — tree, acl, resolver |
| Resolver runtime | `services/resolver/` | off-chain merge daemon |
| DAG visualizer | `apps/visualizer/` | React + Vite + d3 |
| Cursor plugin | `plugins/cursor/` | rule + MCP config |
| Codex plugin | `plugins/codex/` | skills + MCP config |
