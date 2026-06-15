# Quickstart

This guide provisions a MemForks tree on mainnet, verifies your local configuration, and shows the first memory operations. No SUI required — gas is sponsored by MemForks.

## Requirements

- Node.js 20 or newer
- npm
- A terminal

For app integrations you will also need a model provider key such as `OPENAI_API_KEY`.

## 1. Install The CLI

```bash
npm install -g @memfork/cli
```

You can also run one-off commands with `npx @memfork/cli`, but installing globally makes the rest of the workflow simpler.

## 2. Provision A Tree

```bash
memfork init --quick
```

Select **mainnet — gas sponsored by MemForks (recommended)** when prompted.

`--quick` performs the full automated setup:

1. Generates a fresh Sui Ed25519 keypair.
2. Requests a gas drip from the MemForks sponsor service (covers MemWal setup).
3. Provisions a MemWal account on-chain.
4. Generates and registers a MemWal delegate key.
5. Creates a MemForks `MemoryTree` on Sui (gas sponsored).
6. Saves credentials to `~/.memfork/credentials.json`.
7. Writes project config to `.memfork/config.json`.

Nothing to copy-paste or fund manually.

## 3. Verify Setup

```bash
memfork doctor
```

`doctor` checks config files, credential permissions, Sui RPC, relayer connectivity, and the `MemoryTree` object.

For environment-based apps, print `.env`-style values:

```bash
memfork doctor --env
```

## 4. Make Your First Branch Commit

```bash
memfork branch experiment/readme --from main

memfork commit \
  --branch experiment/readme \
  -m "documented quickstart decision" \
  --facts "MemForks quickstart provisions on mainnet with zero-friction gas sponsorship"
```

Then recall it:

```bash
memfork recall "how does quickstart provision credentials?" \
  --branch experiment/readme
```

## 5. Add An Adapter

For a chat or generation app:

```bash
npm install @memfork/vercel-ai @memfork/core ai
```

Continue to [Vercel AI SDK](/sdk/vercel-ai).

For a LangGraph workflow:

```bash
npm install @memfork/langgraph @memfork/core @langchain/langgraph
```

Continue to [LangGraph](/sdk/langgraph).

## 6. Install IDE Memory

Cursor:

```bash
memfork install cursor
```

Codex:

```bash
memfork install codex
codex plugin add .codex-plugin
```

Restart the IDE after installation so MCP tools and rules are loaded.

## Next Steps

- Learn the [MemWal vs MemForks distinction](/concepts/overview).
- Read the [configuration guide](/getting-started/configuration).
- Build the [branch-aware chat example](/examples/chat).
