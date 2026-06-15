# Developer Guide

This content has been split into the VitePress guide:

- [Quickstart](/getting-started/quickstart)
- [Configuration](/getting-started/configuration)
- [Command Line](/cli/)
- [Troubleshooting](/operations/troubleshooting)
# Developer Guide

How to set up and use MemForks as a developer — whether you're using the plugins
in your own project or building on top of the SDK.

---

## 1. Install the CLI

```bash
npm install -g @memfork/cli
```

---

## 2. Provision (one time, per machine)

```bash
memfork init --quick
```

This is fully automated on testnet (~30 seconds):

1. Generates a fresh Ed25519 keypair
2. Funds it from the Sui testnet faucet (no wallet required)
3. Creates a MemWal account on-chain
4. Generates and registers a delegate key with MemWal
5. Creates a MemoryTree on Sui
6. Saves everything to `~/.memfork/credentials.json`

A project config is also written to `.memfork/config.json` in the current
directory (safe to commit — contains only `treeId` and `network`, no secrets).

**Already have a Sui key and MemWal account?** Use manual mode:

```bash
memfork init     # interactive, paste your existing IDs
```

---

## 3. Verify the setup

```bash
memfork doctor
```

Checks:
- Config files exist and are readable
- Credentials file permissions (must be chmod 600)
- Sui RPC reachable
- MemWal relayer reachable
- MemoryTree object exists on-chain
- Signer has enough gas

---

## 4. Install an IDE plugin

### Cursor

```bash
memfork install cursor
```

Writes:
- `~/.cursor/mcp.json` — MemWal MCP server (Streamable HTTP, auto-authenticated)
- `.cursor/rules/memforks.mdc` — always-on agent guidance rule

Restart Cursor. The agent now has `memwal_recall`, `memwal_remember`, and
`memwal_analyze` as native MCP tool calls, plus guidance on when to run
`memfork commit` for on-chain anchoring.

### Codex

```bash
memfork install codex
codex plugin add .codex-plugin
```

Writes:
- `~/.codex/config.toml` — adds `[mcp_servers.memwal]` entry
- `.codex-plugin/` — skills and plugin metadata

---

## 5. Day-to-day use

You don't need to do anything manually. The agent handles memory automatically:

| Event | What happens |
|-------|-------------|
| You ask about a prior decision | Agent calls `memwal_recall`, finds context |
| You make an architectural decision | Agent calls `memwal_remember` to save it |
| A significant decision warrants a record | Agent runs `memfork commit` |
| Two branches need reconciling | `memfork merge` proposes it; resolver handles the rest |

### Manual operations

```bash
memfork status                             # tree, branch, signer, head commit
memfork log --branch main                  # recent commits on a branch
memfork recall "postgres"                  # semantic recall from CLI
memfork commit -m "msg" --facts "fact 1"   # manually anchor a decision
memfork branch hypothesis-redis            # create a new branch
memfork branch hypothesis-redis --from main  # branch from a specific source
memfork checkout hypothesis-redis          # switch active branch
memfork diff main hypothesis-redis         # fact diff between two branches
memfork merge feat/auth main \
  --resolver <resolver-id>                 # propose a merge
memfork proposals                          # list open merge proposals
memfork ui                                 # open the DAG visualizer
```

---

## 6. Branch-scoped memory

Memory is namespaced by Git branch. The namespace convention is:

```
branch/<branch-name>
```

When you switch branches, the agent automatically recalls from the new branch's
namespace. Facts committed on `feature/payments` are not visible when you're on
`main` (unless merged).

```bash
git checkout feature/payments
# agent recalls from namespace "branch/feature/payments"

git checkout main
# agent recalls from namespace "branch/main"
```

---

## 7. Merging memory

When two branches have diverged:

```bash
# Propose a merge — non-blocking, resolver runs in background
memfork merge feature/payments main --resolver <resolver-id>

# Check proposal status
memfork proposals
```

The on-chain resolver collects attestations, reconciles conflicting facts (via
jury vote or LLM), and finalises the merge as a Sui transaction. No manual
intervention required.

---

