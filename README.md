# MemForks

**Git for AI agent memory.** Branch-aware, verifiable, mergeable memory for autonomous agents.

```
main:          c1 ── c2 ── c3 ─────────── c7 (HEAD)
                          \                /
hypothesis-A:              c4 ── c5 ──────      (merged via a resolver)
                               \
hypothesis-B:                   c6              (abandoned, still queryable)
```

---

## What it is

MemForks is **version control for agent memory** — the same conceptual leap that Git made for code, applied to what AI agents learn and remember.

| Layer | Responsibility |
|-------|---------------|
| **Storage** | Encrypted blob storage and semantic recall |
| **Version control** | Immutable commit DAG, branch semantics, merge protocol |
| **Settlement** | Cryptographic anchoring, resolver voting, finality |

The storage layer handles *where* memories live. MemForks handles *when* they were recorded, *which branch* they belong to, and *how* conflicting memories get reconciled.

---

## Quick start (2 commands)

```bash
npm install -g @memfork/cli

memfork init --quick       # keygen → gas drip → MemWal → tree on mainnet (~30s, no SUI needed)
memfork install cursor     # wire the memory MCP + MemForks rule into Cursor
```

That's it. Restart Cursor — the agent now recalls and commits memory across sessions,
scoped to the current Git branch, every commit hash-chained on Walrus, every merge settled on the ledger.

