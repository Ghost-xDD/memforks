/// `memforks::tree` — core data model and entry functions for MemForks.
///
/// Model A architecture (SPEC §4–5, §9, §10):
///   - Regular commits are off-chain Walrus blobs written via the SDK (no entry function).
///   - `MemoryTree.branches` maps branch names to Walrus blob IDs (vector<u8>), not
///     on-chain object IDs. An empty vector means the branch is at genesis.
///   - `MemoryCommit` is minted only for merge anchors and the genesis commit.
///   - `CommitCreated` is removed. Indexers reconstruct the DAG from `MergeFinalized`
///     events by walking the Walrus blob hash chain (SPEC §8.2).
module memforks::tree;

use std::string::String;
use sui::clock::Clock;
use sui::event;
use sui::hex;
use sui::object::{Self, UID, ID};
use sui::table::{Self, Table};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use memforks::acl;

// ─── Spec version (SPEC §12) ─────────────────────────────────────────────────

public fun spec_version(): (u8, u8, u8) { (0, 1, 1) }

// ─── Permission bitmask (SPEC §3.1) ─────────────────────────────────────────

public fun perm_read():    u8 { 0x01 }
public fun perm_write():   u8 { 0x02 }
public fun perm_fork():    u8 { 0x04 }
public fun perm_merge():   u8 { 0x08 }
public fun perm_propose(): u8 { 0x10 }
public fun perm_reserved_mask(): u8 { 0xE0 }

// ─── Attestation kinds (SPEC §4.4) ───────────────────────────────────────────

public fun attest_jury_vote():          u8 { 0x01 }
public fun attest_evaluator_verdict():  u8 { 0x02 }
public fun attest_oracle_report():      u8 { 0x03 }
public fun attest_llm_resolve():        u8 { 0x04 }

// ─── Error codes (SPEC §10) ──────────────────────────────────────────────────

const E_NOT_OWNER:           u64 = 0x0001;
const E_NOT_DELEGATE:        u64 = 0x0002;
const E_DELEGATE_REVOKED:    u64 = 0x0003;
const E_DELEGATE_EXPIRED:    u64 = 0x0004;
const E_MISSING_PERMISSION:  u64 = 0x0005;
const E_BRANCH_NOT_FOUND:    u64 = 0x0006;
const E_BRANCH_EXISTS:       u64 = 0x0007;
const E_BRANCH_OUT_OF_SCOPE: u64 = 0x0008;
const E_RESERVED_BITS_SET:   u64 = 0x000A;

// ─── Structs (SPEC §4.1–4.4) ─────────────────────────────────────────────────

/// Root forkable memory object. Shared.
public struct MemoryTree has key {
    id: UID,
    owner: address,
    /// Referenced MemWalAccount object ID.
    memwal_account: ID,
    /// branch name → head Walrus blob ID.
    /// Empty vector = branch is at genesis (no off-chain commits yet).
    branches: Table<String, vector<u8>>,
    default_branch: String,
    /// agent address → DelegateCap
    delegates: Table<address, DelegateCap>,
    /// Incremented only at merge time.
    commit_count: u64,
    created_at_ms: u64,
}

/// On-chain anchor. Minted only for merge commits and the genesis commit.
/// Regular agent commits are off-chain Walrus blobs — no Move object is created.
public struct MemoryCommit has key, store {
    id: UID,
    tree_id: ID,
    /// Walrus blob IDs of the two branch heads consumed by the merge.
    /// Empty for the genesis commit.
    parents: vector<vector<u8>>,
    memwal_namespace: String,
    /// Walrus blob ID of this commit's resolved content.
    memwal_blob_id: vector<u8>,
    author: address,
    author_branch: String,
    message: String,
    /// Always set on merge commits.
    merge_resolver: Option<ID>,
    attestations: vector<Attestation>,
    epoch: u64,
    ts_ms: u64,
}

/// Scoped write capability stored inside the tree.
/// `drop` allows Table::remove() to discard a cap when reissuing.
public struct DelegateCap has store, drop {
    agent: address,
    /// Empty = all branches permitted.
    allowed_branches: vector<String>,
    permissions: u8,
    expires_epoch: u64,
    revoked: bool,
}

/// Signed claim attached to a merge proposal. (SPEC §4.4)
public struct Attestation has store, copy, drop {
    signer: address,
    kind: u8,
    payload: vector<u8>,
}

// ─── Events (SPEC §9) ────────────────────────────────────────────────────────

public struct TreeCreated has copy, drop {
    tree_id: ID,
    owner: address,
    memwal_account: ID,
    default_branch: String,
    ts_ms: u64,
}

public struct DelegateGranted has copy, drop {
    tree_id: ID,
    agent: address,
    permissions: u8,
    expires_epoch: u64,
}

public struct DelegateRevoked has copy, drop {
    tree_id: ID,
    agent: address,
}

