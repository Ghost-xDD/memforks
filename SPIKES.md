# MemForks — Spike Results

> Fill this in as you run each spike.  All four must be answered before Phase 1 begins.
> These answers permanently close unknowns that could invalidate the architecture.

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

## D-2 — MemWal namespace with CBOR payload

**Script:** `spikes/d2-cbor-payload.ts`
**Owner:** Eng B
**Blocks:** Commit payload design (SPEC §8)

### Question
Can a MemWal memory entry carry an arbitrary structured CBOR blob
`{ v, tree, parents, branch, author, ts_ms, delta }` — not just plaintext?
Does the relayer reject binary/non-string content?

### Result
- [ ] **PASSED** / [ ] **FAILED** / [ ] **BLOCKED**

### Observations
```
Content-type accepted by relayer: _______________
Max blob size (if known): _______________
Encoding used by relayer for storage: _______________
CBOR roundtrip stable: _______________
```

### Decision
> If raw CBOR is not supported: use JSON-serialised payload and base64-encode
> binary fields.  Update SPEC §8 note accordingly.

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
