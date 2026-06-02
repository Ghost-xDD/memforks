# MemForks — Cursor Plugin

On-chain, branch-aware memory for Cursor. Automatically recalls prior context
at session start and commits learned facts after each turn.

## Setup (one time, per machine)

```bash
npm install -g @memfork/cli    # install the CLI

memfork init --quick           # ✦ recommended — zero copy-paste:
                               # generates a keypair, hits the faucet,
                               # creates your MemWal account, registers a
                               # delegate key, and initialises your tree
                               # automatically (~30 seconds on testnet)
```

Or if you already have a Sui key and MemWal account:

```bash
memfork init                   # manual mode — paste your existing IDs
```

All secrets are stored in `~/.memfork/credentials.json` (chmod 600, gitignored).

## Install the plugin

```bash
memfork install cursor
```

This copies `memforks.mdc` into `.cursor/rules/` and two hook scripts into
`.cursor/hooks/`, then merges `hooks.json`. Safe to re-run.

## Verify

```bash
memfork doctor
```

Restart Cursor — memory recall starts on the next session.

## What gets installed

```
.cursor/
├── rules/
│   └── memforks.mdc           ← always-on agent guidance rule
├── hooks/
│   ├── memforks-session-start.sh
│   └── memforks-stop.sh
└── hooks.json                 ← sessionStart + stop lifecycle hooks
```

## What happens automatically

| Lifecycle | Action |
|-----------|--------|
| Session start | Recalled branch facts injected as `additional_context` |
| Turn end | `memfork commit --auto-extract` anchors learned facts on-chain (async) |

## Override for CI / headless use

When running without `memfork init`, env vars are the fallback:

```bash
MEMFORK_TREE_ID=0x…        # from .memfork/config.json
MEMFORK_PRIVATE_KEY=suiprivkey1…
MEMFORK_MEMWAL_ACCOUNT=0x…
MEMFORK_MEMWAL_KEY=<hex>
MEMFORK_NO_CAPTURE=1       # disable auto-commit (read-only mode)
```

For local dev, prefer `memfork init` — no copy-pasting into shell profiles.

## Uninstall

```bash
rm .cursor/rules/memforks.mdc
rm .cursor/hooks/memforks-*.sh
# Remove sessionStart/stop entries from .cursor/hooks.json
```
