# MemForks — Cursor Plugin

On-chain, branch-aware memory for Cursor. Automatically recalls prior context at
session start and commits learned facts after each turn.

## Install

```bash
# One-liner install into the current project
npx @memfork/cli install-cursor

# Or run the script directly
bash plugins/cursor/install.sh
```

This copies `memforks.mdc` into `.cursor/rules/` and two hook scripts into
`.cursor/hooks/`, then merges `hooks.json`.

## What gets installed

```
.cursor/
├── rules/
│   └── memforks.mdc          ← always-on agent instruction rule
├── hooks/
│   ├── memforks-session-start.sh
│   └── memforks-stop.sh
└── hooks.json                ← sessionStart + stop lifecycle hooks
```

## Configuration

| Env var | Description |
|---------|-------------|
| `MEMFORK_TREE_ID` | Sui MemoryTree object ID |
| `MEMFORK_PRIVATE_KEY` | Ed25519 signer (`suiprivkey1…`) |
| `MEMFORK_MEMWAL_ACCOUNT` | MemWal account object ID |
| `MEMFORK_MEMWAL_KEY` | MemWal delegate key |
| `MEMFORK_NO_CAPTURE=1` | Disable auto-commit (read-only) |
| `MEMFORK_BRANCH=<name>` | Override branch name |

## Uninstall

```bash
rm .cursor/rules/memforks.mdc
rm .cursor/hooks/memforks-*.sh
# Edit .cursor/hooks.json to remove sessionStart/stop entries
```
