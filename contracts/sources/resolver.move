/// `memforks::resolver` — merge proposal lifecycle and resolver registry.
///
/// Implements SPEC §4.6–4.7, §5 (propose/submit/finalize/abort/expire),
/// §6 (resolver semantics), §7 (proposal state machine), §9 (events), §10 (errors).
/// Phase 0: all structs and events defined; entry functions are stubs.
module memforks::resolver;

use std::string::String;
use sui::event;
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

// ─── Proposal status (SPEC §4.7) ─────────────────────────────────────────────

public fun status_pending():   u8 { 0 }
public fun status_finalized(): u8 { 1 }
public fun status_aborted():   u8 { 2 }
public fun status_expired():   u8 { 3 }

// ─── Error codes (SPEC §10) ──────────────────────────────────────────────────

const E_PROPOSAL_NOT_PENDING:  u64 = 0x0010;
const E_PROPOSAL_NOT_EXPIRED:  u64 = 0x0011;
const E_FAST_FORWARD_CONFLICT: u64 = 0x0012;
const E_RESOLVER_REJECT:       u64 = 0x0013;
const E_RESOLVER_PENDING:      u64 = 0x0014;
const E_RESOLVER_INCOMPATIBLE: u64 = 0x0015;
const E_ATTESTATION_INVALID:   u64 = 0x0016;
const E_COMPOSITION_LIMIT:     u64 = 0x0017;
const E_PAYLOAD_VERSION_UNKNOWN: u64 = 0x0020;

// ─── Structs (SPEC §4.6–4.7) ─────────────────────────────────────────────────

/// A typed merge strategy.  Owned / transferable.  (SPEC §4.6)
public struct ResolverRef has key, store {
    id: UID,
    kind: u8,
    /// CBOR-encoded, kind-specific config.  (SPEC §6, Appendix B)
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
    /// ID of the ResolverRef governing this merge.
    resolver: ID,
    proposed_by: address,
    proposed_at_ms: u64,
    expires_at_ms: u64,
    /// 0=PENDING 1=FINALIZED 2=ABORTED 3=EXPIRED
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

// ─── Resolver constructor ─────────────────────────────────────────────────────

/// Create a ResolverRef.  Transferred to the caller.
public entry fun create_resolver(
    kind: u8,
    config: vector<u8>,
    ctx: &mut TxContext,
) {
    let resolver = ResolverRef {
        id: object::new(ctx),
        kind,
        config,
    };
    transfer::public_transfer(resolver, ctx.sender());
}

// ─── Entry functions — Phase 0 stubs (SPEC §5) ───────────────────────────────

/// Open a merge proposal.  Requires PROPOSE on from_branch.
public entry fun propose_merge(
    tree: &MemoryTree,
    from_branch: vector<u8>,
    into_branch: vector<u8>,
    resolver: &ResolverRef,
    ttl_ms: u64,
    ctx: &mut TxContext,
) {
    let from_str = std::string::utf8(from_branch);
    let into_str = std::string::utf8(into_branch);

    // Phase 1: full authorization + merge_authority compatibility check
    let sender = ctx.sender();
    let _ = sender;

    let tree_id   = object::id(tree);
    let from_head = tree::branch_head(tree, &from_str);
    let into_head = tree::branch_head(tree, &into_str);
    let resolver_id = object::id(resolver);
    let now_ms    = 0u64; // Phase 1: Clock
    let expires_at_ms = now_ms + ttl_ms;

    let proposal = MergeProposal {
        id: object::new(ctx),
        tree_id,
        from_branch: from_str,
        into_branch: into_str,
        from_head,
        into_head,
        resolver: resolver_id,
        proposed_by: ctx.sender(),
        proposed_at_ms: now_ms,
        expires_at_ms,
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
        expires_at_ms,
    });

    transfer::share_object(proposal);
}

/// Append an attestation to an open proposal.
public entry fun submit_attestation(
    proposal: &mut MergeProposal,
    attest_kind: u8,
    attest_payload: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(proposal.status == status_pending(), E_PROPOSAL_NOT_PENDING);
    // Phase 1: signature + kind validation per SPEC §6
    let signer = ctx.sender();
    let attestation = tree::new_attestation(signer, attest_kind, attest_payload);
    proposal.attestations.push_back(attestation);
    event::emit(AttestationSubmitted {
        proposal_id: object::id(proposal),
        signer,
        kind: attest_kind,
    });
}

/// Finalize a resolved proposal, minting a merge commit.
/// Requires MERGE on into_branch.
public entry fun finalize_merge(
    tree: &mut MemoryTree,
    proposal: &mut MergeProposal,
    resolved_namespace: vector<u8>,
    resolved_blob_id: vector<u8>,
    ctx: &mut TxContext,
) {
    assert!(proposal.status == status_pending(), E_PROPOSAL_NOT_PENDING);

    // Fast-forward conflict check (SPEC §5.1)
    let current_into_head = tree::branch_head(tree, &proposal.into_branch);
    assert!(current_into_head == proposal.into_head, E_FAST_FORWARD_CONFLICT);

    // Phase 1: run resolver verdict check

    let ns_str   = std::string::utf8(resolved_namespace);
    let tree_id  = object::id(tree);
    let parents  = vector[proposal.from_head, proposal.into_head];
    let attests  = proposal.attestations;

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
        ctx,
    );

    tree::advance_branch(tree, &proposal.into_branch, merge_commit_id);

    proposal.status = status_finalized();
    proposal.resolved_memwal_namespace = option::some(ns_str);
    proposal.resolved_memwal_blob_id   = option::some(resolved_blob_id);

    let proposal_id = object::id(proposal);
    event::emit(MergeFinalized { tree_id, proposal_id, merge_commit_id });
}

/// Cancel a proposal.  Only the proposer or tree owner may call this.
public entry fun abort_merge(
    tree: &MemoryTree,
    proposal: &mut MergeProposal,
    ctx: &mut TxContext,
) {
    assert!(proposal.status == status_pending(), E_PROPOSAL_NOT_PENDING);
    let sender = ctx.sender();
    assert!(sender == proposal.proposed_by || sender == tree::owner(tree), 0x0001);
    proposal.status = status_aborted();
    event::emit(MergeAborted { proposal_id: object::id(proposal), reason_code: 0 });
}

/// Transition an expired proposal to EXPIRED.  Anyone may call after expiry.
public entry fun claim_expired(
    proposal: &mut MergeProposal,
    _ctx: &mut TxContext,
) {
    assert!(proposal.status == status_pending(), E_PROPOSAL_NOT_PENDING);
    // Phase 1: assert current ts_ms > proposal.expires_at_ms via Clock
    proposal.status = status_expired();
    event::emit(MergeExpired { proposal_id: object::id(proposal) });
}

// ─── Accessors ───────────────────────────────────────────────────────────────

public fun proposal_status(p: &MergeProposal): u8         { p.status }
public fun proposal_tree_id(p: &MergeProposal): ID        { p.tree_id }
public fun proposal_from_branch(p: &MergeProposal): &String { &p.from_branch }
public fun proposal_into_branch(p: &MergeProposal): &String { &p.into_branch }
public fun resolver_kind(r: &ResolverRef): u8             { r.kind }
public fun resolver_config(r: &ResolverRef): &vector<u8>  { &r.config }
