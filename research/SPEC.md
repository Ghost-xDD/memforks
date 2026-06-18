# MemForks Protocol Specification

| | |
|---|---|
| **Version** | 0.1.1 |
| **Status** | Locked v0.1.1 — changes require a minor or major bump per §12 |
| **Authors** | MemForks contributors |
| **License** | Apache-2.0 |

> This document specifies the wire format, on-chain data model, and operational semantics of the MemForks protocol. It is intended for implementers building a MemForks-compatible client, server, or alternative reference implementation. For product context, motivation, and roadmap, see `PRD.md`.

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt) and [RFC 8174](https://www.ietf.org/rfc/rfc8174.txt).

---

## 1. Scope

This specification defines:

- The on-chain data model on Sui — Move types, entry functions, and events that constitute the MemForks kernel.
- The off-chain wire format for commit payloads and attestations stored in MemWal/Walrus.
- Resolver semantics — how each resolver kind interprets a merge proposal and produces a verdict.
- Conformance requirements for compliant implementations.

This specification does **not** define:

- The MemWal protocol itself (see [MemWal docs](https://docs.memwal.ai/)).
- The Walrus or SEAL protocols (see their respective specifications).
- LLM, jury, or evaluator implementations — only the interface by which their outputs are bound to the protocol.
- Network transport, RPC framing, or relayer ergonomics — implementations are free to choose.

---

## 2. Terminology

| Term | Definition |
|---|---|
| **Tree** | A `MemoryTree` Move object. The unit of forkable memory. One owner. Many branches. Many delegates. |
| **Owner** | The Sui address that holds administrative authority over a Tree. Set at tree creation; transferable in a future version. |
| **Branch** | A named, mutable pointer to a branch head. Under Model A the head is a Walrus blob ID (the off-chain commit tip); immediately after `init_tree` it is the genesis `MemoryCommit` object ID sentinel (§8.3). Branch names are strings, scoped within a Tree. |
| **Commit** | An immutable node in the commit DAG. Under Model A (§4.2, §8) a regular commit is an **off-chain Walrus blob** addressed by its `memwal_blob_id`, carrying its parents' blob IDs and content hashes (`parent_blob_ids` / `parent_blob_hashes`) to form a verifiable hash chain. It is NOT a Sui object. |
| **MemoryCommit** | The on-chain Move object minted **only** for the genesis commit and for merge anchors (§4.2). Regular agent commits never produce a `MemoryCommit`. |
| **Payload** | The off-chain memory delta of a commit. Stored as a MemWal memory entry (a Walrus blob); addressed by `(memwal_namespace, memwal_blob_id)`. |
| **Delegate** | A Sui address granted scoped operational authority on a Tree via a `DelegateCap`. Distinct from a MemWal delegate key, which authorizes access to the underlying MemWal account. A complete agent identity comprises both. |
| **Resolver** | A `ResolverRef` Move object describing how a merge proposal is to be resolved. Composable via `And` and `Sequence` combinators. |
| **Merge Proposal** | A `MergeProposal` Move object representing an in-flight, attestation-collecting merge between two branches. |
| **Attestation** | A signed payload bound to a Tree, Commit, or Proposal, asserting a verifiable claim (e.g., a jury vote, an evaluator verdict, a quality score). |
| **Resolver Runtime** | An off-chain process that interprets a resolver, gathers attestations, produces a resolved payload, and calls `finalize_merge`. |
| **Epoch** | Sui's epoch, used for capability expiry. Wall-clock timestamps (`ts_ms`) MAY be used for diagnostic and display purposes but MUST NOT be used for security-critical scheduling. |

A commit's payload location is fully specified by `(memwal_account_id, memwal_namespace, memwal_blob_id)`. Implementations MAY denormalize `memwal_account_id` by storing it on the Tree (recommended) and only carrying `(namespace, blob_id)` on each on-chain `MemoryCommit` (genesis and merge anchors); off-chain commits are self-addressing by their own `memwal_blob_id`.

---

## 3. Identity and access

MemForks layers two distinct authorization systems:

1. **MemForks-side authority** — Move capabilities (`DelegateCap`) gate which addresses may perform which operations on a Tree.
2. **MemWal-side authority** — MemWal delegate keys gate which addresses may read or write payloads in the underlying MemWal account.

A compliant agent identity holds **both** an active, non-revoked `DelegateCap` on the target Tree **and** a registered MemWal delegate key on the Tree's `memwal_account_id`. Operations that touch only MemForks state (e.g., `branch`, `revoke_delegate`) require only the former; operations that materially read or write memory payloads require both.

### 3.1 Permission bitmask

`DelegateCap.permissions` is a `u8` bitmask:

| Bit | Constant | Permission |
|---|---|---|
| `0x01` | `READ` | MAY fetch and decrypt commit payloads (subject to MemWal authorization) |
| `0x02` | `WRITE` | MAY call `commit` on permitted branches |
| `0x04` | `FORK` | MAY call `branch` to create new branches |
| `0x08` | `MERGE` | MAY call `finalize_merge` on a proposal |
| `0x10` | `PROPOSE` | MAY call `propose_merge` |
| `0x20`–`0x80` | Reserved | Reserved for future use; MUST be zero |

Implementations MUST reject `DelegateCap` instances with reserved bits set.

### 3.2 Branch scoping

`DelegateCap.allowed_branches` is a `vector<String>`. An empty vector indicates **all branches**. A non-empty vector restricts WRITE / FORK / MERGE / PROPOSE operations to listed branch names. READ is not branch-scoped at the MemForks layer; per-branch read isolation is the responsibility of the SEAL access policy attached to each commit's payload (see §3.4).

### 3.3 Revocation

`revoke_delegate` flips `DelegateCap.revoked = true`. All entry functions that consult a `DelegateCap` MUST abort if `revoked == true` or if `current_epoch > expires_epoch`. Revocation is one-way; reissuance requires a new `DelegateCap`.

### 3.4 SEAL policy binding

Each commit payload SHOULD be encrypted under a SEAL policy. The reference policy is "decryption authorized iff caller is the owner OR a registered delegate of the Tree's `memwal_account_id`" — i.e., the policy provided by `memwal::account::seal_approve`. Implementations targeting per-branch crypto isolation MAY mint custom SEAL policies referencing `BranchACL` state; such implementations MUST document the policy and remain compatible with the standard MemWal recall flow for commits not using a custom policy.

---

## 4. On-chain data model

All structures defined in this section live in the `memforks` Move package. Field types follow Move conventions.

### 4.1 `memforks::tree::MemoryTree`

```move
struct MemoryTree has key {
    id: UID,
    owner: address,
    memwal_account: ID,                  // referenced MemWalAccount
    branches: Table<String, vector<u8>>, // branch name -> head Walrus blob ID
    default_branch: String,
    delegates: Table<address, DelegateCap>,
    commit_count: u64,
    created_at_ms: u64,
}
```

Invariants:

- `branches` MUST contain an entry for `default_branch` after `init_tree` completes.
- For `default_branch` immediately after `init_tree`, the head value is the genesis `MemoryCommit` object ID encoded as a `vector<u8>` (32 bytes). After the first off-chain commit, the head is a Walrus blob ID. Implementations MUST treat the genesis head as a sentinel; callers SHOULD check for an empty-payload genesis head before attempting blob recall.
- At every merge, the head advances to the Walrus blob ID of the merge-anchor commit's payload.
- `commit_count` is monotonically non-decreasing; implementations MAY use it as a stable ordering key for indexing.
- `owner` is the only address authorized to call `grant_delegate`, `revoke_delegate`, `set_branch_authority`, and (future) `transfer_ownership`.

### 4.2 `memforks::tree::MemoryCommit`

```move
struct MemoryCommit has key, store {
    id: UID,
    tree_id: ID,
    parents: vector<vector<u8>>,         // parent Walrus blob IDs (length >= 2 = merge)
    memwal_namespace: String,
    memwal_blob_id: vector<u8>,          // this commit's Walrus blob ID
    author: address,
    author_branch: String,
    message: String,
    merge_resolver: Option<ID>,          // ResolverRef ID; always set on merge commits
    attestations: vector<Attestation>,
    epoch: u64,
    ts_ms: u64,
}
```

> **Model A:** `MemoryCommit` is minted **only for merge anchors and the genesis commit**. Regular (non-merge) agent commits are off-chain Walrus blobs in the hash-chained DAG defined in §8. They do not produce on-chain objects and do not fire `CommitCreated` events. The on-chain `MemoryTree` holds only the last *settled* branch head (the winning merge blob ID); the live branch tip advances off-chain between merges.

Invariants:

- The genesis commit of a Tree (minted by `init_tree`) MUST have `parents = []` and `memwal_blob_id = []` (empty payload).
- Merge commits MUST have `parents.length() >= 2` and `merge_resolver.is_some()`.
- `parents[i]` are Walrus blob IDs of the two branch heads consumed by the merge (`from_head` and `into_head` in the `MergeProposal`). They are NOT on-chain object IDs.
- `memwal_namespace` MUST match the namespace registered for `author_branch` in the corresponding `BranchACL`.
- `author` MUST hold an active `DelegateCap` on `tree_id` granting `MERGE` on `author_branch` at finalization time.
- Once minted, a `MemoryCommit` is immutable. The `attestations` vector is frozen when the proposal is finalized.

### 4.3 `memforks::tree::DelegateCap`

```move
struct DelegateCap has store {
    agent: address,
    allowed_branches: vector<String>,    // [] = all branches
    permissions: u8,
    expires_epoch: u64,
    revoked: bool,
}
```

Invariants:

- `permissions & 0xE0 == 0` (reserved bits zero).
- `expires_epoch > 0`. A grant intending no expiry MUST use `u64::MAX`.
- A delegate with `MERGE` but not `PROPOSE` MAY finalize merges proposed by others but cannot propose new ones; this is a valid configuration.

### 4.4 `memforks::tree::Attestation`

```move
struct Attestation has store, copy, drop {
    signer: address,
    kind: u8,
    payload: vector<u8>,                 // kind-specific
}
```

Defined kinds:

| Kind | Name | Payload semantics |
|---|---|---|
| `0x01` | `JURY_VOTE` | `signer` is a juror; payload is the signed CID of the proposed `resolved_blob_id` |
| `0x02` | `EVALUATOR_VERDICT` | `signer` is an evaluator address; payload is a verdict code + optional reason CID |
| `0x03` | `ORACLE_REPORT` | Generic oracle attestation; payload is application-defined |
| `0x04` | `LLM_RESOLVE` | Attestation that an LLM reconcile was performed with stated parameters (see §6.3 wire format) |
| `0x05`–`0x7F` | Reserved | For future protocol use |
| `0x80`–`0xFF` | Application | Free for application use |

Implementations MUST reject reserved-range kinds they do not recognize when validating attestations against a resolver policy.

### 4.5 `memforks::acl::BranchACL`

```move
struct BranchACL has key {
    id: UID,
    tree_id: ID,
    branch: String,
    memwal_namespace: String,
    merge_authority: Option<ID>,         // ResolverRef gating merges INTO this branch
}
```

Invariants:

- Exactly one `BranchACL` per `(tree_id, branch)` pair.
- `memwal_namespace` MUST be unique per `(tree_id, branch)`. The RECOMMENDED format is `memforks/<tree_id_hex>/<branch>`.
- If `merge_authority` is `Some(resolver_id)`, then any merge proposal whose `into_branch` is this branch MUST attach a resolver whose semantics are at least as strict as the referenced resolver. Implementations MAY enforce this strictly (require exact resolver match) or loosely (require structural compatibility); strict enforcement is RECOMMENDED for v1.

### 4.6 `memforks::resolver::ResolverRef`

```move
struct ResolverRef has key, store {
    id: UID,
    kind: u8,
    config: vector<u8>,                  // BCS-encoded, kind-specific (see §6)
}
```

Defined kinds:

| Kind | Name |
|---|---|
| `0x00` | `LAST_WRITE_WINS` |
| `0x01` | `UNION` |
| `0x02` | `LLM_RECONCILE` |
| `0x03` | `JURY_RECONCILE` |
| `0x04` | `EVALUATOR_PICK` |
| `0x05` | `AND` |
| `0x06` | `SEQUENCE` |
| `0x07`–`0x7F` | Reserved |
| `0x80`–`0xFF` | Application |

Resolver semantics and `config` schemas are defined in §6.

### 4.7 `memforks::resolver::MergeProposal`

```move
struct MergeProposal has key {
    id: UID,
    tree_id: ID,
    from_branch: String,
    into_branch: String,
    from_head: vector<u8>,               // Walrus blob ID of from_branch tip at proposal time
    into_head: vector<u8>,               // Walrus blob ID of into_branch tip at proposal time
    resolver: ID,
    proposed_by: address,
    proposed_at_ms: u64,
    expires_at_ms: u64,
    status: u8,
    resolved_memwal_namespace: Option<String>,
    resolved_memwal_blob_id: Option<vector<u8>>,
    attestations: vector<Attestation>,
}
```

`status` values:

| Value | Name | Meaning |
|---|---|---|
| `0` | `PENDING` | Open; attestations may be submitted |
| `1` | `FINALIZED` | A merge commit has been minted; resolved payload is bound |
| `2` | `ABORTED` | Voluntarily cancelled by proposer or branch authority |
| `3` | `EXPIRED` | `ts_ms_now > expires_at_ms`; no merge commit minted |

State machine: see §7.

---

## 5. Entry functions

All entry functions live in the `memforks::tree` and `memforks::resolver` modules. The following table is normative for function signatures and authorization; argument names are conventional.

| Function | Caller | Aborts if |
|---|---|---|
| `init_tree(memwal_account_id, default_branch, clock, ctx)` → `MemoryTree` | any | `default_branch` is empty. Also mints the genesis `MemoryCommit` (`parents = []`, `memwal_blob_id = []`) and sets `branches[default_branch] = genesis_blob_sentinel`. `clock` is the Sui shared `Clock` object (`0x6`); its `timestamp_ms()` is written to `created_at_ms` and `ts_ms`. |
| `grant_delegate(tree, agent, branches, perms, expires_epoch, ctx)` | `tree.owner` | caller is not owner; reserved bits set in `perms`; `expires_epoch <= current_epoch` |
| `revoke_delegate(tree, agent, ctx)` | `tree.owner` | caller is not owner; no `DelegateCap` for `agent` exists |
| `set_branch_authority(tree, branch, resolver_id, ctx)` | `tree.owner` | branch does not exist; resolver not found |
| `branch(tree, from_branch, new_branch, ctx)` | delegate with `FORK` on `from_branch` | branch already exists; `from_branch` does not exist |
| `propose_merge(tree, from_branch, into_branch, from_head_blob_id, into_head_blob_id, resolver, ttl_ms, clock, ctx)` → `MergeProposal` | delegate with `PROPOSE` on `from_branch` | either branch does not exist; resolver not found; resolver incompatible with `into_branch`'s `merge_authority`. `from_head_blob_id` and `into_head_blob_id` are the caller-supplied live branch tips (Walrus blob IDs); they are stored in the proposal and used for the fast-forward conflict check at finalization. `proposed_at_ms = clock.timestamp_ms()`, `expires_at_ms = proposed_at_ms + ttl_ms`. |
| `submit_attestation(proposal, resolver, attest_kind, attest_payload, pubkey, sig, ctx)` | any (validity depends on resolver kind) | `proposal.status != PENDING`; attestation kind incompatible with resolver; `sig` is not a valid Ed25519 signature over `attest_payload` by `pubkey`; `pubkey` does not derive to `ctx.sender()`. |
| `finalize_merge(tree, proposal, resolver, resolved_namespace, resolved_blob_id, clock, ctx)` → `MemoryCommit` | delegate with `MERGE` on `proposal.into_branch` | `proposal.status != PENDING`; resolver verdict not `APPROVE` (see §6); `into_head_blob_id` supplied at `propose_merge` differs from the current on-chain branch head (fast-forward conflict — see §5.1). `clock` supplies `ts_ms` for the merge commit. |
| `abort_merge(tree, proposal, ctx)` | `proposal.proposed_by` OR owner | `proposal.status != PENDING` |
| `claim_expired(proposal, clock, ctx)` | any | `clock.timestamp_ms() <= proposal.expires_at_ms`; `proposal.status != PENDING` |

> **Off-chain commit flow (not an entry function).** Regular agent commits are performed entirely off-chain via the SDK. The SDK calls `memwal.remember(payload)` with the structured commit blob defined in §8, which the MemWal relayer persists to Walrus. No Sui transaction is issued. The branch head advances locally (tracked by the SDK / indexer); it is only updated on-chain when a merge is finalized.

### 5.1 Fast-forward conflict on `finalize_merge`

Under Model A the on-chain branch head is a Walrus blob ID (`vector<u8>`) that only advances at merge time. The fast-forward check compares `proposal.into_head_blob_id` (the blob ID supplied at `propose_merge`) against the current on-chain head. If they differ — meaning another merge landed on `into_branch` after this proposal was opened — the entry function MUST abort. The proposer (or any delegate with `PROPOSE`) MAY then open a new proposal anchored to the updated head, or rebase the proposed resolution against the new head and re-propose. This specification does not define automatic rebase semantics; implementations MAY add them as a non-normative convenience.

---

## 6. Resolver semantics

Each resolver kind defines (a) the `config` payload schema, (b) the attestation kinds it consumes, and (c) the verdict predicate it computes.

**Encoding split:**

| Field | Encoding | Reason |
|---|---|---|
| `ResolverRef.config` | **BCS** ([Binary Canonical Serialization](https://github.com/diem/bcs)) | Parsed on-chain by Move using `sui::bcs`. BCS has no type-tag overhead and is ~20–40% cheaper to decode than CBOR. |
| Attestation `payload` | **CBOR** ([RFC 8949](https://www.rfc-editor.org/rfc/rfc8949.html)) deterministic | Stored opaque on-chain (never parsed by Move). CBOR is used for off-chain interoperability and off-chain signature binding. |

Implementations MUST use deterministic CBOR (lexicographic key ordering, definite-length items) for any attestation `payload` that participates in a signature.

A resolver's `verdict()` returns one of `APPROVE`, `REJECT(code)`, or `PENDING`. `finalize_merge` succeeds only if the resolver returns `APPROVE`.

### 6.1 `LAST_WRITE_WINS` (kind `0x00`)

- `config`: empty (`null` / zero-length).
- Attestations consumed: none.
- Verdict: always `APPROVE`.
- Resolver runtime behavior: produce a `resolved_memwal_blob_id` equal to the `from_head` commit's payload. The target branch's prior state is discarded (its history remains, only the head pointer advances).

### 6.2 `UNION` (kind `0x01`)

- `config`: empty.
- Attestations consumed: none.
- Verdict: always `APPROVE`.
- Resolver runtime behavior: produce a `resolved_memwal_blob_id` whose payload is the union of both branch heads' payloads (semantics application-defined; reference implementation concatenates memory entries).

### 6.3 `LLM_RECONCILE` (kind `0x02`)

`config` (BCS-encoded struct):

| Field | BCS type | Required | Meaning |
|---|---|---|---|
| `runner` | `Option<address>` | no | Signing address of the authorized runner. `None` = any address may submit `LLM_RESOLVE`. |

Additional metadata (`model`, `prompt_cid`, `temperature`, `seed`) is stored off-chain in the attestation `payload` (CBOR) and is not verified on-chain.

Attestations consumed: exactly one `LLM_RESOLVE` (kind `0x04`) whose `signer` matches `config.runner` (if set).

`LLM_RESOLVE` attestation `payload` (CBOR map):

| Key | Type | Required | Meaning |
|---|---|---|---|
| `proposal_id` | bytes | yes | The proposal this resolution applies to |
| `resolved_blob_id` | bytes | yes | The payload produced by the LLM |
| `resolved_namespace` | text | yes | MemWal namespace holding the resolved payload |
| `params_hash` | bytes | yes | SHA-256 over CBOR-encoded `{model, prompt_cid, temperature, seed}` |
| `model_response_hash` | bytes | yes | SHA-256 over the raw LLM response |
| `pubkey` | bytes | yes | Ed25519 public key (32 bytes) of the signer |
| `signature` | bytes | yes | Ed25519 signature by `pubkey` over the deterministic CBOR encoding of all other fields in this table |

Validation (enforced on-chain in `submit_attestation`): `ed25519_verify(sig_arg, pubkey_arg, attest_payload)` MUST pass, and `BLAKE2b-256(0x00 || pubkey_arg) == ctx.sender()`. The `signature` field inside the CBOR payload is an additional off-chain audit trail and is not re-verified on-chain.

Verdict: `APPROVE` iff exactly one valid `LLM_RESOLVE` is present and `params_hash` matches the resolver `config`. Otherwise `PENDING` (no attestation) or `REJECT(0x02)` (mismatch).

> Note: this resolver is **not** verifiable in the cryptographic sense — anyone with `runner`'s key could produce any payload. It is *auditable*: the model, prompt, and parameters are bound on-chain, so post-hoc inspection is trivial. For stronger guarantees, compose `LLM_RECONCILE` with `JURY_RECONCILE` via a `SEQUENCE`.

### 6.4 `JURY_RECONCILE` (kind `0x03`)

`config` (BCS-encoded struct):

| Field | BCS type | Required | Meaning |
|---|---|---|---|
| `judges` | `vector<address>` | yes | Set of authorized juror addresses |
| `k` | `u8` | yes | Required votes for approval |
| `n` | `u8` | yes | Total jurors; MUST equal `judges.length()` |

Attestations consumed: `JURY_VOTE` (kind `0x01`) attestations.

`JURY_VOTE` attestation `payload` (CBOR map):

| Key | Type | Required | Meaning |
|---|---|---|---|
| `proposal_id` | bytes | yes | Binds the vote to a specific proposal |
| `resolved_namespace` | text | yes | MemWal namespace of the proposed resolution |
| `resolved_blob_id` | bytes | yes | The candidate resolved payload being voted on |
| `pubkey` | bytes | yes | Ed25519 public key (32 bytes) of the juror |
| `signature` | bytes | yes | Ed25519 signature by `pubkey` over the deterministic CBOR encoding of `{proposal_id, resolved_namespace, resolved_blob_id}` |

Validation (enforced on-chain in `submit_attestation`):

1. `ed25519_verify(sig, pubkey, attest_payload)` MUST pass — signature covers the exact payload bytes.
2. `BLAKE2b-256(0x00 || pubkey) == ctx.sender()` — the `pubkey` must derive to the Sui address of the transaction signer (Ed25519 scheme flag `0x00`).
3. `ctx.sender()` ∈ `config.judges` — the signer must be an authorized juror.

Verdict: `APPROVE` iff at least `k` distinct `JURY_VOTE` attestations from addresses in `judges` are present. Otherwise `PENDING`.

### 6.5 `EVALUATOR_PICK` (kind `0x04`)

`config` (BCS-encoded struct):

| Field | BCS type | Required | Meaning |
|---|---|---|---|
| `criterion_evaluator` | `address` | yes | Sui object ID of an external evaluator policy object |
| `expected_kind` | `u8` | yes | Expected attestation kind (`0x02` for `EVALUATOR_VERDICT`) |

Attestations consumed: one `EVALUATOR_VERDICT` whose `signer` matches the evaluator's authorized signer address, payload encoding which branch (`from` or `into`) the evaluator selected.

Verdict: `APPROVE` if a valid verdict is present; the selected branch's head becomes the `resolved_blob_id`.

### 6.6 `AND` (kind `0x05`)

`config` (BCS-encoded vector of child descriptors):

Each element is a pair `(kind: u8, config: vector<u8>)` — the child resolver's kind byte followed by its BCS-encoded config. Children are embedded by value rather than referenced by object ID; this avoids N additional on-chain object loads (~10 k gas each) at finalization time.

```
// BCS wire layout
varint(num_children)
  foreach child:
    u8 kind
    varint(len) + bytes config
```

Verdict: `APPROVE` iff every child resolver approves. `finalize_merge` evaluates all children against the accumulated attestation set.

### 6.7 `SEQUENCE` (kind `0x06`)

`config`: same BCS wire format as `AND`.

Verdict: child `i+1`'s attestations MUST NOT be considered until child `i` has returned `APPROVE`. Final verdict is `APPROVE` iff every child returns `APPROVE` in order. Any `REJECT` short-circuits to `REJECT`. Ordering is enforced **off-chain** by the resolver runtime; `finalize_merge` verifies only that all children approve at call time.

Use case: gate an expensive `LLM_RECONCILE` behind a cheap `JURY_RECONCILE` quality check.

### 6.8 Resolver composition limits

To bound on-chain verification cost, implementations MUST reject:

- Composed resolvers with depth > 4 (e.g., `AND(SEQUENCE(AND(... )))` four levels deep is the maximum).
- Composed resolvers referencing more than 16 distinct leaf resolvers in total.

These limits are RECOMMENDED for v0.1 and may be raised in future versions.

---

## 7. Merge proposal lifecycle

```
                       propose_merge
                            │
                            ▼
                       ┌──────────┐
       abort_merge ◄───┤ PENDING  ├───► claim_expired (after expiry)
                       └────┬─────┘
                            │ finalize_merge
                            │ (verdict == APPROVE)
                            ▼
                       ┌─────────────┐
                       │ FINALIZED   │
                       └─────────────┘

       abort_merge:   PENDING → ABORTED
       claim_expired: PENDING → EXPIRED   (only when ts_now > expires_at_ms)
```

Once a proposal leaves `PENDING`, no further `submit_attestation` calls are valid. The attestation vector is frozen for archival.

A `FINALIZED` proposal MUST have `resolved_memwal_namespace` and `resolved_memwal_blob_id` set to the values used in the corresponding merge `MemoryCommit`. Implementations MAY garbage-collect the proposal object after a configurable retention period; the merge commit itself is the canonical record.

---

## 8. Wire format — commit payload

Under Model A, **every agent commit is an off-chain Walrus blob**. Regular commits are not Sui transactions; they are `memwal.remember()` calls whose payload conforms to the schema below. The MemWal relayer encrypts the payload, stores it on Walrus, and indexes the embedding for semantic recall. Only merge anchors (and the genesis commit) produce on-chain `MemoryCommit` objects.

### 8.1 Schema

A commit payload MUST be a CBOR map with the following structure:

```
{
  "v":             1,                      // payload schema version
  "type":          "commit",               // always "commit" for regular commits
  "tree":          bytes,                  // tree object ID (32 bytes)
  "branch":        text,                   // author branch name
  "author":        bytes,                  // Sui address (32 bytes)
  "ts_ms":         uint,                   // Unix timestamp in milliseconds
  "parent_blob_ids":   [bytes, ...],       // Walrus blob IDs of parent commit(s)
  "parent_blob_hashes": [bytes, ...],      // SHA-256 of each parent blob's raw bytes
  "delta": {                               // memory delta
    "messages":    [ {...}, ... ],         // optional, framework-defined
    "facts":       [ text, ... ],          // optional
    "embeddings_hint": [ float, ... ],     // optional
    "files":       [ {path: text, blob: bytes}, ... ]  // optional
  },
  "extensions":    {...}                   // optional, namespaced application data
}
```

Implementations MUST tolerate unknown top-level keys (forward compatibility). Implementations MUST reject payloads with an unrecognized `v` major version.

### 8.2 The hash chain

`parent_blob_hashes[i]` MUST be `SHA-256(raw_bytes_of_parent_blob_i)` — the SHA-256 digest of the exact bytes of the parent Walrus blob (before decryption, over the raw stored bytes).

This forms a **content-addressed hash chain**: each blob cryptographically commits to its parents' content. Because the chain is transitive, anchoring a single branch-tip blob ID in a `MergeProposal` commits to the entire reasoning history behind it — without putting each commit on-chain.

Verifying the chain:

1. Fetch the tip blob (identified by its Walrus blob ID).
2. Compute `SHA-256(tip_blob_bytes)` — this is the tip hash.
3. The tip's `parent_blob_hashes[0]` must equal `SHA-256(parent_blob_bytes)`.
4. Recurse until `parent_blob_ids` is empty (genesis).

Any tampered blob breaks the chain at the point of tampering. The on-chain `MergeProposal.from_head` / `into_head` (the blob IDs stored at merge time) anchor both ends of the chain permanently on Sui.

### 8.3 Genesis sentinel

For the genesis commit (no parents), `parent_blob_ids = []` and `parent_blob_hashes = []`. The on-chain `MemoryTree.branches[default_branch]` is initialized to the genesis `MemoryCommit` object ID (not a Walrus blob ID). Implementations MUST detect this sentinel (a 32-byte object ID vs. a Walrus blob ID format) and handle it as the chain root.

### 8.4 Why duplicate `tree`/`branch`/`author` on the payload?

Two reasons: (a) the payload is what gets restored when an indexer rebuilds the DAG from Walrus alone without relying on Sui events; (b) it provides tamper-evident binding — the Walrus blob asserts its own provenance, and the on-chain `MergeProposal` references the blob ID, tying the two together.

---

## 9. Events

The Move package MUST emit the following events. Indexers SHOULD subscribe to these to maintain a queryable DAG view.

| Event | When emitted | Fields |
|---|---|---|
| `TreeCreated` | `init_tree` | `tree_id`, `owner`, `memwal_account`, `default_branch`, `ts_ms` |
| `DelegateGranted` | `grant_delegate` | `tree_id`, `agent`, `permissions`, `expires_epoch` |
| `DelegateRevoked` | `revoke_delegate` | `tree_id`, `agent` |
| `BranchCreated` | `branch` | `tree_id`, `branch`, `from_branch`, `memwal_namespace` |
| `MergeProposed` | `propose_merge` | `tree_id`, `proposal_id`, `from_branch`, `into_branch`, `from_head_blob_id`, `into_head_blob_id`, `resolver_id`, `expires_at_ms` |
| `AttestationSubmitted` | `submit_attestation` | `proposal_id`, `signer`, `kind` |
| `MergeFinalized` | `finalize_merge` | `tree_id`, `proposal_id`, `merge_commit_id`, `resolved_blob_id` |
| `MergeAborted` | `abort_merge` | `proposal_id`, `reason_code` |
| `MergeExpired` | `claim_expired` | `proposal_id` |

> **`CommitCreated` is removed.** Under Model A, regular commits are off-chain Walrus blobs and do not emit Sui events. Indexers reconstruct the commit DAG by subscribing to `BranchCreated` and `MergeFinalized` events, then walking the Walrus blob hash chain backwards from each merge anchor's `from_head_blob_id` and `into_head_blob_id` (see §8.2). This is the same reconstruction strategy used by Walrus-native DAG tools.

Event field names and types are normative; field ordering is implementation-defined.

---

## 10. Error codes

The Move package MUST use the following abort codes (lower bits) for the listed conditions. Implementations MAY extend the range above `0x1000` for application-specific errors.

| Code | Name | Condition |
|---|---|---|
| `0x0001` | `E_NOT_OWNER` | Operation requires `tree.owner` |
| `0x0002` | `E_NOT_DELEGATE` | Caller has no `DelegateCap` on this Tree |
| `0x0003` | `E_DELEGATE_REVOKED` | `DelegateCap.revoked == true` |
| `0x0004` | `E_DELEGATE_EXPIRED` | `current_epoch > expires_epoch` |
| `0x0005` | `E_MISSING_PERMISSION` | Required permission bit not set |
| `0x0006` | `E_BRANCH_NOT_FOUND` | Named branch does not exist |
| `0x0007` | `E_BRANCH_EXISTS` | Branch name collision on `branch()` |
| `0x0008` | `E_BRANCH_OUT_OF_SCOPE` | Branch not in `allowed_branches` |
| `0x0009` | `E_INVALID_PARENTS` | Parent list violates §4.2 invariants |
| `0x000A` | `E_RESERVED_BITS_SET` | `permissions` includes reserved bits |
| `0x0010` | `E_PROPOSAL_NOT_PENDING` | Proposal is not in `PENDING` state |
| `0x0011` | `E_PROPOSAL_NOT_EXPIRED` | `claim_expired` called before expiry |
| `0x0012` | `E_FAST_FORWARD_CONFLICT` | `into_head` advanced since proposal |
| `0x0013` | `E_RESOLVER_REJECT` | Resolver returned `REJECT` |
| `0x0014` | `E_RESOLVER_PENDING` | Resolver returned `PENDING` at finalize time |
| `0x0015` | `E_RESOLVER_INCOMPATIBLE` | Proposed resolver violates `merge_authority` |
| `0x0016` | `E_ATTESTATION_INVALID` | Signature, kind, or content fails validation |
| `0x0017` | `E_COMPOSITION_LIMIT` | Resolver depth or leaf count exceeded |
| `0x0020` | `E_PAYLOAD_VERSION_UNKNOWN` | Payload `v` is not supported |

---

## 11. Conformance

A MemForks-compliant implementation MUST:

1. Deploy a Move package exposing the structures and entry functions defined in §4 and §5 with byte-identical event names and abort codes.
2. Implement at least the following resolver kinds: `LAST_WRITE_WINS`, `UNION`, `JURY_RECONCILE`. (Other kinds are RECOMMENDED but OPTIONAL for v0.1 conformance.)
3. Accept commit payloads conforming to §8 with `v == 1`.
4. Validate attestation signatures per §6.
5. Emit events per §9.
6. Pass the conformance test suite published alongside the reference implementation. The v0.1.1 conformance suite is bundled with the v0.1.1 reference Move package release; implementations targeting v0.1.1 conformance MUST pass the suite at the corresponding tag.

A compliant implementation SHOULD:

7. Implement `LLM_RECONCILE`, `EVALUATOR_PICK`, `AND`, `SEQUENCE`.
8. Provide an indexer producing a queryable DAG view from §9 events.
9. Use the MemWal account model (`memforks::tree::MemoryTree.memwal_account`) and rely on `memwal::account::seal_approve` as the default SEAL policy.

A compliant implementation MAY:

10. Define application-specific resolver kinds in the `0x80`–`0xFF` range.
11. Mint custom SEAL policies (e.g., per-branch crypto isolation) provided fallback compatibility with the standard policy is preserved.
12. Provide ergonomic extensions (CLI, framework adapters, hosted relayer) without compromising the on-chain interface.

---

## 12. Versioning

This specification uses semantic versioning at the protocol level:

- **Major** version increments indicate breaking on-chain or wire-format changes.
- **Minor** version increments add new resolver kinds, attestation kinds, event fields, or extension points in a backward-compatible way.
- **Patch** versions are editorial.

The Move package MUST expose a constant `SPEC_VERSION` as `(u8, u8, u8)` reflecting the implemented spec version. Indexers and clients SHOULD reject Trees whose `SPEC_VERSION.major` does not match the spec major they implement.

The reference implementation currently returns `spec_version() == (0, 1, 1)` via `memforks::tree::spec_version()`. Clients targeting this release MUST accept `(0, 1, 1)`.

The on-chain payload schema (§8) carries its own version field `v`. Major version increments to §8 are coordinated with protocol major increments.

---

## 13. Security considerations

### 13.1 Trust placed in the resolver runtime

`LLM_RECONCILE` requires trust in the runner's address. Composing with `JURY_RECONCILE` (e.g., `SEQUENCE([JURY, LLM])` or `AND([JURY, LLM])`) materially reduces this trust by requiring independent attestations of resolution quality. Deployments handling material value SHOULD compose resolvers rather than rely on bare `LLM_RECONCILE`.

### 13.2 Replay across Trees

Attestation payloads MUST include the proposal ID (and thereby the Tree ID transitively). Jurors signing a `JURY_VOTE` for proposal A cannot have that signature replayed against proposal B.

### 13.3 Front-running merge finalization

A delegate with `MERGE` who observes a pending proposal could attempt to finalize concurrently with another `MERGE` holder. The Move package processes finalization serially; only one transaction can succeed against a given proposal. Implementations SHOULD surface clear errors to second-place callers (the proposal will be in `FINALIZED` state).

### 13.4 Revocation latency

`revoke_delegate` is effective immediately on-chain, but agents may have in-flight signed requests to the MemWal relayer that complete after revocation. Owners SHOULD also revoke the agent's MemWal delegate key (via the MemWal SDK) to fully cut off payload access.

### 13.5 SEAL key rotation

This specification does not define a SEAL key rotation protocol; rotation follows MemWal's. Implementations relying on custom SEAL policies (§3.4) MUST document their rotation story.

### 13.6 Cross-org confidentiality

The default SEAL policy authorizes all delegates of the underlying `MemWalAccount` to decrypt any commit's payload. Per-branch read isolation requires either (a) one MemWal account per branch, or (b) custom SEAL policies referencing `BranchACL` membership. See `PRD.md §13` for tradeoffs.

### 13.7 Sponsored transactions

Sui's native sponsored-transaction model allows a third-party sponsor to pay gas while `tx.sender` (and therefore all on-chain ownership, authorship, and capability checks) remains the user's address. The MemForks protocol is fully compatible with this pattern: all entry-function authorization relies on `ctx.sender()`, which is the user's address regardless of who provides the gas coin.

Implementers offering gas sponsorship MUST:
- Validate the unsigned transaction against a policy (allowlist of `package::module::function` targets, per-address rate limits) before co-signing.
- Never grant sponsors the ability to mutate transaction inputs — only gas payment objects are contributed by the sponsor.
- Document that sponsorship is an off-chain service and its availability does not affect the protocol's trust model.

---

## 14. Reference implementation

The canonical reference implementation lives at `github.com/memforks-dev/memforks`:

| Component | Path | npm / package |
|---|---|---|
| Move contracts | `contracts/` | deployed on Sui mainnet |
| TypeScript core SDK | `packages/core/` | `@memfork/core` |
| CLI + DAG visualizer | `packages/cli/` | `@memfork/cli` |
| Vercel AI adapter | `packages/vercel-ai/` | `@memfork/vercel-ai` |
| LangGraph adapter | `packages/langgraph/` | `@memfork/langgraph` |
| Resolver service | `services/resolver/` | self-hosted daemon |
| Reference chat app | `apps/memforks-chat/` | — |
| DAG visualizer app | `apps/visualizer/` | bundled with CLI |

A conformance indexer is planned; its interface is defined in §9 (event set) and §8.2 (hash-chain walk). Implementations MAY build their own indexer against these normative sections.

The reference implementation is the source of truth where this specification is ambiguous. Discrepancies SHOULD be reported as spec issues at `github.com/memforks-dev/memforks/issues`.

---

## 15. Acknowledgments

This specification draws inspiration from:

- **ERC-8183 (Agentic Commerce)** — the evaluator-as-contract pattern that informs our resolver model.
- **A402 (Binding Cryptocurrency Payments to Service Execution)** — the atomic execution↔settlement design that informs our merge-proposal lifecycle.
- **Git** — the commit DAG and merge model.
- **MemWal** — the underlying memory layer this specification extends.

---

## Appendix A — Example: parallel research merge

A non-normative example showing a proposal using `SEQUENCE([JURY(2,3), LLM_RECONCILE])`:

```
1. Proposer calls propose_merge(
     from = "hypothesis-perf",
     into = "main",
     resolver = sequence_resolver_id,
     ttl_ms = 10 * 60_000
   )
2. Three jurors evaluate the from-branch quality. Each calls
   submit_attestation(proposal, JURY_VOTE{ signer, payload: sig(blob_id) })
3. Once 2 of 3 jurors have signed the same provisional resolved_blob_id, the
   SEQUENCE's first child returns APPROVE; the runtime now invokes the LLM.
4. The runner runs the reconciliation, then calls
   submit_attestation(proposal, LLM_RESOLVE{ signer = runner, payload = ... })
5. SEQUENCE's second child verifies the LLM_RESOLVE; if valid, overall verdict
   is APPROVE.
6. Any delegate with MERGE on "main" calls
   finalize_merge(proposal, resolved_namespace, resolved_blob_id)
   which mints a merge MemoryCommit with parents = [from_head, into_head]
   and advances main's head.
```

---

## Appendix B — Encoding requirements

### B.1 BCS (`ResolverRef.config`)

`ResolverRef.config` uses [Binary Canonical Serialization (BCS)](https://github.com/diem/bcs). BCS is the native encoding of the Sui/Move runtime; it is parsed on-chain using `sui::bcs`.

Properties relevant to this spec:

- Integers are little-endian fixed-width (`u8`, `u64`, etc.).
- `vector<T>` is length-prefixed with an unsigned LEB-128 varint followed by encoded elements.
- `Option<T>` is encoded as `0x00` (None) or `0x01 || T` (Some).
- `address` is 32 bytes, big-endian.
- BCS has no self-describing type tags; the schema must be known in advance.

TypeScript callers MUST use `@mysten/sui/bcs` to construct `config` bytes. Move reads them with `sui::bcs::new` + `bcs::peel_*` helpers.

### B.2 Deterministic CBOR (attestation `payload`)

Attestation `payload` fields (e.g., `JURY_VOTE`, `LLM_RESOLVE`) use Deterministic CBOR per RFC 8949 §4.2.1. These bytes are stored opaque on-chain and never decoded by Move. Deterministic encoding is required because:

- Jury and LLM attestation payloads bind values via off-chain Ed25519 signatures.
- The Move `submit_attestation` call signs the raw `payload` bytes (the `sig` argument covers `attest_payload` directly).

Requirements:

- Map keys MUST be sorted lexicographically as byte strings.
- Definite-length encoding MUST be used for arrays and maps.
- Integers MUST use the shortest form.
- Floats MUST use the shortest preserving-precision form (`float16` < `float32` < `float64`).
- No NaN, no `-0.0`.

Signature verification (on-chain via `ed25519_verify`) is performed against the `attest_payload` bytes as provided; callers MUST ensure these bytes are already in deterministic form before signing.
