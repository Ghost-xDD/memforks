# Troubleshooting

Start with:

```bash
memfork doctor
```

For hosted apps:

```bash
memfork doctor --env
```

## CLI Cannot Find Config

Symptoms:

- `no treeId found`
- `no private key for tree`
- SDK connect fails before making network calls

Fix:

```bash
memfork init --quick
memfork doctor
```

For CI or hosted apps, set:

```bash
MEMFORK_TREE_ID=0x...
MEMFORK_PRIVATE_KEY=suiprivkey1...
MEMFORK_MEMWAL_ACCOUNT=0x...
MEMFORK_MEMWAL_KEY=...
MEMFORK_NETWORK=testnet
```

## Credential Permissions Error

`~/.memfork/credentials.json` should be readable only by your user:

```bash
chmod 600 ~/.memfork/credentials.json
```

Run `memfork doctor` again.

## MemWal MCP Tools Not Visible In Cursor

After installing:

```bash
memfork install cursor
```

Quit and restart Cursor. MCP servers are loaded on startup.

If tools still do not appear:

1. Re-run `memfork doctor`.
2. Re-run `memfork install cursor`.
3. Restart Cursor again.

## `401 Unauthorized` From MemWal Relayer

The delegate key may be wrong, expired, or revoked.

```bash
memfork init
memfork install cursor
```

For hosted apps, update `MEMFORK_MEMWAL_KEY` in your secret manager.

## Gas Drip Failed During `init --quick`

The CLI calls the MemForks sponsor service to send 0.02 SUI to the fresh address before the MemWal bootstrap steps. If the drip fails:

**Rate limit (1 drip per IP per 24 h)** — wait 24 hours and re-run, or fund the address manually and re-run:

```bash
memfork init --quick
```

**Sponsor unreachable** — the deployed sponsor may be down. Check `https://memforks-sponsor-production.up.railway.app/health`. If you are running your own sponsor, set:

```bash
export MEMFORK_SPONSOR_URL=https://your-sponsor.example.com
```

**Already has balance (skipped)** — this is not an error. The CLI detected the address already has gas and skipped the drip. Setup continues normally.

The `init --quick` command is idempotent and skips completed steps (existing MemWal account, registered delegate key) if you re-run after a partial failure.

## `init_tree` Rate Limit Hit

The sponsor allows 1 `initTree` per IP per day. If you re-run `memfork init --quick` multiple times from the same IP within 24 hours you may hit this limit.

Wait 24 hours, or use a different network connection, then re-run:

```bash
memfork init --quick
```

## Wrong Network Or Relayer

Make sure the relayer matches the network:

| Network | Relayer |
| --- | --- |
| `testnet` | `https://relayer-staging.memory.walrus.xyz` |
| `mainnet` | `https://relayer.memory.walrus.xyz` |

Check:

```bash
echo $MEMFORK_NETWORK
echo $MEMFORK_RELAYER_URL
```

## Vercel AI App Recalls Nothing

Check:

- Is `branch` the branch where facts were committed?
- Is `recallLimit` greater than `0`?
- Did the response finish streaming so `autoCommit` could run?
- Are server-side env vars available in the route handler?
- Are you filtering with a strict `recallThreshold`?

For UI debugging, manually call `client.recall()` and display the raw results.

## LangGraph State Does Not Resume

Check:

- Are you passing the same `thread_id` on the next run?
- Did `threadToBranch` change between runs?
- Are `MEMFORK_*` credentials pointing to the same tree?
- Is the checkpointer passed to `.compile({ checkpointer })`?

Stable thread IDs are required for compounding memory.

## Sponsor Returns `429`

The sender exceeded the configured rate limit.

Adjust:

```bash
RATE_MAX_PER_WIN=50
RATE_WINDOW_MS=60000
```

For production, use a shared rate limiter if multiple sponsor instances run concurrently.

## Sponsor Returns `503`

The sponsor gas pool is empty or unavailable.

Fund the sponsor wallet and consider splitting gas coins for concurrency.

## Build Or Install Warnings

Some dependencies in the Sui stack may warn about Node engine versions. If installs or builds fail, use the Node version requested by the warning, then reinstall dependencies.
