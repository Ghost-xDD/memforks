# MemForks Sponsor Service

Gas sponsorship backend for MemForks. Co-signs Sui transactions so developers pay no gas when using MemForks on mainnet.

## How it works

Implements the [Sui sponsored transaction](https://docs.sui.io/develop/transaction-payment/sponsor-txn) protocol:

1. Client serializes an unsigned MemForks transaction and POSTs it to `POST /sponsor`
2. This service validates it (only MemForks entry functions allowed — no arbitrary calls)
3. Rate-limits per sender address
4. Adds gas payment from the sponsor wallet, builds final tx bytes, signs them
5. Returns `{ txBytes, sponsorSig }` to the client
6. Client signs the same `txBytes` and submits both signatures to Sui

The user's address remains `tx.sender` — they retain full ownership. The sponsor only pays gas.

## Setup

```bash
npm install
cp .env.example .env
# fill in SPONSOR_PRIVATE_KEY and SUI_NETWORK
npm start
```

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SPONSOR_PRIVATE_KEY` | ✅ | — | Sponsor wallet private key (`suiprivkey1...` or hex) |
| `SUI_NETWORK` | ✅ | `mainnet` | `mainnet` \| `testnet` \| `devnet` |
| `SUI_RPC_URL` | — | auto | Override RPC endpoint |
| `MEMFORK_PACKAGE_ID` | — | production ID | MemForks Move package ID |
| `RATE_MAX_PER_WIN` | — | `20` | Max sponsored tx per sender per window |
| `RATE_WINDOW_MS` | — | `60000` | Rate limit window in ms |
| `SPONSOR_GAS_BUDGET` | — | `10000000` | Gas budget per tx in MIST |
| `PORT` | — | `3100` | HTTP port |

## Funding the sponsor wallet

Each MemForks operation costs ~2–5M MIST (~$0.001). At 1000 tx/day that's ~$1/day.

Pre-split the wallet's SUI into multiple coins to avoid contention on high concurrency:
```bash
# Split 1 SUI coin into 50 × 0.02 SUI coins
sui client split-coin --coin-id <COIN_ID> --amounts 20000000 20000000 ... --gas-budget 10000000
```

## API

### `GET /health`
Returns `{ ok: true, sponsor: "0x..." }`. Use for uptime monitoring.

### `POST /sponsor`
```json
// Request
{ "tx": "<serialized Transaction string>", "sender": "0x<user address>" }

// Response 200
{ "txBytes": "<base64>", "sponsorSig": "<base64 signature>" }

// Response 400 — invalid tx
{ "error": "tx rejected: tx calls unknown package 0x..." }

// Response 429 — rate limited
{ "error": "Rate limit exceeded: 20 sponsored tx per 60s" }

// Response 503 — gas pool empty
{ "error": "gas pool unavailable — try again later" }
```

## Pointing the SDK at this service

```ts
const mem = await MemoryClient.connect({
  // other config auto-resolved from env...
  sponsorUrl: "https://sponsor.your-domain.com",
});
```

Or via environment variable (no code change needed):
```bash
MEMFORK_SPONSOR_URL=https://sponsor.your-domain.com
```

## Deployment

Deploy anywhere that runs Node.js. Recommended: Railway, Fly.io, or a small VPS.

The service is stateless — scale horizontally. For high concurrency, swap the in-memory rate limiter in `src/rate-limit.ts` for a Redis-backed implementation.