public struct BranchCreated has copy, drop {
    tree_id: ID,
    branch: String,
    from_branch: String,
    memwal_namespace: String,
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/// Derive the canonical MemWal namespace for a branch.
/// Format: memforks/<tree_id_hex>/<branch>   (SPEC §4.5)
fun branch_namespace(tree_id_bytes: vector<u8>, branch: &String): String {
    let mut ns = std::string::utf8(b"memforks/");
    let hex_bytes = hex::encode(tree_id_bytes);
    ns.append(std::string::utf8(hex_bytes));
    ns.append(std::string::utf8(b"/"));
    ns.append(*branch);
    ns
}

/// Construct an Attestation value. Called by resolver.move.
public fun new_attestation(signer: address, kind: u8, payload: vector<u8>): Attestation {
    Attestation { signer, kind, payload }
}

/// Resolve DelegateCap for the sender or abort with the appropriate code.
fun assert_delegate(
    tree: &MemoryTree,
    sender: address,
    required_perm: u8,
    branch: &String,
    current_epoch: u64,
) {
    assert!(tree.delegates.contains(sender), E_NOT_DELEGATE);
    let cap = tree.delegates.borrow(sender);
    assert!(!cap.revoked, E_DELEGATE_REVOKED);
    assert!(cap.expires_epoch >= current_epoch, E_DELEGATE_EXPIRED);
    assert!(cap.permissions & required_perm == required_perm, E_MISSING_PERMISSION);
    if (!cap.allowed_branches.is_empty()) {
        let mut found = false;
        let mut i = 0u64;
        while (i < cap.allowed_branches.length()) {
            if (*cap.allowed_branches.borrow(i) == *branch) {
                found = true;
                break
            };
            i = i + 1;
        };
        assert!(found, E_BRANCH_OUT_OF_SCOPE);
    };
}

// ─── Entry functions (SPEC §5) ────────────────────────────────────────────────

/// Create a new MemoryTree, genesis commit, and default-branch BranchACL.
/// The genesis commit is an on-chain anchor with empty payload and no parents.
/// The default branch head is initialised to an empty blob ID (genesis sentinel).
public fun init_tree(
    memwal_account_id: address,
    default_branch: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let owner        = ctx.sender();
    let branch_str   = std::string::utf8(default_branch);
    let memwal_account = object::id_from_address(memwal_account_id);
    let ts_ms        = clock.timestamp_ms();

    let mut delegates = table::new(ctx);
    // Bootstrap: creator is their own first delegate with full permissions.
    delegates.add(owner, DelegateCap {
        agent: owner,
        allowed_branches: vector[],
        permissions: 0xFF,
        expires_epoch: 0xFFFFFFFFFFFFFFFF,
        revoked: false,
    });

    let mut tree = MemoryTree {
        id: object::new(ctx),
        owner,
        memwal_account,
        branches: table::new(ctx),
        default_branch: branch_str,
        delegates,
        commit_count: 0,
        created_at_ms: ts_ms,
    };

    let tree_id       = object::id(&tree);
    let tree_id_bytes = object::id_to_bytes(&tree_id);
    let ns            = branch_namespace(tree_id_bytes, &branch_str);

    // Genesis commit — empty payload, no parents, frozen immediately.
    let genesis = MemoryCommit {
        id: object::new(ctx),
        tree_id,
        parents: vector[],
        memwal_namespace: ns,
        memwal_blob_id: vector[],
        author: owner,
        author_branch: branch_str,
        message: std::string::utf8(b"genesis"),
        merge_resolver: option::none(),
        attestations: vector[],
        epoch: ctx.epoch(),
        ts_ms,
    };
    transfer::public_freeze_object(genesis);

    // Branch head starts as an empty blob ID (genesis sentinel = no off-chain commits).
    tree.branches.add(branch_str, vector[]);
    tree.commit_count = 0;

    acl::create(tree_id, branch_str, ns, ctx);

    event::emit(TreeCreated { tree_id, owner, memwal_account, default_branch: branch_str, ts_ms });

    transfer::share_object(tree);
}

/// Issue a DelegateCap to an agent. Only the tree owner may call this.
public fun grant_delegate(
    tree: &mut MemoryTree,
    agent: address,
    allowed_branches: vector<String>,
    permissions: u8,
    expires_epoch: u64,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == tree.owner, E_NOT_OWNER);
    assert!(permissions & 0xE0 == 0, E_RESERVED_BITS_SET);
    let cap = DelegateCap { agent, allowed_branches, permissions, expires_epoch, revoked: false };
    if (tree.delegates.contains(agent)) {
        tree.delegates.remove(agent);
    };
    tree.delegates.add(agent, cap);
    event::emit(DelegateGranted {
        tree_id: object::id(tree),
        agent,
        permissions,
        expires_epoch,
    });
}

/// Flip a delegate's revoked flag. Only the tree owner may call this.
public fun revoke_delegate(
    tree: &mut MemoryTree,
    agent: address,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == tree.owner, E_NOT_OWNER);
    assert!(tree.delegates.contains(agent), E_NOT_DELEGATE);
    let cap = tree.delegates.borrow_mut(agent);
    cap.revoked = true;
    event::emit(DelegateRevoked { tree_id: object::id(tree), agent });
}

