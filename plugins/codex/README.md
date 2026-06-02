# MemForks — Codex Plugin

Blockchain-anchored, branch-aware agent memory for Codex. Every fact you teach
Codex is cryptographically committed to Sui — not a local file.

## What it does

| Lifecycle | Action |
|-----------|--------|
| Session start | `memfork recall` injects top facts for the current Git branch |
| Each prompt | Semantic recall if the query matches prior memory (threshold 0.35) |
| Turn end | `memfork commit` extracts and anchors learned facts on-chain |
| Git branch switch | Memory automatically tracks to the new branch |

## Install

```bash
# Install the CLI
npm install -g @memfork/cli

# Initialise a MemForks tree for this project
memfork init

# Then install the plugin from the Codex marketplace:
# Settings → Plugins → Add from local path → point to this directory
```

## Configuration

Set these in your shell profile or project `.env`:

| Variable | Description |
|----------|-------------|
| `MEMFORK_TREE_ID` | Sui object ID of your MemoryTree |
| `MEMFORK_PRIVATE_KEY` | Ed25519 signer (bech32 `suiprivkey1…` format) |
| `MEMFORK_MEMWAL_ACCOUNT` | MemWal account ID for blob storage |
| `MEMFORK_MEMWAL_KEY` | MemWal delegate key |
| `MEMFORK_NO_CAPTURE=1` | Disable auto-commit (read-only mode) |
| `MEMFORK_BRANCH=<name>` | Override branch (default: current Git branch) |

## Skills

| Skill | Trigger |
|-------|---------|
| `memory-recall` | "recall", "what do you remember", "prior context" |
| `memforks-status` | "status", "proposals", "log", "show me the memory" |
