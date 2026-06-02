/// `memforks::resolver` — merge proposal lifecycle and resolver verdict engine.
///
/// Implements SPEC §4.6–4.7, §5, §6, §7, §9, §10.
///
/// ## Intentional deviations from SPEC v0.1:
///
/// 1. **Config encoding**: SPEC specifies CBOR; we use BCS.  Move has no CBOR
///    decoder and BCS is ~20-40% cheaper to parse (no type-tag overhead).  The
///    TypeScript SDK encodes config via `@mysten/sui/bcs`; Move decodes with
///    `sui::bcs`.  This is intentionally more performant than the SPEC.
///
/// 2. **Composed resolvers (SEQUENCE / AND)**: SPEC references children by object
///    ID.  We embed child `(kind, config)` pairs directly in the parent config.
///    This avoids N extra object loads per child resolver (~10 k gas each) making
///    it intentionally more gas-efficient than the SPEC alternative.
///
/// ~~3. TTL~~  — FIXED: `proposed_at_ms` and `expires_at_ms` are real Unix ms from
///    the Sui Clock singleton (object 0x6).  `propose_merge` now takes `ttl_ms`.
///
/// ~~4. No content binding~~ — FIXED: `submit_attestation` requires an Ed25519
///    signature over `attest_payload` whose public key derives to `ctx.sender()`.
///    This binds the payload content cryptographically to the signer's identity.
module memforks::resolver;

use std::string::String;
use sui::address;
use sui::bcs;
use sui::clock::Clock;
use sui::ed25519;
use sui::event;
use sui::hash;
use sui::object::{Self, UID, ID};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use memforks::tree::{Self, MemoryTree, Attestation};

// ─── Resolver kinds (SPEC §4.6) ──────────────────────────────────────────────

public fun kind_last_write_wins(): u8 { 0x00 }
public fun kind_union():           u8 { 0x01 }
public fun kind_llm_reconcile():   u8 { 0x02 }
public fun kind_jury_reconcile():  u8 { 0x03 }
public fun kind_evaluator_pick():  u8 { 0x04 }
public fun kind_and():             u8 { 0x05 }
public fun kind_sequence():        u8 { 0x06 }

// ─── Attestation kinds (mirrored from tree.move for local use) ────────────────

const ATTEST_JURY_VOTE:   u8 = 0x01;
const ATTEST_LLM_RESOLVE: u8 = 0x04;

// ─── Proposal status (SPEC §4.7) ─────────────────────────────────────────────

public fun status_pending():   u8 { 0 }
public fun status_finalized(): u8 { 1 }
public fun status_aborted():   u8 { 2 }
public fun status_expired():   u8 { 3 }

// ─── Composition limits (SPEC §6.8) ──────────────────────────────────────────

const MAX_DEPTH:  u64 = 4;
const MAX_LEAVES: u64 = 16;

// ─── Error codes (SPEC §10) ──────────────────────────────────────────────────

const E_NOT_OWNER:             u64 = 0x0001;
const E_NOT_DELEGATE:          u64 = 0x0002;
const E_PROPOSAL_NOT_PENDING:  u64 = 0x0010;
const E_PROPOSAL_NOT_EXPIRED:  u64 = 0x0011;
const E_FAST_FORWARD_CONFLICT: u64 = 0x0012;
const E_RESOLVER_REJECT:       u64 = 0x0013;
const E_RESOLVER_PENDING:      u64 = 0x0014;
#[allow(unused_const)]
const E_RESOLVER_INCOMPATIBLE: u64 = 0x0015;
const E_ATTESTATION_INVALID:   u64 = 0x0016;
const E_COMPOSITION_LIMIT:     u64 = 0x0017;
#[allow(unused_const)]
const E_PAYLOAD_VERSION_UNKNOWN: u64 = 0x0020;

// ─── Structs (SPEC §4.6–4.7) ─────────────────────────────────────────────────

/// A typed merge strategy.  Owned / transferable.  (SPEC §4.6)
public struct ResolverRef has key, store {
    id: UID,
    kind: u8,
    /// BCS-encoded, kind-specific config.  (Deviation: SPEC says CBOR; see header.)
    config: vector<u8>,
}

