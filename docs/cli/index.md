# Command Line

`@memfork/cli` provisions trees, verifies config, installs IDE integrations, and performs memory operations from the terminal.

## Install

```bash
npm install -g @memfork/cli
```

Or run without installing:

```bash
npx @memfork/cli init --quick
```

## Setup Commands

| Command | Description |
| --- | --- |
| `memfork init` | Interactive setup for a new or existing tree. |
| `memfork init --quick` | Auto-provision a testnet key, MemWal account, delegate key, and tree. |
| `memfork join` | Join an existing tree as a teammate or delegated agent. |
| `memfork doctor` | Verify config, credentials, RPC, relayer, and on-chain state. |
| `memfork doctor --env` | Print environment variables for hosted apps. |
| `memfork install cursor` | Install Cursor MCP config and MemForks agent rule. |
| `memfork install codex` | Install Codex plugin scaffold. |

## Memory Commands

| Command | Description |
| --- | --- |
| `memfork status` | Show tree, network, signer, branch, and head. |
| `memfork log` | Show recent commits for the active branch. |
| `memfork log --branch main` | Show commits for a specific branch. |
| `memfork recall <query>` | Semantic recall from the active branch. |
| `memfork commit -m "..." --facts "..."` | Commit facts to branch memory. |
| `memfork branch <name>` | Create a branch from the active branch. |
| `memfork branch <name> --from main` | Create a branch from a specific source. |
| `memfork checkout <name>` | Switch the local default branch. |
| `memfork diff <a> <b>` | Compare recalled facts between branches. |
| `memfork merge <from> <into> --resolver <id>` | Propose a governed merge. |
| `memfork proposals` | List open merge proposals. |
| `memfork ui` | Open the DAG visualizer when available. |

## Access Control Commands

| Command | Description |
| --- | --- |
| `memfork grant --agent <addr>` | Grant on-chain delegate access. |
| `memfork grant-memwal --agent <addr> --pubkey <hex>` | Register a MemWal decrypt key. |
| `memfork revoke --agent <addr>` | Revoke delegate access. |
| `memfork delegates` | List delegates. |

## Typical Developer Workflow

```bash
memfork init --quick
memfork doctor
memfork install cursor
```

Restart Cursor. The agent can now recall, remember, and commit memory scoped to the current branch.

## Manual Branch Workflow

```bash
memfork branch feature/auth --from main
memfork checkout feature/auth

memfork commit \
  --branch feature/auth \
  -m "auth decision" \
  --facts "Auth will use Privy for stable user identity"

memfork recall "auth decision"
memfork diff feature/auth main
```

## Team Onboarding

Teammate:

```bash
git clone <repo>
memfork join
```

Tree owner runs the commands printed by `join`:

```bash
memfork grant --agent <teammate-address>
memfork grant-memwal --agent <teammate-address> --pubkey <hex>
```

The teammate verifies:

```bash
memfork doctor
```

## Config Files

| File | Committable | Contents |
| --- | --- | --- |
| `.memfork/config.json` | Sometimes | `treeId`, `network`, `defaultBranch`, optional RPC/package values. |
| `~/.memfork/credentials.json` | Never | Private key, MemWal account, MemWal delegate key. |

See [Configuration](/getting-started/configuration) for details.
