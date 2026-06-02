# MemForks — Codex Plugin

Blockchain-anchored, branch-aware memory for Codex. Every fact you teach
Codex is cryptographically committed to Sui — not a local file.

## Setup (one time, per machine)

```bash
npm install -g @memfork/cli    # install the CLI

memfork init                   # interactive: links your tree, stores
                               # credentials securely in ~/.memfork/credentials.json
```

`memfork init` will ask for:
- your Sui network (testnet by default)
- your MemoryTree object ID (or creates one)
- your Sui private key → stored in `~/.memfork/credentials.json` (chmod 600, never committed)
- your MemWal account ID + delegate key

## Install the plugin

```bash
# From the Codex marketplace (inside Codex):
codex plugin marketplace add ./plugins/codex

# Or via Settings → Plugins → Add from local path
```

## Verify

```bash
memfork doctor
```

That's it. Restart Codex — memory recall starts on the next session.

## What happens automatically

| Lifecycle | Action |
|-----------|--------|
| Session start | `memfork recall` injects top facts for the current Git branch |
| Each prompt | Semantic recall if the query matches prior memory (threshold 0.35) |
| Turn end | `memfork commit` extracts and anchors learned facts on-chain |

## Skills

| Skill | Trigger |
|-------|---------|
| `memory-recall` | "recall", "what do you remember", "prior context" |
| `memforks-status` | "status", "proposals", "log", "show me the memory" |

## Override for CI / headless use

When running without interactive `memfork init` (e.g. in a GitHub Action),
you can still use env vars as a last-resort override:

```bash
MEMFORK_TREE_ID=0x…        # from .memfork/config.json
MEMFORK_PRIVATE_KEY=suiprivkey1…
MEMFORK_MEMWAL_ACCOUNT=0x…
MEMFORK_MEMWAL_KEY=<hex>
```

These always take priority over stored config. For local dev, prefer `memfork init`.