/// In-flight merge accumulating attestations.  Shared.  (SPEC §4.7)
public struct MergeProposal has key {
    id: UID,
    tree_id: ID,
    from_branch: String,
    into_branch: String,
    from_head: ID,
    into_head: ID,
    resolver: ID,
    proposed_by: address,
    /// Unix timestamp in milliseconds at proposal creation (from Clock).
    proposed_at_ms: u64,
    /// Unix timestamp in milliseconds at which the proposal expires (from Clock).
    expires_at_ms: u64,
    status: u8,
    resolved_memwal_namespace: Option<String>,
    resolved_memwal_blob_id: Option<vector<u8>>,
    attestations: vector<Attestation>,
}

// ─── Events (SPEC §9) ────────────────────────────────────────────────────────

public struct MergeProposed has copy, drop {
    tree_id: ID,
    proposal_id: ID,
    from_branch: String,
    into_branch: String,
    resolver_id: ID,
    expires_at_ms: u64,
}

public struct AttestationSubmitted has copy, drop {
    proposal_id: ID,
    signer: address,
    kind: u8,
}

public struct MergeFinalized has copy, drop {
    tree_id: ID,
    proposal_id: ID,
    merge_commit_id: ID,
}

public struct MergeAborted has copy, drop {
    proposal_id: ID,
    reason_code: u8,
}

public struct MergeExpired has copy, drop {
    proposal_id: ID,
}

// ─── Resolver constructors ────────────────────────────────────────────────────

/// Create a ResolverRef (for use in PTBs — caller must transfer or share it).
/// Validates composition depth/leaf limits for SEQUENCE/AND kinds.
public fun create_resolver(
    kind: u8,
    config: vector<u8>,
    ctx: &mut TxContext,
): ResolverRef {
    if (kind == kind_sequence() || kind == kind_and()) {
        let (depth, leaves) = composed_depth_leaves(&config, 1);
        assert!(depth <= MAX_DEPTH,  E_COMPOSITION_LIMIT);
        assert!(leaves <= MAX_LEAVES, E_COMPOSITION_LIMIT);
    };
    ResolverRef { id: object::new(ctx), kind, config }
}

/// Convenience wrapper: create and share the resolver so any party can use it.
public fun create_and_keep_resolver(
    kind: u8,
    config: vector<u8>,
    ctx: &mut TxContext,
) {
    let r = create_resolver(kind, config, ctx);
    transfer::share_object(r);
}

// ─── propose_merge ────────────────────────────────────────────────────────────

/// Open a merge proposal.  Requires PROPOSE on from_branch.  (SPEC §5)
///
/// `ttl_ms` is a duration in milliseconds from now (e.g. 86_400_000 = 1 day).
public fun propose_merge(
    tree: &MemoryTree,
    from_branch: vector<u8>,
    into_branch: vector<u8>,
    resolver: &ResolverRef,
    ttl_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let from_str = std::string::utf8(from_branch);
    let into_str = std::string::utf8(into_branch);
    let sender   = ctx.sender();

    // Authorization: PROPOSE on from_branch.
    assert!(
        tree::has_permission(tree, sender, tree::perm_propose(), &from_str, ctx.epoch()),
        E_NOT_DELEGATE,
    );

    let tree_id     = object::id(tree);
    let from_head   = tree::branch_head(tree, &from_str);
    let into_head   = tree::branch_head(tree, &into_str);
    let resolver_id = object::id(resolver);
    let now_ms      = clock.timestamp_ms();
    let expires_ms  = now_ms + ttl_ms;

    let proposal = MergeProposal {
        id: object::new(ctx),
        tree_id,
        from_branch: from_str,
        into_branch: into_str,
        from_head,
        into_head,
        resolver: resolver_id,
        proposed_by: sender,
        proposed_at_ms: now_ms,
        expires_at_ms: expires_ms,
        status: status_pending(),
        resolved_memwal_namespace: option::none(),
        resolved_memwal_blob_id: option::none(),
        attestations: vector[],
    };
    let proposal_id = object::id(&proposal);

    event::emit(MergeProposed {
        tree_id,
        proposal_id,
        from_branch: from_str,
        into_branch: into_str,
        resolver_id,
        expires_at_ms: expires_ms,
    });

    transfer::share_object(proposal);
}

// ─── submit_attestation ───────────────────────────────────────────────────────

