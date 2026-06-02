# MemForks

**Git for AI agent memory.** Branch-aware, verifiable, mergeable memory for autonomous agents — built on Sui, MemWal, Walrus, and SEAL.

```
main:          c1 ── c2 ── c3 ─────────── c7 (HEAD)
                          \                /
hypothesis-A:              c4 ── c5 ──────      (merged via on-chain resolver)
                               \
hypothesis-B:                   c6              (abandoned, still queryable)
```

> Sui Overflow 2026 · Walrus Track

---

## What it is

MemForks is **version control for agent memory** — the same conceptual leap that Git made for code, applied to what AI agents learn and remember.

| Layer | Technology | Responsibility |
|-------|-----------|---------------|
| **Storage** | MemWal + Walrus + SEAL | Encrypted blob storage and semantic recall |
| **Version control** | MemForks (this repo) | Immutable commit DAG, branch semantics, merge protocol |
| **Settlement** | Sui | Cryptographic anchoring, resolver voting, finality |

MemWal handles *where* memories live. MemForks handles *when* they were recorded, *which branch* they belong to, and *how* conflicting memories get reconciled.

---

## Quick start (2 commands)

```bash
npm install -g @memfork/cli

memfork init --quick       # keygen → faucet → MemWal account → MemoryTree (~30s)
memfork install cursor     # wire MemWal MCP + MemForks rule into Cursor
```

That's it. Restart Cursor — the agent now recalls and commits memory across sessions,
scoped to the current Git branch, with every significant decision anchored on Sui.

For Codex:

```bash
memfork install codex      # writes ~/.codex/config.toml + .codex-plugin/
codex plugin add .codex-plugin
```

---

## How the agent uses it

Once installed, no developer intervention is needed for day-to-day use.

| What the agent does | How |
|--------------------|-----|
| Recall prior context | `memwal_recall(query, namespace="branch/<branch>")` via MCP |
| Save a learned fact | `memwal_remember(text, namespace="branch/<branch>")` via MCP |
| Anchor a decision on-chain | `memfork commit --branch <b> --facts "…"` |
| Propose a memory merge | `memfork merge <from> <into> --resolver <id>` |
| Check the DAG | `memfork status` / `memfork log` / `memfork ui` |

The MCP server (MemWal) handles storage and recall natively as tool calls.
The `memfork` CLI handles the on-chain versioning layer.

---

## Repository structure

```
contracts/              Sui Move package
  memforks::tree        MemoryTree object, branch heads, commit anchors
  memforks::acl         Ownership and signer management
  memforks::resolver    On-chain merge proposal + attestation protocol

sdk/                    @memfork/core — TypeScript SDK
  src/client.ts         MemForksClient (connect, commit, recall, merge, …)
  src/indexer.ts        Sui event subscription + polling

cli/                    @memfork/cli — the memfork binary
  src/commands/
    init.ts             memfork init [--quick]
    install.ts          memfork install cursor|codex
    doctor.ts           memfork doctor
    ops.ts              status, log, recall, commit, merge, proposals, ui
    provision.ts        auto-provisioning (keygen, faucet, MemWal, tree)
  src/config.ts         layered config (env → ~/.memfork/credentials.json → .memfork/config.json)

plugins/
  cursor/               Cursor plugin
    rules/memforks.mdc  always-on agent guidance rule
  codex/                Codex plugin
    .codex-plugin/      plugin.json + skills/

adapters/
  langgraph/            @memfork/langgraph — LangGraph BaseCheckpointSaver

runtime/
  resolver/             off-chain resolver daemon (jury / LLM reconciliation)

app/                    DAG visualizer (React + Vite)

tests/
  cli/                  unit + integration + E2E tests for the CLI
```

---

## Configuration

MemForks uses a three-layer config — no `.env` files required for normal use.

| Layer | File | Content | Committed? |
|-------|------|---------|-----------|
| Project | `.memfork/config.json` | treeId, network, branch | ✓ yes |
| User | `~/.memfork/credentials.json` | private key, MemWal key | ✗ never (chmod 600) |
| CI/CD | env vars (`MEMFORK_*`) | override any value | — |

