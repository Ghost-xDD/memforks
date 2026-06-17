# MemForks

**Git for AI agent memory.** A versioned commit graph — branches, forks, merges, time-travel — for everything agents learn, stored on Walrus, settled on Sui.

```
main:          c1 ── c2 ── c3 ─────────── c7 (HEAD)
                          \                /
hypothesis-A:              c4 ── c5 ──────      (merged via onchain resolver)
                               \
hypothesis-B:                   c6              (rejected — still queryable)
```

---

## The Problem

AI agents are stateless and fragmented. They lose context across sessions, can't share knowledge across tools or teammates, and their memory is locked to a single app, model, or device.

Persistent memory layers like MemWal solve the *storage* half: durable, encrypted, semantically-recalled memory on Walrus. But persistence alone leaves memory as a **flat, linear append-log** — and that breaks down the moment agents do real work:

- **No isolation.** An agent can't explore a risky hypothesis without polluting the good context. Rolling back means losing everything since the last good state.
- **No parallel exploration.** Running competing strategies means cloned memory blobs nobody can merge back.
- **No collaboration semantics.** Two agents writing to shared memory is last-write-wins. No merge protocol, no conflict resolution, no provenance.
- **No auditability.** When an agent reaches a conclusion, the trail of *why* — including the alternatives it considered and rejected — is gone with the session.

Git solved exactly these problems for code. MemForks solves them for agent memory.

## What it is

MemForks is the version-control layer on top of the Walrus memory stack; the same conceptual leap that Git made 
for code, applied to what AI agents learn and remember

| Layer | Technology | Responsibility |
|-------|------------|---------------|
| **Storage** | MemWal + Walrus + SEAL | Encrypted blob storage and semantic recall |
| **Version control** | MemForks (this repo) | Immutable commit DAG, branch semantics, merge protocol |
| **Settlement** | Sui | Cryptographic anchoring, resolver voting, finality |

MemWal handles *where* memories live. MemForks handles *when* they were recorded, *which branch* they belong to, and *how* conflicting memories get reconciled.

Three primitives:

1. **Forkable memory trees** — `MemoryTree` is a Sui Move object; branches are named pointers into a content-addressed commit DAG. Commits are encrypted blobs on Walrus; forking is a pointer write, free and instant.
2. **Composable merge resolvers** — merges aren't a vibe check from one model. Typed, on-chain merge policies: `JuryReconcile(k-of-n)` with signed attestations enforced by the Move contract, `LlmReconcile`, `LastWriteWins`, `Union`, and combinators (`Sequence`, `And`).
3. **Branch-scoped delegates** — capability objects that say "this agent may write to branch X, fork from Y, but cannot merge into main." Self-enforcing through Move preconditions.

The result: agents can explore in parallel, merge with verifiable governance, and produce a cryptographically auditable trail of how every conclusion was reached — **including the paths that lost**. A log remembers what you chose. MemForks remembers what you rejected, and why.

> MemForks versions what the agent *knows*, not what it *makes*. Artifact storage (datasets, reports, files an agent produces) is a sibling concern; commits can carry artifact references on Walrus so produced outputs inherit the same provenance trail.

---

## Quick start (2 commands)

```bash
npm install -g @memfork/cli

memfork init --quick       # keygen → provision → memory tree (~30s)
memfork install cursor     # wire the memory MCP + MemForks rule into Cursor
```

That's it. Restart Cursor — the agent now recalls and commits memory across sessions,
scoped to the current Git branch — every commit hash-chained on Walrus, every merge settled on Sui.

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
| Record a decision in the DAG | `memfork commit --branch <b> --facts "…"` (hash-chained Walrus blob) |
| Propose a memory merge | `memfork merge <from> <into> --resolver <id>` |
| Check the DAG | `memfork status` / `memfork log` / `memfork ui` |

The MemWal MCP server handles storage and recall natively as tool calls.
The `memfork` CLI handles the versioning layer — commits as hash-chained Walrus blobs, forks and merges settled on-chain.

---

## Built with MemForks

coming soon

---

## Who it's for

| Who | What MemForks gives them |
|---|---|
| **Agent app builders** (LangGraph, Vercel AI SDK) | One-line adapter replaces the hand-rolled vector-DB memory layer — and adds branching per user/session, A/B strategies, rollback, and per-fact Sui provenance |
| **Coding-agent teams** (Cursor + Codex on one codebase) | One shared `MemoryTree`: a convention taught to one tool is recalled by the other — different machine, different tool, fresh session |
| **Operators of long-running agents** (research, trading, monitoring) | Fork strategies, auto-abandon underperformers via evaluator resolvers, roll back bad decisions without losing accumulated context |
| **Multi-agent systems** | A real merge protocol for shared state instead of last-write-wins races |
| **Regulated domains** (finance, health, legal) | "Show me the reasoning trail" becomes a verifiable query — on-chain merge anchors plus hash-chained Walrus history — not an archaeology project |