## 8. Team onboarding (`memfork join`)

When a teammate clones the repo, `.memfork/config.json` is already there. They run:

```bash
memfork join
```

This generates a Sui keypair and MemWal delegate key, saves them to `~/.memfork/credentials.json`, and prints two commands for the **tree owner** to run:

```bash
# Owner runs these:
memfork grant --agent <teammate-address>
memfork grant-memwal --agent <teammate-address> --pubkey <hex>
```

`grant` gives the teammate on-chain access (branching, proposing merges). `grant-memwal` registers their MemWal key so they can encrypt/decrypt branch memory. After both, the teammate runs `memfork doctor` to confirm.

---

## 9. SDK auto-config

The SDK can now resolve config automatically — no need to import `@memfork/cli`:

```typescript
import { MemoryClient } from "@memfork/core";

// Reads .memfork/config.json + ~/.memfork/credentials.json + MEMFORK_* env vars
const mem = await MemoryClient.connect();

await mem.branch("hypothesis-redis");
const { blobId } = await mem.commit("hypothesis-redis", {
  facts: ["Redis adds ~2ms latency vs in-proc cache"],
  message: "redis latency benchmark",
});
```

For CI/headless use, set env vars — they take priority over all config files:

```bash
export MEMFORK_TREE_ID=0x…
export MEMFORK_PRIVATE_KEY=suiprivkey1…
export MEMFORK_MEMWAL_ACCOUNT=0x…
export MEMFORK_MEMWAL_KEY=<64-char hex>
```

---

## 10. Using the LangGraph adapter

```bash
npm install @memfork/langgraph @memfork/core
```

```typescript
import { createMemForksCheckpointer } from "@memfork/langgraph";
import { resolveConfig } from "@memfork/cli";

// Reads from ~/.memfork/credentials.json + .memfork/config.json
const cfg = resolveConfig();

const checkpointer = await createMemForksCheckpointer({
  treeId: cfg.treeId,
  signer: cfg.privateKey,
  memwal: {
    accountId:   cfg.memwalAccountId,
    delegateKey: cfg.memwalKey,
  },
});

const app = new StateGraph(MessagesAnnotation)
  .addNode("agent", myAgentNode)
  .compile({ checkpointer });

// Thread ID maps to branch "thread/abc123"
await app.invoke(input, { configurable: { thread_id: "abc123" } });
```

---

## 11. CI / headless environments

Use environment variables — they take priority over all config files:

```bash
export MEMFORK_TREE_ID=0x…
export MEMFORK_PRIVATE_KEY=suiprivkey1…
export MEMFORK_MEMWAL_ACCOUNT=0x…
export MEMFORK_MEMWAL_KEY=<64-char hex>
export MEMFORK_NETWORK=testnet
```

Set these in your CI secrets store. The CLI and SDK both read them automatically.

---

## 12. Config file reference

### `.memfork/config.json` (per-project, commit this)

```json
{
  "treeId":        "0x…",
  "network":       "testnet",
  "defaultBranch": "main"
}
```

Optional fields: `rpcUrl`, `packageId` (for custom deployments).

### `~/.memfork/credentials.json` (global, never commit)

```json
{
  "default": "0x<treeId>",
  "trees": {
    "0x<treeId>": {
      "privateKey":      "suiprivkey1…",
      "memwalAccountId": "0x…",
      "memwalKey":       "<64-char hex>"
    }
  }
}
```

File permissions must be `0600`. `memfork doctor` checks this.

---

## Troubleshooting

### `memfork doctor` shows credential errors

Re-run `memfork init` — it is idempotent and will update stored values.

### MemWal MCP tools not visible in Cursor

Quit and restart Cursor — MCP servers only load at startup.

### Faucet failed during `memfork init --quick`

Fund the address manually:

```bash
# The address is printed during init. Then:
memfork init --quick    # re-run — skips steps that already completed
```

### `401 Unauthorized` from the MemWal relayer

The delegate key may have been revoked. Re-provision:

```bash
memfork init         # generates a new delegate key and registers it
memfork install cursor   # updates ~/.cursor/mcp.json with the new key
```
