# @memfork/cli

Command-line interface for [MemForks](https://github.com/memfork/memforks) — on-chain, branch-aware agent memory.

Initialize a memory tree, commit facts, branch and merge, onboard teammates, and install IDE plugins.

## Install

```bash
npm install -g @memfork/cli
# or run without installing
npx @memfork/cli init
```

## Quick start

```bash
# One-shot setup on mainnet (gas sponsored — no SUI required)
memfork init

# Verify everything works
memfork doctor

# Install Cursor plugin (MemWal MCP + MemForks rules)
memfork install cursor
```

Restart your IDE. The agent recalls and commits memory scoped to your Git branch.

## Commands

### Setup

| Command | Description |
|---------|-------------|
| `memfork init` | Interactive setup — create or link a memory tree |
| `memfork init --quick` | Auto-provision key, MemWal account, and tree (testnet) |
| `memfork join` | Onboard to an existing tree (team member) |
| `memfork doctor` | Verify config, RPC, credentials, and on-chain state |
| `memfork install cursor` | Install Cursor MCP + rules |
| `memfork install codex` | Install Codex plugin scaffold |

### Memory operations

| Command | Description |
|---------|-------------|
| `memfork status` | Tree, network, branch, signer |
| `memfork log` | Recent commits on a branch |
| `memfork recall <query>` | Semantic recall from CLI |
| `memfork commit -m "…" --facts "…"` | Anchor facts on-chain |
| `memfork branch <name>` | Create a new branch |
| `memfork checkout <name>` | Switch active branch |
| `memfork diff <a> <b>` | Fact diff between branches |
| `memfork merge <from> <into> --resolver <id>` | Propose a merge |
| `memfork proposals` | List open merge proposals |

### Access control

| Command | Description |
|---------|-------------|
| `memfork grant --agent <addr>` | Grant on-chain delegate access |
| `memfork grant-memwal --agent <addr> --pubkey <hex>` | Register MemWal decrypt key |
| `memfork revoke --agent <addr>` | Revoke delegate |
| `memfork delegates` | List current delegates |

## Config files

| File | Committable? | Contents |
|------|--------------|----------|
| `.memfork/config.json` | Yes | `treeId`, `network`, `defaultBranch` |
| `~/.memfork/credentials.json` | No | Private keys, MemWal delegate key |

Never commit credentials. Share `.memfork/config.json` via git so teammates can `memfork join`.

## Team onboarding

**Teammate:**

```bash
git clone <repo>   # .memfork/config.json is already there
memfork join
```

**Tree owner** (runs the printed commands):

```bash
memfork grant --agent <teammate-address>
memfork grant-memwal --agent <teammate-address> --pubkey <hex>
```

## Environment variables

| Variable | Description |
|----------|-------------|
| `MEMFORK_TREE_ID` | MemoryTree object ID |
| `MEMFORK_PRIVATE_KEY` | Sui private key (`suiprivkey1…`) |
| `MEMFORK_NETWORK` | `mainnet` (default) or `testnet` |
| `MEMFORK_SPONSOR_URL` | Gas sponsor service URL |
| `MEMFORK_PACKAGE_ID` | Override Move package ID |

## Links

- [@memfork/core](https://www.npmjs.com/package/@memfork/core) — TypeScript SDK
- [Developer guide](https://github.com/memfork/memforks/blob/main/docs/developer-guide.md)
- [Git comparison](https://github.com/memfork/memforks/blob/main/docs/git-comparison.md)

## License

Apache-2.0