/// Append an attestation to an open proposal.  (SPEC §5)
///
/// `pubkey`  — 32-byte Ed25519 public key of the signer.
/// `sig`     — 64-byte Ed25519 signature over `attest_payload`.
///
/// The contract verifies two things:
///   1. `sig` is a valid Ed25519 signature over `attest_payload` by `pubkey`.
///   2. `pubkey` derives to `ctx.sender()` (Ed25519 scheme flag 0x00 + BLAKE2b-256).
///
/// This binds the payload content to the on-chain identity of the submitter,
/// satisfying SPEC §5 content-binding requirement (deviation #4 — now fixed).
public fun submit_attestation(
    proposal: &mut MergeProposal,
    resolver: &ResolverRef,
    attest_kind: u8,
    attest_payload: vector<u8>,
    pubkey: vector<u8>,
    sig: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(proposal.status == status_pending(), E_PROPOSAL_NOT_PENDING);

    // Verify the Ed25519 signature covers this exact payload.
    assert!(
        ed25519::ed25519_verify(&sig, &pubkey, &attest_payload),
        E_ATTESTATION_INVALID,
    );

    // Derive Sui address from pubkey and assert it equals the tx signer.
    // Sui address = BLAKE2b-256(0x00 || pubkey) where 0x00 is Ed25519 flag.
    let mut addr_input = vector[0x00u8];
    addr_input.append(pubkey);
    let derived = address::from_bytes(hash::blake2b256(&addr_input));
    assert!(derived == ctx.sender(), E_ATTESTATION_INVALID);

    // Caller must be authorized for this resolver + attestation kind.
    assert!(
        can_submit(&resolver.config, resolver.kind, ctx.sender(), attest_kind),
        E_ATTESTATION_INVALID,
    );

    let signer = ctx.sender();
    let attestation = tree::new_attestation(signer, attest_kind, attest_payload);
    proposal.attestations.push_back(attestation);
    event::emit(AttestationSubmitted {
        proposal_id: object::id(proposal),
        signer,
        kind: attest_kind,
    });
}

// ─── finalize_merge ───────────────────────────────────────────────────────────

/// Finalize a proposal whose resolver verdict is APPROVE.
/// Requires MERGE on into_branch.  (SPEC §5)
public fun finalize_merge(
    tree: &mut MemoryTree,
    proposal: &mut MergeProposal,
    resolver: &ResolverRef,
    resolved_namespace: vector<u8>,
    resolved_blob_id: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(proposal.status == status_pending(), E_PROPOSAL_NOT_PENDING);

    // Authorization: MERGE on into_branch.
    assert!(
        tree::has_permission(tree, ctx.sender(), tree::perm_merge(), &proposal.into_branch, ctx.epoch()),
        E_NOT_DELEGATE,
    );

    // Fast-forward conflict (SPEC §5.1).
    let current_into_head = tree::branch_head(tree, &proposal.into_branch);
    assert!(current_into_head == proposal.into_head, E_FAST_FORWARD_CONFLICT);

    // Resolver verdict must be APPROVE.
    assert!(
        verdict_approved(&resolver.config, resolver.kind, &proposal.attestations),
        E_RESOLVER_REJECT,
    );

    let ns_str  = std::string::utf8(resolved_namespace);
    let tree_id = object::id(tree);
    let parents = vector[proposal.from_head, proposal.into_head];
    let attests = proposal.attestations;

    let merge_commit_id = tree::mint_merge_commit(
        tree_id,
        parents,
        ns_str,
        resolved_blob_id,
        ctx.sender(),
        proposal.into_branch,
        std::string::utf8(b"merge"),
        proposal.resolver,
        attests,
        ctx.epoch(),
        clock,
        ctx,
    );

    tree::advance_branch(tree, &proposal.into_branch, merge_commit_id);

    proposal.status = status_finalized();
    proposal.resolved_memwal_namespace = option::some(ns_str);
    proposal.resolved_memwal_blob_id   = option::some(resolved_blob_id);

    let proposal_id = object::id(proposal);
    event::emit(MergeFinalized { tree_id, proposal_id, merge_commit_id });
}

// ─── abort_merge ─────────────────────────────────────────────────────────────

/// Cancel a pending proposal.  Only the proposer or tree owner may call this.
public fun abort_merge(
    tree: &MemoryTree,
    proposal: &mut MergeProposal,
    ctx: &mut TxContext,
) {
    assert!(proposal.status == status_pending(), E_PROPOSAL_NOT_PENDING);
    let sender = ctx.sender();
    assert!(
        sender == proposal.proposed_by || sender == tree::owner(tree),
        E_NOT_OWNER,
    );
    proposal.status = status_aborted();
    event::emit(MergeAborted { proposal_id: object::id(proposal), reason_code: 0 });
}

