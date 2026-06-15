# Configuration

MemForks resolves configuration from environment variables, local project config, and user credentials. The goal is to keep secrets out of source control while making SDK and CLI calls work with no copy-paste.

## Resolution Order

The SDK and CLI resolve values in this order:

1. Environment variables, such as `MEMFORK_TREE_ID`.
2. `~/.memfork/credentials.json`, for user-global secrets.
3. `.memfork/config.json`, for project-local non-secret config.

Environment variables win because they are best for CI, containers, and hosted apps.

## Project Config

`.memfork/config.json` stores project-level values:

```json
{
  "treeId": "0x...",
  "network": "testnet",
  "defaultBranch": "main"
}
```

This file is safe to commit if it contains only non-secret project metadata. The current repository ignores `.memfork/` by default, so decide deliberately whether your project wants to share this file.

Optional fields:

- `rpcUrl` — custom Sui RPC endpoint.
- `packageId` — custom MemForks Move package ID.
- `sponsorUrl` — gas sponsorship endpoint.

## User Credentials

`~/.memfork/credentials.json` stores private material and must never be committed.

```json
{
  "default": "0x<treeId>",
  "trees": {
    "0x<treeId>": {
      "privateKey": "suiprivkey1...",
      "memwalAccountId": "0x...",
      "memwalKey": "<delegate-key-hex>"
    }
  }
}
```

The file should have `0600` permissions. `memfork doctor` checks this.

## Environment Variables

Use these for hosted apps and CI:

```bash
export MEMFORK_TREE_ID=0x...
export MEMFORK_PRIVATE_KEY=suiprivkey1...
export MEMFORK_NETWORK=testnet
export MEMFORK_MEMWAL_ACCOUNT=0x...
export MEMFORK_MEMWAL_KEY=<delegate-key-hex>
export MEMFORK_RELAYER_URL=https://relayer.memory.walrus.xyz
```

Optional:

```bash
export MEMFORK_RPC_URL=https://fullnode.testnet.sui.io:443
export MEMFORK_PACKAGE_ID=0x...
export MEMFORK_SPONSOR_URL=https://sponsor.example.com
```

## Network Defaults

| Network | MemWal relayer |
| --- | --- |
| `testnet` | `https://relayer-staging.memory.walrus.xyz` |
| `mainnet` | `https://relayer.memory.walrus.xyz` |

The SDK picks a default relayer for the configured network unless `MEMFORK_RELAYER_URL` is set.

## Hosted Apps

For Next.js, Vercel, Railway, or another hosted environment:

1. Run `memfork init --quick` locally to provision testnet credentials.
2. Run `memfork doctor --env`.
3. Copy the printed values into your host's secret manager.
4. Add `OPENAI_API_KEY` or your model provider key separately.

Never put `MEMFORK_PRIVATE_KEY` or `MEMFORK_MEMWAL_KEY` in client-side code. Keep MemForks writes on the server.

## Common Checks

```bash
memfork doctor
memfork status
memfork log --branch main
```

If an SDK call fails with missing config, run `memfork doctor --env` and compare the printed values with your runtime environment.
