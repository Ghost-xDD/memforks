# MemForks — Codex Plugin

On-chain, branch-aware memory DAG for Codex.

**Memory storage** is handled by the MemWal MCP server — the agent calls
`memwal_recall` and `memwal_remember` natively as tool calls.

**On-chain versioning** is handled by the `memfork` CLI — decisions get
cryptographically anchored to Sui with branch context and a full commit DAG.

## Setup (one time, per machine)

```bash
# 1. Install the MemForks CLI
npm install -g @memfork/cli

# 2. Initialise your on-chain tree (provisions a Sui key + MemWal account)
memfork init --quick
```

## Install the plugin in Codex

```bash
memfork install codex
```

This reads the credentials provisioned by `memfork init` and does two things:

1. **Writes `~/.codex/config.toml`** — adds `[mcp_servers.memwal]` using the delegate key
   already on disk. No browser login, no extra auth step.

2. **Copies the plugin skills** into `.codex-plugin/` in the current project.

Then register with Codex:

```bash
codex plugin add .codex-plugin
```

## Verify

```bash
memfork doctor
```

## What the agent can do

| Tool / Command | What it does |
|----------------|-------------|
| `memwal_recall(query, namespace)` | Semantic search over branch memory (MCP tool) |
| `memwal_remember(text, namespace)` | Save a fact to branch memory (MCP tool) |
| `memwal_analyze(text)` | Extract and save multiple facts at once (MCP tool) |
| `memfork commit --facts …` | Anchor a decision on-chain with full provenance |
| `memfork merge <src> <dst>` | Propose a cross-branch memory merge |
| `memfork status / log / proposals` | Inspect the on-chain DAG |

Memory is namespaced by Git branch — `namespace="branch/<branch-name>"`.

## What gets installed

```
~/.codex/config.toml       ← [mcp_servers.memwal] entry (HTTP relayer + delegate key)
.codex-plugin/
  plugin.json              ← plugin metadata
  skills/
    memory-recall/         ← when/how to use memwal_recall
    memforks-status/       ← when/how to use memfork commit/merge/status
    memory-fork/           ← multi-hypothesis branch forking
```

MCP credentials come from `~/.memfork/credentials.json` (written by `memfork init`).
No separate browser login. No bearer tokens to copy-paste.

## Architecture

```
Codex agent
  │
  ├── memwal_recall / memwal_remember  →  @mysten-incubation/memwal-mcp
  │                                         (Walrus-backed encrypted memory)
  │
  └── memfork commit / merge / branch  →  @memfork/cli
                                            (on-chain version control on Sui)
```

## Override for CI / headless use

```bash
MEMFORK_TREE_ID=0x…
MEMFORK_PRIVATE_KEY=suiprivkey1…
MEMWAL_ACCOUNT_ID=0x…
MEMWAL_API_TOKEN=<token>
```