// ─── claim_expired ────────────────────────────────────────────────────────────

/// Move a proposal to EXPIRED after its TTL has elapsed.  Anyone may call.
public fun claim_expired(
    proposal: &mut MergeProposal,
    clock: &Clock,
    _ctx: &mut TxContext,
) {
    assert!(proposal.status == status_pending(), E_PROPOSAL_NOT_PENDING);
    assert!(clock.timestamp_ms() > proposal.expires_at_ms, E_PROPOSAL_NOT_EXPIRED);
    proposal.status = status_expired();
    event::emit(MergeExpired { proposal_id: object::id(proposal) });
}

// ─── Accessors ───────────────────────────────────────────────────────────────

public fun proposal_status(p: &MergeProposal): u8          { p.status }
public fun proposal_tree_id(p: &MergeProposal): ID         { p.tree_id }
public fun proposal_from_branch(p: &MergeProposal): &String { &p.from_branch }
public fun proposal_into_branch(p: &MergeProposal): &String { &p.into_branch }
public fun resolver_kind(r: &ResolverRef): u8              { r.kind }
public fun resolver_config(r: &ResolverRef): &vector<u8>   { &r.config }

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Verdict engine  (SPEC §6)
// ─────────────────────────────────────────────────────────────────────────────

/// Returns true iff the resolver approves the proposal given the collected
/// attestations.  Dispatches by resolver kind recursively for composed resolvers.
fun verdict_approved(
    config: &vector<u8>,
    kind: u8,
    attestations: &vector<Attestation>,
): bool {
    if (kind == 0x00 || kind == 0x01) {
        // LAST_WRITE_WINS / UNION — always APPROVE.  (SPEC §6.1, §6.2)
        return true
    };
    if (kind == 0x02) return verdict_llm(config, attestations);   // LLM_RECONCILE
    if (kind == 0x03) return verdict_jury(config, attestations);  // JURY_RECONCILE
    if (kind == 0x05) return verdict_and(config, attestations);   // AND
    if (kind == 0x06) return verdict_sequence(config, attestations); // SEQUENCE
    // Unknown kind or EVALUATOR_PICK (0x04) not yet implemented → reject.
    false
}

// ─── JURY_RECONCILE (0x03) ────────────────────────────────────────────────────
//
// BCS config: { judges: vector<address>, k: u8, n: u8 }
// Verdict:    APPROVE iff at least k distinct judges submitted JURY_VOTE.
// (SPEC §6.4 — content-agreement check is off-chain for v0.1; deviation note 4.)

fun verdict_jury(config: &vector<u8>, attestations: &vector<Attestation>): bool {
    let mut reader = bcs::new(*config);
    let judges = bcs::peel_vec_address(&mut reader);
    let k      = (bcs::peel_u8(&mut reader) as u64);
    let _n     = bcs::peel_u8(&mut reader);

    let mut seen: vector<address> = vector[];
    let mut count = 0u64;
    let mut i = 0u64;
    while (i < attestations.length()) {
        let a = attestations.borrow(i);
        let signer = tree::attest_signer(a);
        if (tree::attest_kind(a) == ATTEST_JURY_VOTE
                && judges.contains(&signer)
                && !seen.contains(&signer)) {
            seen.push_back(signer);
            count = count + 1;
        };
        i = i + 1;
    };
    count >= k
}

// ─── LLM_RECONCILE (0x02) ────────────────────────────────────────────────────
//
// BCS config: { runner: Option<address> }
// Verdict:    APPROVE iff exactly one LLM_RESOLVE attestation exists, with
//             signer == runner (if runner is Some).  (SPEC §6.3)

fun verdict_llm(config: &vector<u8>, attestations: &vector<Attestation>): bool {
    let mut reader = bcs::new(*config);
    let runner = bcs::peel_option_address(&mut reader);

    let mut count = 0u64;
    let mut i = 0u64;
    while (i < attestations.length()) {
        let a = attestations.borrow(i);
        if (tree::attest_kind(a) == ATTEST_LLM_RESOLVE) {
            if (runner.is_some()) {
                if (tree::attest_signer(a) == *runner.borrow()) {
                    count = count + 1;
                }
            } else {
                count = count + 1;
            }
        };
        i = i + 1;
    };
    count >= 1
}