Run `memfork doctor` to verify all three layers resolve correctly.

---

## memfork init --quick explained

`--quick` does full auto-provisioning — no external dashboard, no copy-pasting:

1. Generates a fresh Ed25519 keypair
2. Requests SUI from the testnet faucet
3. Calls `createAccount()` on the MemWal Move contract → `accountId`
4. Calls `generateDelegateKey()` → Ed25519 delegate keypair
5. Calls `addDelegateKey()` on-chain → delegate registered
6. Calls `initTree()` → MemoryTree object created on Sui → `treeId`
7. Saves everything to `~/.memfork/credentials.json`

Contract IDs used (public, from [docs.memwal.ai](https://docs.memwal.ai/contract/overview)):

| Network | Package ID | Registry ID |
|---------|-----------|-------------|
| testnet | `0xcf6ad755…` | `0xe80f2fee…` |
| mainnet | `0xcee7a6fd…` | `0x0da982ce…` |

---

## memfork install explained

`memfork install cursor` writes two files:

**`~/.cursor/mcp.json`** — configures the MemWal MCP server using Streamable HTTP transport with the delegate key from `~/.memfork/credentials.json`:

```json
{
  "mcpServers": {
    "memwal": {
      "url": "https://relayer.staging.memwal.ai/api/mcp",
      "headers": {
        "Authorization": "Bearer <delegateKey>",
        "x-memwal-account-id": "<accountId>"
      }
    }
  }
}
```

No browser login. No separate `memwal_login` call. The credentials flow from provisioning directly into the MCP config.

**`.cursor/rules/memforks.mdc`** — an always-on rule that tells the agent when to use `memwal_recall`, `memwal_remember`, and `memfork commit`.

`memfork install codex` does the equivalent for `~/.codex/config.toml`.

---

## LangGraph adapter

```typescript
import { createMemForksCheckpointer } from "@memfork/langgraph";
import { resolveConfig } from "@memfork/cli";

const { treeId, privateKey, memwalAccountId, memwalKey } = resolveConfig();

const checkpointer = await createMemForksCheckpointer({
  treeId,
  signer: privateKey,
  memwal: { accountId: memwalAccountId, delegateKey: memwalKey },
});

const app = new StateGraph(MessagesAnnotation)
  .addNode("agent", myNode)
  .compile({ checkpointer });
```

Each LangGraph thread maps to a MemForks branch. Cross-agent reconciliation via `checkpointer.proposeMerge()`.

---

## Phase status

| Phase | Theme | Status |
|-------|-------|--------|
| **0** | Contracts + SDK spike | ✅ Complete |
| **1** | Core graph MVP | ✅ Complete |
| **2** | Resolvers + merge protocol | ✅ Complete |
| **3** | CLI, plugins, adapters, UI | ✅ Complete |
| **4** | Demos, traction, ship | 🔄 In progress |

---

## Development

```bash
npm install          # install all workspace packages
npm run build        # build sdk + cli (links memfork globally)
npm test             # run cli unit + integration + E2E tests

# Deploy contracts to localnet
./scripts/deploy.sh
source .deployed.env

# Start the DAG visualizer
cd app && npm run dev
```

### Running tests

```bash
cd tests/cli
node --test          # 21 tests: config, install, E2E Sui testnet, provision
```

---

## Documentation

| Doc | Contents |
|-----|---------|
| [docs/developer-guide.md](./docs/developer-guide.md) | Full setup walkthrough, day-to-day use, CI config, troubleshooting |
| [docs/architecture.md](./docs/architecture.md) | Stack diagram, MemWal vs MemForks distinction, auth chain, data flows |
| [research/SPEC.md](./research/SPEC.md) | Protocol spec v0.1.0 |
| [research/IMPLEMENTATION.md](./research/IMPLEMENTATION.md) | Phase plan |

---

## License

Apache-2.0
