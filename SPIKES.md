# MemForks — Spike Results

> Fill this in as you run each spike.  All four must be answered before Phase 1 begins.
> These answers permanently close unknowns that could invalidate the architecture.

## Known constants (confirmed from docs)

```env
# MemWal SDK package
MEMWAL_NPM_PACKAGE=@mysten-incubation/memwal

# Testnet
MEMWAL_PACKAGE_ID=0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6
MEMWAL_REGISTRY_ID=0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437
MEMWAL_RELAYER=https://relayer.staging.memwal.ai

# Mainnet (for reference)
MEMWAL_PACKAGE_ID_MAINNET=0xcee7a6fd8de52ce645c38332bde23d4a30fd9426bc4681409733dd50958a24c6
MEMWAL_REGISTRY_ID_MAINNET=0x0da982cefa26864ae834a8a0504b904233d49e20fcc17c373c8bed99c75a7edd
```

---

## D-1 — MemWal delegate auth end-to-end

**Script:** `spikes/d1-memwal-roundtrip.ts`
**Owner:** Eng B
**Blocks:** Everything — the entire MemForks stack sits on this.

### Question
Can a freshly generated Ed25519 keypair authenticate as a MemWal delegate,
call `remember(payload)`, and get the same payload back from `recall(query)`?

### Result
- [x] **PASSED** — 2026-06-01

### Observations
```
MemWal npm package name:      @mysten-incubation/memwal
Peer dep required:            @mysten/seal (not listed in package.json — must add explicitly)
suiPrivateKey format:         suiprivkey1... bech32 (the Sui CLI export format; MemWal decodes internally)
generateDelegateKey() shape:  { privateKey: string (64-char hex), publicKey: Uint8Array, suiAddress: string }
createAccount() opts:         { suiPrivateKey, suiNetwork, packageId, registryId }
createAccount() returns:      { accountId: string }  ← the MemWalAccount object ID
addDelegateKey() opts:        { suiPrivateKey, suiNetwork, packageId, accountId, publicKey, label? }
MemWal.create() opts:         { key: delegatePrivKey (hex), accountId, serverUrl, namespace }
rememberAndWait() returns:    { blob_id: string (43-char base64url), namespace: string, owner: string }
recall() opts:                { query: string, limit: number }
recall() returns:             { total: number, results: [{ distance: float, blob_id: string, text: string }] }
blob_id length:               43 chars (base64url, Walrus blob reference)
recall distance (semantic):   0.54 (lower = closer; 0 = exact)
Round-trip latency:           ~39s total (remember=~35s network + Walrus write; recall=~4s)
Relayer health endpoint:      GET /health → { status: "ok", version: "0.1.0" }
MemWal account created:       0xf2cc0ecc886e2432d05cb91a2f4c806c83bc064eefc5b283a58760211a8194ba
```

### Decision
- `memwal_blob_id` in `MemoryCommit` stores a **43-char base64url Walrus blob reference**.
- The delegate key used by the SDK agent must be registered on-chain via `addDelegateKey` before any `remember()` call.
- `namespace` in `MemWal.create()` maps 1:1 to the branch namespace (`memforks/<tree_id>/<branch>`).
- Phase 1 SDK will use this exact API shape (key → hex, accountId → bech32 object ID).

---

## D-2 — MemWal namespace with structured commit payload

**Script:** `spikes/d2-cbor-payload.ts`
**Owner:** Eng B
**Blocks:** Commit payload design (SPEC §8)

### Question
Can a MemWal memory entry carry a structured commit payload `{ v, tree, parents, branch, delta }`?
What storage strategy should Phase 1 use?

### Pre-spike finding (from docs, 2026-06-01)
`MemWal.remember(text)` accepts a **plain string**, not raw bytes.
The blob stores encrypted text; embeddings are generated from that text.
Three strategies are possible (all tested in d2-cbor-payload.ts):

| Strategy | What's stored | Semantic recall | Full restore | Complexity |
|---|---|---|---|---|
| **A** — facts as text | Encrypted text facts | ✓ excellent | Partial (structure on-chain) | Low |
| **B** — JSON envelope | JSON-serialised payload | ✓ poor (JSON noise) | ✓ full | Medium |
| **C** — MemWalManual | CBOR + local SEAL | ✓ excellent | ✓ full | High |

**Recommendation: ship Phase 1 with Strategy A; Phase 4 stretch upgrades to Strategy C.**
Structural metadata (parents, tree_id, branch) is already stored on-chain in `MemoryCommit`.

### Result
- [x] **PASSED** — 2026-06-01 (offline CBOR roundtrip; MemWal API confirmed string-only)

### Observations
```
CBOR roundtrip stable (offline): YES — cbor2 encode/decode roundtrip is lossless
CBOR size vs JSON:               CBOR ~30% smaller on typical commit payloads
Deterministic encoding:          Use cdeEncodeOptions from cbor2 (NOT sortKeys: true — throws TypeError)
MemWal.remember() input:         string only — no raw bytes/CBOR support on the standard API
Strategy A recall quality:       tested in D-1 (distance ~0.54 for relevant queries)
Strategy B recall quality:       JSON noise degrades semantic recall — not recommended
MemWalManual (Strategy C):       available for custom CBOR payloads + local encryption (Phase 4)
```

### Decision
> **Strategy A for Phase 1.** `remember(facts.join('\n'))` → `blob_id` stored as
> `MemoryCommit.memwal_blob_id`.  SPEC §8 CBOR wire format is reserved for the
> MemWalManual restore path (Phase 4 stretch).

---

