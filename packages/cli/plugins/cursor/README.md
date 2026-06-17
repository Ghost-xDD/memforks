# MemForks — Cursor Plugin

On-chain, branch-aware memory DAG for Cursor.

**Memory storage** is handled by the MemWal MCP server — the agent calls
`memwal_recall` and `memwal_remember` natively as tool calls, mid-conversation,
at exactly the right moment.

**On-chain versioning** is handled by the `memfork` CLI — architectural decisions
get cryptographically anchored to Sui with branch context and a full commit history.

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
memfork install cursor
```

This does two things:

1. **Writes `~/.cursor/mcp.json`** — configures the MemWal MCP server using the
   delegate key provisioned by `memfork init`. No browser login needed.

2. **Copies `.cursor/rules/memforks.mdc`** — tells the agent when to use
   `memwal_recall`, `memwal_remember`, and `memfork commit`.

## Verify

```bash
memfork doctor
```

Restart Cursor — the agent now has MemWal MCP tools available immediately.

## What the agent can do

| Tool / Command | What it does |
|----------------|-------------|
| `memwal_recall(query, namespace)` | Semantic search over branch memory (MCP tool) |
| `memwal_remember(text, namespace)` | Save a fact to branch memory (MCP tool) |
| `memwal_analyze(text)` | Extract and save multiple facts at once (MCP tool) |
| `memfork commit --facts …` | Anchor a decision on-chain with full provenance |
| `memfork merge <src> <dst>` | Propose a cross-branch memory merge |
| `memfork status / log / proposals` | Inspect the on-chain DAG |

Memory is namespaced by Git branch — switching branches automatically scopes
recall to the new branch context.

## What gets installed

```
~/.cursor/mcp.json         ← MemWal MCP server (Streamable HTTP, auto-configured)
.cursor/rules/memforks.mdc ← always-on agent guidance rule
```

No shell hooks. No subprocess wrappers. The MCP server is the transport.

## Override for CI / headless use

```bash
MEMFORK_TREE_ID=0x…
MEMFORK_PRIVATE_KEY=suiprivkey1…
MEMFORK_MEMWAL_ACCOUNT=0x…
MEMFORK_MEMWAL_KEY=<hex>
```

## Uninstall

```bash
# Remove the rule:
rm .cursor/rules/memforks.mdc

# Remove the MCP server entry from ~/.cursor/mcp.json:
# Delete the "memwal" key from mcpServers
```
