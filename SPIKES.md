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
- [ ] **PASSED** / [ ] **FAILED** / [ ] **BLOCKED** (describe below)

### Observations
```
MemWal npm package name confirmed: _______________
Account creation API: _______________
remember() return type / shape: _______________
recall() return type / shape: _______________
Round-trip latency (avg): _______________
```

### Decision
> Record the exact API shape used so Phase 1 SDK code can rely on it.

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
- [ ] **PASSED** / [ ] **FAILED** / [ ] **BLOCKED**

### Observations (fill in after running d2)
```
CBOR roundtrip stable (offline): _______________
CBOR size vs JSON: _______________
Strategy A recall quality (distance score): _______________
Strategy B recall quality: _______________
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
- [ ] **PASSED** / [ ] **FAILED** / [ ] **BLOCKED**

### Observations
```
MemWalAccount Move type path: _______________
MemWalAccount.owner field accessible? _______________
Cross-module read pattern used: _______________
```

### Decision
> If cross-module read is not possible without a dependency on the MemWal package:
> store owner address separately in the tree and validate off-chain.

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
- [ ] **PASSED** / [ ] **FAILED** / [ ] **BLOCKED**

### Observations
```
Subscription established: _______________
First event latency (submit tx → receive event): _______________
Event field names match SPEC §9: _______________
parsedJson shape: _______________
Reconnect behaviour on WS drop: _______________
```

### Decision
**Recommendation:** Event-driven cache (confirmed by IMPLEMENTATION.md §0.1 D-4).

> If WebSocket is unstable: fall back to polling `queryEvents` with a cursor,
> storing the last seen `eventSeq` in the indexer state.

---

## Gate — Contract shape freeze

- [ ] D-1 answer recorded
- [ ] D-2 answer recorded
- [ ] D-3 answer recorded
- [ ] D-4 answer recorded
- [ ] Both engineers have signed off on entry-function signatures (`SPEC §5`)
- [ ] Both engineers have signed off on event shapes (`SPEC §9`)
- [ ] `sdk/src/types.ts` matches Move constants and events
- [ ] CI green (Move build + test + SDK typecheck)

**Phase 0 is DONE when all boxes above are checked.**