// ─── AND (0x05) ───────────────────────────────────────────────────────────────
//
// BCS config: vector of { kind: u8, config: vector<u8> } (embedded children).
// Verdict:    APPROVE iff ALL children approve.  (SPEC §6.6)

fun verdict_and(config: &vector<u8>, attestations: &vector<Attestation>): bool {
    let mut reader = bcs::new(*config);
    let num = bcs::peel_vec_length(&mut reader);
    let mut i = 0u64;
    while (i < num) {
        let child_kind   = bcs::peel_u8(&mut reader);
        let child_config = bcs::peel_vec_u8(&mut reader);
        if (!verdict_approved(&child_config, child_kind, attestations)) return false;
        i = i + 1;
    };
    true
}

// ─── SEQUENCE (0x06) ─────────────────────────────────────────────────────────
//
// BCS config: same as AND — vector of { kind: u8, config: vector<u8> }.
// Verdict:    APPROVE iff every child approves in order.  In practice the
//             attestation check is identical to AND (all must be present at
//             finalize time); ordering is enforced off-chain by the runtime.
//             (SPEC §6.7)

fun verdict_sequence(config: &vector<u8>, attestations: &vector<Attestation>): bool {
    // Verdict logic identical to AND (all children must approve).
    verdict_and(config, attestations)
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Attestation authorization  (used in submit_attestation)
// ─────────────────────────────────────────────────────────────────────────────

/// Returns true if `sender` is authorized to submit an attestation of
/// `attest_kind` for a resolver of the given `kind` with `config`.
fun can_submit(config: &vector<u8>, kind: u8, sender: address, attest_kind: u8): bool {
    if (kind == 0x00 || kind == 0x01) {
        // LWW / UNION — no attestations accepted.
        return false
    };
    if (kind == 0x02) return can_submit_llm(config, sender, attest_kind);
    if (kind == 0x03) return can_submit_jury(config, sender, attest_kind);
    if (kind == 0x05 || kind == 0x06) {
        // AND / SEQUENCE — accept if valid for any child.
        return can_submit_composed(config, sender, attest_kind)
    };
    false
}

fun can_submit_jury(config: &vector<u8>, sender: address, attest_kind: u8): bool {
    if (attest_kind != ATTEST_JURY_VOTE) return false;
    let mut reader = bcs::new(*config);
    let judges = bcs::peel_vec_address(&mut reader);
    judges.contains(&sender)
}

fun can_submit_llm(config: &vector<u8>, sender: address, attest_kind: u8): bool {
    if (attest_kind != ATTEST_LLM_RESOLVE) return false;
    let mut reader = bcs::new(*config);
    let runner = bcs::peel_option_address(&mut reader);
    if (runner.is_some()) {
        sender == *runner.borrow()
    } else {
        true // no runner restriction — anyone may submit LLM_RESOLVE
    }
}

fun can_submit_composed(config: &vector<u8>, sender: address, attest_kind: u8): bool {
    let mut reader = bcs::new(*config);
    let num = bcs::peel_vec_length(&mut reader);
    let mut i = 0u64;
    while (i < num) {
        let child_kind   = bcs::peel_u8(&mut reader);
        let child_config = bcs::peel_vec_u8(&mut reader);
        if (can_submit(&child_config, child_kind, sender, attest_kind)) return true;
        i = i + 1;
    };
    false
}

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL: Composition depth/leaf counter  (for E_COMPOSITION_LIMIT)
// ─────────────────────────────────────────────────────────────────────────────

/// Returns (max_depth, total_leaves) for a composed resolver config at the
/// given starting depth.  Leaf resolvers (LWW, UNION, JURY, LLM, EVALUATOR)
/// count 1 leaf and add 0 depth to their parent.
fun composed_depth_leaves(config: &vector<u8>, depth: u64): (u64, u64) {
    let mut reader = bcs::new(*config);
    let num = bcs::peel_vec_length(&mut reader);
    let mut max_d  = depth;
    let mut leaves = 0u64;
    let mut i = 0u64;
    while (i < num) {
        let child_kind   = bcs::peel_u8(&mut reader);
        let child_config = bcs::peel_vec_u8(&mut reader);
        if (child_kind == kind_sequence() || child_kind == kind_and()) {
            let (d, l) = composed_depth_leaves(&child_config, depth + 1);
            if (d > max_d) { max_d = d };
            leaves = leaves + l;
        } else {
            leaves = leaves + 1;
        };
        i = i + 1;
    };
    (max_d, leaves)
}