/// Attach (or clear) a merge-authority resolver on a branch. Only the owner.
public fun set_branch_authority(
    tree: &MemoryTree,
    _branch: vector<u8>,
    _resolver_id: address,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == tree.owner, E_NOT_OWNER);
    // Phase 1: look up BranchACL and call acl::set_merge_authority
}

/// Fork a new branch from an existing one. Requires FORK on from_branch.
/// The new branch head is initialised to the same settled blob ID as the source branch.
public fun branch(
    tree: &mut MemoryTree,
    from_branch: vector<u8>,
    new_branch: vector<u8>,
    ctx: &mut TxContext,
) {
    let from_str = std::string::utf8(from_branch);
    let new_str  = std::string::utf8(new_branch);

    assert!(tree.branches.contains(from_str), E_BRANCH_NOT_FOUND);
    assert!(!tree.branches.contains(new_str), E_BRANCH_EXISTS);

    let sender = ctx.sender();
    assert_delegate(tree, sender, perm_fork(), &from_str, ctx.epoch());

    let tree_id = object::id(tree);

    // Copy the settled head blob ID from the source branch.
    // vector<u8> has copy (u8: copy), so dereference works.
    let settled_head = *tree.branches.borrow(from_str);
    tree.branches.add(new_str, settled_head);

    let tree_id_bytes = object::id_to_bytes(&tree_id);
    let ns = branch_namespace(tree_id_bytes, &new_str);
    acl::create(tree_id, new_str, ns, ctx);

    event::emit(BranchCreated {
        tree_id,
        branch: new_str,
        from_branch: from_str,
        memwal_namespace: ns,
    });
}

// ─── Public accessors (used by resolver.move) ────────────────────────────────

public fun owner(tree: &MemoryTree): address            { tree.owner }
public fun memwal_account(tree: &MemoryTree): ID        { tree.memwal_account }
public fun commit_count(tree: &MemoryTree): u64         { tree.commit_count }
public fun default_branch(tree: &MemoryTree): &String   { &tree.default_branch }

public fun attest_signer(a: &Attestation): address      { a.signer }
public fun attest_kind(a: &Attestation): u8             { a.kind }
public fun attest_payload(a: &Attestation): &vector<u8> { &a.payload }

/// Returns the settled Walrus blob ID for a branch (empty = at genesis).
public fun branch_head(tree: &MemoryTree, branch: &String): vector<u8> {
    assert!(tree.branches.contains(*branch), E_BRANCH_NOT_FOUND);
    *tree.branches.borrow(*branch)
}

public fun has_branch(tree: &MemoryTree, branch: &String): bool {
    tree.branches.contains(*branch)
}

/// Non-aborting permission check — used by resolver.move pre-flight.
public fun has_permission(
    tree: &MemoryTree,
    agent: address,
    perm: u8,
    branch: &String,
    current_epoch: u64,
): bool {
    if (!tree.delegates.contains(agent)) return false;
    let cap = tree.delegates.borrow(agent);
    if (cap.revoked || cap.expires_epoch < current_epoch) return false;
    if (cap.permissions & perm != perm) return false;
    if (!cap.allowed_branches.is_empty()) {
        let mut found = false;
        let mut i = 0u64;
        while (i < cap.allowed_branches.length()) {
            if (*cap.allowed_branches.borrow(i) == *branch) { found = true; break };
            i = i + 1;
        };
        if (!found) return false;
    };
    true
}

/// Advance a branch head to a new Walrus blob ID and increment commit_count.
/// Called by resolver.move after finalize_merge.
public fun advance_branch(
    tree: &mut MemoryTree,
    branch: &String,
    new_head_blob_id: vector<u8>,
) {
    assert!(tree.branches.contains(*branch), E_BRANCH_NOT_FOUND);
    tree.branches.remove(*branch);
    tree.branches.add(*branch, new_head_blob_id);
    tree.commit_count = tree.commit_count + 1;
}

/// Mint a merge anchor commit and freeze it. Called by resolver::finalize_merge.
/// Returns the new MemoryCommit's object ID (used in the MergeFinalized event).
public fun mint_merge_commit(
    tree_id: ID,
    parents: vector<vector<u8>>,
    memwal_namespace: String,
    memwal_blob_id: vector<u8>,
    author: address,
    author_branch: String,
    message: String,
    resolver_id: ID,
    attestations: vector<Attestation>,
    epoch: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    let merge_commit = MemoryCommit {
        id: object::new(ctx),
        tree_id,
        parents,
        memwal_namespace,
        memwal_blob_id,
        author,
        author_branch,
        message,
        merge_resolver: option::some(resolver_id),
        attestations,
        epoch,
        ts_ms: clock.timestamp_ms(),
    };
    let commit_id = object::id(&merge_commit);
    transfer::public_freeze_object(merge_commit);
    commit_id
}
