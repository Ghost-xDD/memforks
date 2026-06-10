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

memfork init --quick       # keygen → provision → memory tree (~30s)
memfork install cursor     # wire the memory MCP + MemForks rule into Cursor
```

That's it. Restart Cursor — the agent now recalls and commits memory across sessions,
scoped to the current Git branch, with every significant decision anchored on the ledger.

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
| Anchor a decision | `memfork commit --branch <b> --facts "…"` |
| Propose a memory merge | `memfork merge <from> <into> --resolver <id>` |
| Check the DAG | `memfork status` / `memfork log` / `memfork ui` |

The MCP server handles storage and recall natively as tool calls.
The `memfork` CLI handles the versioning layer.

---

## Repository structure

```
contracts/              On-chain smart-contract package
  memforks::tree        MemoryTree object, branch heads, commit anchors
  memforks::acl         Ownership and signer management
  memforks::resolver    On-chain merge proposal + attestation protocol

sdk/                    @memfork/core — TypeScript SDK
  src/client.ts         MemForksClient (connect, commit, recall, merge, …)
  src/indexer.ts        Ledger event subscription + polling

cli/                    @memfork/cli — the memfork binary
  src/commands/
    init.ts             memfork init [--quick]
    install.ts          memfork install cursor|codex
    doctor.ts           memfork doctor
    ops.ts              status, log, recall, commit, merge, proposals, ui
    provision.ts        auto-provisioning (keygen, provision, tree)
  src/config.ts         layered config (env → ~/.memfork/credentials.json → .memfork/config.json)

plugins/
  cursor/               Cursor plugin
    rules/memforks.mdc  always-on agent guidance rule
  codex/                Codex plugin
    .codex-plugin/      plugin.json + skills/

adapters/
  vercel-ai/            @memfork/vercel-ai — Vercel AI SDK LanguageModelV1Middleware
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
| User | `~/.memfork/credentials.json` | private key, delegate key | ✗ never (chmod 600) |
| CI/CD | env vars (`MEMFORK_*`) | override any value | — |

Run `memfork doctor` to verify all three layers resolve correctly.

---

## memfork init --quick explained

`--quick` does full auto-provisioning — no external dashboard, no copy-pasting:

1. Generates a fresh Ed25519 keypair
2. Requests testnet tokens
3. Provisions a storage account → `accountId`
4. Generates an Ed25519 delegate keypair
5. Registers the delegate → delegate registered
6. Creates a MemoryTree → `treeId`
7. Saves everything to `~/.memfork/credentials.json`

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
// recalled context is injected before generate; response is committed on-chain after.
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

## Development

```bash
npm install          # install all workspace packages
npm run build        # build sdk + cli (links memfork globally)
npm test             # run cli unit + integration + E2E tests

# Deploy contracts to a local network
./scripts/deploy.sh
source .deployed.env

# Start the DAG visualizer
cd app && npm run dev
```

### Running tests

```bash
cd tests/cli
node --test          # 21 tests: config, install, E2E, provision
```

---

## License

Apache-2.0