> Gas is sponsored by MemForks. You do not need to hold SUI or fund a wallet.
> Full docs: **[memforks.dev/docs](https://memforks.dev/docs)**

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
| Recall prior context | semantic recall scoped to `branch/<branch>` via MCP |
| Save a learned fact | persist to `branch/<branch>` via MCP |
| Record a decision in the DAG | `memfork commit --branch <b> --facts "…"` (hash-chained Walrus blob) |
| Propose a memory merge | `memfork merge <from> <into> --resolver <id>` |
| Check the DAG | `memfork status` / `memfork log` / `memfork ui` |

The MCP server handles storage and recall natively as tool calls.
The `memfork` CLI handles the versioning layer.

---

## Repository structure

```
packages/               Publishable npm packages
  core/                 @memfork/core     → npmjs.com/package/@memfork/core
    src/client.ts       MemForksClient (connect, commit, recall, merge, …)
    src/indexer.ts      Ledger event subscription + polling
  cli/                  @memfork/cli      → npmjs.com/package/@memfork/cli
    src/commands/
      init.ts           memfork init [--quick]
      install.ts        memfork install cursor|codex
      doctor.ts         memfork doctor
      ops.ts            status, log, recall, commit, merge, proposals, ui
      provision.ts      auto-provisioning (keygen, gas drip, MemWal, tree)
    src/config.ts       layered config (env → ~/.memfork/credentials.json → .memfork/config.json)
  vercel-ai/            @memfork/vercel-ai  → npmjs.com/package/@memfork/vercel-ai
  langgraph/            @memfork/langgraph  → npmjs.com/package/@memfork/langgraph

apps/
  memforks-chat/        Reference chat app — branch-aware memory with Vercel AI SDK + Next.js
  visualizer/           DAG visualizer (React + Vite)

services/               Off-chain daemons (not published to npm)
  resolver/             resolver daemon (jury / LLM reconciliation)
  sponsor/              gas sponsorship service (deployed: memforks-sponsor-production.up.railway.app)
                          POST /drip    — one-time gas drip for new addresses
                          POST /sponsor — co-sign any MemForks transaction

docs/                   VitePress documentation site → memforks.dev/docs

contracts/              On-chain smart-contract package
  memforks::tree        MemoryTree object, branch heads, commit anchors
  memforks::acl         Ownership and signer management
  memforks::resolver    On-chain merge proposal + attestation protocol

plugins/
  cursor/               Cursor plugin
    rules/memforks.mdc  always-on agent guidance rule
  codex/                Codex plugin
    .codex-plugin/      plugin.json + skills/

tests/
  cli/                  unit + integration + E2E tests for the CLI
```

---

## Configuration

MemForks uses a three-layer config — no `.env` files required for normal use.

| Layer | File | Content | Committed? |
|-------|------|---------|-----------|
| Project | `.memfork/config.json` | treeId, network, branch | ✗ no (personal tree) |
| User | `~/.memfork/credentials.json` | private key, delegate key | ✗ never (chmod 600) |
| CI/CD | env vars (`MEMFORK_*`) | override any value | — |

Run `memfork doctor` to verify all three layers resolve correctly.

---

## memfork init --quick explained

`--quick` does full auto-provisioning on **mainnet** — no external dashboard, no copy-pasting, no SUI required:

1. Generates a fresh Ed25519 keypair
2. Requests a gas drip from the MemForks sponsor service (covers steps 3–4)
3. Provisions a MemWal storage account on-chain → `accountId`
4. Generates an Ed25519 delegate keypair and registers it with MemWal
5. Creates a MemoryTree on Sui (gas sponsored) → `treeId`
6. Saves everything to `~/.memfork/credentials.json` and `.memfork/config.json`

All MemForks operations after setup (branch, commit, merge) are also gas-sponsored.
See [`services/sponsor`](services/sponsor) for the sponsorship service source.

---

## memfork install explained

`memfork install cursor` writes two files:

**`~/.cursor/mcp.json`** — configures the memory MCP server using Streamable HTTP transport with the delegate key from `~/.memfork/credentials.json`:

```json
{
  "mcpServers": {
    "memory": {
      "url": "https://<mcp-relayer>/api/mcp",
      "headers": {
        "Authorization": "Bearer <delegateKey>",
        "x-account-id": "<accountId>"
      }
    }
  }
}
```

No browser login. The credentials flow from provisioning directly into the MCP config.

**`.cursor/rules/memforks.mdc`** — an always-on rule that tells the agent when to recall, remember, and commit.

`memfork install codex` does the equivalent for `~/.codex/config.toml`.

---

## Vercel AI SDK adapter

```typescript
import { withMemForks } from "@memfork/vercel-ai";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

// Zero-config: reads from ~/.memfork/credentials.json or MEMFORK_* env vars
const model = withMemForks(openai("gpt-4o"), { branch: "feature/my-feature" });

const { text } = await generateText({ model, messages });
// recalled context is injected before generate; response is committed to branch memory after.
```

Works with `generateText`, `streamText`, `generateObject`. Branch can be resolved dynamically per-request via `branchFromContext`.

---

## LangGraph adapter

```typescript
import { createMemForksCheckpointer } from "@memfork/langgraph";
import { resolveConfig } from "@memfork/cli";

const checkpointer = await createMemForksCheckpointer(resolveConfig());

const app = new StateGraph(MessagesAnnotation)
  .addNode("agent", myNode)
  .compile({ checkpointer });
```

Each LangGraph thread maps to a MemForks branch. Cross-agent reconciliation via `checkpointer.proposeMerge()`.

---

## Reference apps

### memforks-chat

A full-featured chat application demonstrating the complete MemForks memory model in a browser UI. Built with Next.js 15, Vercel AI SDK, and `@memfork/vercel-ai`.

**What it shows:**
- Persistent cross-session memory — the agent recalls facts from prior conversations via semantic search, not message history
- On-chain branching — fork any reply into an isolated `explore/<id>` branch with its own independent memory
- Memory diff — side-by-side panel showing what two branches each know, with shared vs. unique facts highlighted
- Merge — commit a branch's recalled facts back onto `main`
- Thread persistence — switch between branches and return; each thread is exactly where you left it

```bash
cd apps/memforks-chat
cp .env.example .env   # fill in your MEMFORK_* and OPENAI_API_KEY
npm install
npm run dev            # → http://localhost:3001
```

See [`apps/memforks-chat/README.md`](apps/memforks-chat/README.md) for full setup, architecture, API reference, and multi-user patterns.

---

## Development

```bash
npm install          # install all workspace packages
npm run build        # build core + cli (links memfork globally)
npm test             # run cli unit + integration + E2E tests

# Deploy contracts to a local network
./scripts/deploy.sh
source .deployed.env

# Start the DAG visualizer
cd apps/visualizer && npm run dev
```

### Running tests

```bash
cd tests/cli
node --test          # 21 tests: config, install, E2E, provision
```

---

## License

Apache-2.0
