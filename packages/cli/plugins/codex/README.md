# MemForks — Codex Plugin

On-chain, branch-aware memory DAG for Codex.

**Memory storage** is handled by the MemWal MCP server — the agent calls
`memwal_recall` and `memwal_remember` natively as tool calls.

**On-chain versioning** is handled by the `memfork` CLI — decisions get
cryptographically anchored to Sui with branch context and a full commit DAG.

## Setup (one time, per machine)

```bash
npm install -g @memfork/cli

# Recommended — zero copy-paste, ~30 seconds on testnet:
memfork init --quick

# Or manual if you already have a Sui key + MemWal account:
memfork init
```

## Install the plugin

```bash
memfork install codex
```

This does two things:

1. **Writes `~/.codex/config.toml`** — adds a `[mcp_servers.memwal]` entry using
   the delegate key provisioned by `memfork init`. No browser login needed.

2. **Copies `.codex-plugin/`** — installs the plugin skills into the current project.

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
~/.codex/config.toml       ← MemWal MCP server entry (auto-configured)
.codex-plugin/
  plugin.json              ← plugin metadata
  skills/
    memory-recall/         ← when/how to use memwal_recall
    memforks-status/       ← when/how to use memfork commit/merge/status
```

No shell hooks. The MCP server is the transport.

## Override for CI / headless use

```bash
MEMFORK_TREE_ID=0x…
MEMFORK_PRIVATE_KEY=suiprivkey1…
MEMFORK_MEMWAL_ACCOUNT=0x…
MEMFORK_MEMWAL_KEY=<hex>
```