## D-3 — Move module referencing MemWalAccount by ID

**How to test:** Deploy the scaffold to testnet, then call `init_tree` passing
a real `MemWalAccount` object ID as `memwal_account_id`.  Verify the tree is
created and the account ID is stored correctly by reading the tree object.

```bash
# After deploy:
sui client call \
  --package $MEMFORKS_PACKAGE_ID \
  --module tree \
  --function init_tree \
  --args $MEMWAL_ACCOUNT_ID "main" \
  --gas-budget 10000000

# Read the created tree:
sui client object $TREE_ID --json
```

**Owner:** Eng A
**Blocks:** `init_tree` implementation (Phase 1)

### Question
Can a Move module reference a `MemWalAccount` by object ID (as stored in
`MemoryTree.memwal_account: ID`) without needing a cross-contract call?
Can we verify `MemWalAccount.owner` matches the tree owner at creation time?

### Result
- [x] **PASSED** — 2026-06-01 (tx: `AH5MLmwV9UVSkWmGaB7oSAtTEEPsW7QVSaCRsAyzUu74`)

### Observations
```
MemoryTree object ID:     0xbbb95eb69a185a163a5167af190d0ba25f3bfb815f243adaebd00c09e3f1e52d (Shared)
Genesis MemoryCommit ID:  0x1563864e303633d4822fbe498d1519404517bd8eb096e619a6d8749dafd06f7a (Immutable)
BranchACL object ID:      0xa09ab4617d8946dd81179661cfda79787933f21588265ec2c69fefc927bf040e (Shared)
MemWalAccount stored as:  address arg → object::id_from_address() → ID field in MemoryTree
Cross-module read:        NOT needed — MemWalAccount ID is stored opaquely as ID; no on-chain
                          cross-package call required for Phase 1. Validation is off-chain.
init_tree gas cost:       ~10.7M MIST (0.011 SUI) for 3 objects + 1 event
TreeCreated event emitted: yes — parsedJson has tree_id, owner, memwal_account, default_branch, ts_ms
```

### Decision
- Phase 1 does NOT need a Move dependency on the MemWal package.
- `MemoryTree.memwal_account` stores the account ID as an opaque `ID` type.
- Owner validation (ensure MemWalAccount.owner == tree.owner) is done in the SDK off-chain.
- Gas budget for `init_tree`: use **30,000,000 MIST** (safe margin; actual ~11M MIST).

---

## D-4 — Event-driven indexer viability

**Script:** `spikes/d4-event-listener.ts`
**Owner:** Eng A
**Blocks:** Indexer architecture decision

### Question
Does `SuiClient.subscribeEvent({ filter: { MoveEventType: ... } })` reliably
deliver `CommitCreated` events within acceptable latency?
Is the WebSocket API stable enough for a production indexer?

### Result
- [x] **PASSED** — 2026-06-01 (`queryEvents` polling confirmed; WebSocket is blocked on public RPC)

### Observations
```
WebSocket subscribeEvent:   HTTP 405 on https://fullnode.testnet.sui.io — disabled on shared tier.
queryEvents transport:      Works — all event types queryable.
queryEvents latency:        823ms round-trip (testnet public RPC, cold start).
Cursor pagination:          Works — advance cursor by txDigest; hasNextPage present.
TreeCreated parsedJson:     { default_branch, memwal_account, owner, tree_id, ts_ms }
CommitCreated parsedJson:   (not yet emitted — Phase 1 will test this)
Event fields vs SPEC §9:    Match — tree_id, owner, memwal_account confirmed.
ts_ms:                      "0" for now (Phase 1: wire up Clock arg to get real epoch ms).
```

### Decision
- **Primary transport: `queryEvents` polling** (WebSocket unreliable on shared RPC).
- Indexer polls every 2–5s, advances cursor stored in indexer state.
- If a premium WebSocket-capable RPC is available, upgrade to `subscribeEvent`.
- Polling is sufficient for Phase 1; note in indexer docs that WS is a paid-RPC option.

---

## Gate — Contract shape freeze

- [x] D-1 answer recorded — MemWal delegate auth confirmed, blob_id = 43-char base64url
- [x] D-2 answer recorded — CBOR offline stable; Strategy A (facts-as-text) for Phase 1
- [x] D-3 answer recorded — init_tree live on testnet, MemWalAccount stored as opaque ID
- [x] D-4 answer recorded — queryEvents polling confirmed; WebSocket blocked on public RPC
- [x] Both engineers have signed off on entry-function signatures (`SPEC §5`) — 2026-06-01
- [x] Both engineers have signed off on event shapes (`SPEC §9`) — 2026-06-01
- [x] `sdk/src/types.ts` matches Move constants and events
- [ ] CI green (Move build + test + SDK typecheck)

**Phase 0 is DONE when all boxes above are checked.**

### Deployed assets (testnet, 2026-06-01)

| Object | ID |
|--------|----|
| Package | `0x684624f897c88ac1e9701561512bd55caf29f33bb79a51aed607c18a941b78ad` |
| MemWal Package | `0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6` |
| MemWal Registry | `0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437` |
| MemWalAccount (spike) | `0xf2cc0ecc886e2432d05cb91a2f4c806c83bc064eefc5b283a58760211a8194ba` |
| MemoryTree #1 (branch=main) | `0xbbb95eb69a185a163a5167af190d0ba25f3bfb815f243adaebd00c09e3f1e52d` |
| MemoryTree #2 (branch=feature-a) | `0x8dbf1f571db6b87b813c775114c086c7c57e9963d7fdbd7059400c6c223637ab` |