---

## Technical implementation & Sui integration

Sui isn't a logo on the slide — it's the settlement layer the design depends on:

- **`MemoryTree` and merge anchors are Sui objects.** Branch creation is a Move transaction; ownership and delegation use Sui's capability model.
- **Jury merges are enforced by the contract.** Attestors sign votes via `submit_attestation`; `finalize_merge` verifies the k-of-n threshold and a fast-forward guard before advancing the branch head. Every vote is an independently verifiable transaction on Sui Explorer.
- **Commits are off-chain and free** — structured blobs written to Walrus through MemWal (SEAL-encrypted, semantically indexed), hash-chained via parent blob IDs. The chain only sees what matters: branch creation and merge settlement. This keeps the write path as fast as `memwal.remember()` while keeping settlement verifiable.
- **Gas is sponsored.** A sponsorship service co-signs transactions so end users never touch gas — `memfork init --quick` to first commit with no wallet setup.
- **Live UI from Sui events** — the visualizer subscribes to MemForks events for real-time DAG updates.

---

## Repository structure

```
packages/               Publishable npm packages
  core/                 @memfork/core — TypeScript SDK
    src/client.ts       MemForksClient (connect, commit, recall, merge, …)
    src/indexer.ts      Ledger event subscription + polling
  cli/                  @memfork/cli — the memfork binary
    src/commands/
      init.ts           memfork init [--quick]
      install.ts        memfork install cursor|codex
      doctor.ts         memfork doctor
      ops.ts            status, log, recall, commit, merge, proposals, ui
      provision.ts      auto-provisioning (keygen, provision, tree)
    src/config.ts       layered config (env → ~/.memfork/credentials.json → .memfork/config.json)
  vercel-ai/            @memfork/vercel-ai — Vercel AI SDK LanguageModelV1Middleware
  langgraph/            @memfork/langgraph — LangGraph BaseCheckpointSaver

apps/
  memforks-chat/        Reference chat app — branch-aware memory with Vercel AI SDK + Next.js
  visualizer/           DAG visualizer (React + Vite)

services/               Off-chain daemons (not published)
  resolver/             resolver daemon (jury / LLM reconciliation)
  sponsor/              gas sponsorship service

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
      "url": "https://relayer.memory.walrus.xyz/api/mcp",
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

### Visualizer

A live DAG explorer — commit inspector, real-time Sui event polling, replay. `memfork ui` opens it against your tree, or run it standalone:

```bash
cd apps/visualizer && npm run dev
```

---

## Status

A working system on **mainnet**, not a demo harness:

- **Move contracts** (`memforks::tree`, `memforks::acl`, `memforks::resolver`) — deployed: branch creation, merge proposals, k-of-n attestation collection, and finalization enforced on-chain. <!-- TODO: Sui Explorer package link -->
- **Four published npm packages** — [`@memfork/core`](https://www.npmjs.com/package/@memfork/core) · [`@memfork/cli`](https://www.npmjs.com/package/@memfork/cli) · [`@memfork/vercel-ai`](https://www.npmjs.com/package/@memfork/vercel-ai) · [`@memfork/langgraph`](https://www.npmjs.com/package/@memfork/langgraph)
- **Coding-tool plugins** — `memfork install cursor` / `memfork install codex`
- **Off-chain services** — resolver daemon (jury / LLM reconciliation) and gas sponsorship
- **Protocol spec** — [`research/SPEC.md`](research/SPEC.md) v0.1.0: entry functions, events, error codes, resolver kinds, commit payload format

---

## Vision

Version control changed how humans build software together: branching made experimentation safe, merging made collaboration tractable, history made trust possible. Agent memory is at the pre-git stage today — linear, siloed, unauditable.

MemForks is the shared remote for agent memory. The roadmap: per-branch cryptographic isolation (designed; an upstream `namespace_scope` proposal to MemWal), a CrewAI adapter to unlock the Python ecosystem, time-travel `checkout`, a conformance suite so third-party implementations are testable, and cross-tree references. The goal is the substrate other agent systems on Sui plug into — so that what an agent learns is durable, portable, governable, and verifiable by default.

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

## Documentation

| Doc | Contents |
|-----|----------|
| [docs/developer-guide.md](./docs/developer-guide.md) | Full setup walkthrough, day-to-day use, CI config, troubleshooting |
| [docs/architecture.md](./docs/architecture.md) | Stack diagram, MemWal vs MemForks distinction, auth chain, data flows |
| [docs/git-comparison.md](./docs/git-comparison.md) | How MemForks semantics map to git |
| [research/SPEC.md](./research/SPEC.md) | Protocol spec v0.1.0 |

---

## Links

- **Website:** https://memforks.dev
- **npm:** `@memfork/core` · `@memfork/cli` · `@memfork/vercel-ai` · `@memfork/langgraph`

---

## License

Apache-2.0
