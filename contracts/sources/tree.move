/// `memforks::tree` — core data model and entry functions for MemForks.
///
/// Implements SPEC §3–5, §9 (events), §10 (error codes).
/// Phase 0: all structs, events, and error constants defined; entry functions
/// are stubs (correct signatures, no logic yet — Phase 1 implements them).
module memforks::tree;

use std::string::String;
use sui::event;
use sui::object::{Self, UID, ID};
use sui::table::{Self, Table};
use sui::transfer;
use sui::tx_context::{Self, TxContext};
use memforks::acl;

// ─── Spec version (SPEC §12) ─────────────────────────────────────────────────

public fun spec_version(): (u8, u8, u8) { (0, 1, 0) }

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
const E_INVALID_PARENTS:     u64 = 0x0009;
const E_RESERVED_BITS_SET:   u64 = 0x000A;

// ─── Structs (SPEC §4.1–4.4) ─────────────────────────────────────────────────

/// Root forkable memory object. Shared.
public struct MemoryTree has key {
    id: UID,
    owner: address,
    /// Referenced MemWalAccount object ID.
    memwal_account: ID,
    /// branch name → head MemoryCommit ID
    branches: Table<String, ID>,
    default_branch: String,
    /// agent address → DelegateCap
    delegates: Table<address, DelegateCap>,
    /// Monotonically non-decreasing commit counter.
    commit_count: u64,
    created_at_ms: u64,
}

/// Immutable node in the commit DAG. Frozen after minting.
public struct MemoryCommit has key, store {
    id: UID,
    tree_id: ID,
    /// length 1 = normal, length >= 2 = merge commit
    parents: vector<ID>,
    memwal_namespace: String,
    memwal_blob_id: vector<u8>,
    author: address,
    author_branch: String,
    message: String,
    /// ResolverRef ID used; present only on merge commits.
    merge_resolver: Option<ID>,
    attestations: vector<Attestation>,
    epoch: u64,
    ts_ms: u64,
}

/// Scoped write capability stored inside the tree. Not a top-level object.
public struct DelegateCap has store {
    agent: address,
    /// Empty = all branches permitted.
    allowed_branches: vector<String>,
    permissions: u8,
    expires_epoch: u64,
    revoked: bool,
}

/// Signed claim attached to a commit or merge proposal. (SPEC §4.4)
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

public struct CommitCreated has copy, drop {
    tree_id: ID,
    commit_id: ID,
    branch: String,
    parents: vector<ID>,
    memwal_namespace: String,
    memwal_blob_id: vector<u8>,
    author: address,
    is_merge: bool,
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/// Derive the canonical MemWal namespace for a branch on this tree.
/// Format: memforks/<tree_id_hex>/<branch>   (SPEC §4.5)
fun branch_namespace(tree_id_bytes: vector<u8>, branch: &String): String {
    let mut ns = std::string::utf8(b"memforks/");
    // hex-encode tree_id bytes
    let hex = sui::hex::encode(tree_id_bytes);
    ns.append(std::string::utf8(hex));
    ns.append(std::string::utf8(b"/"));
    ns.append(*branch);
    ns
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
    // Branch scope check (empty allowed_branches = all branches)
    if (!cap.allowed_branches.is_empty()) {
        let mut found = false;
        let mut i = 0;
        while (i < cap.allowed_branches.length()) {
            if (&cap.allowed_branches[i] == branch) {
                found = true;
                break
            };
            i = i + 1;
        };
        assert!(found, E_BRANCH_OUT_OF_SCOPE);
    };
}

// ─── Entry functions — Phase 0 stubs (SPEC §5) ───────────────────────────────
// Signatures are normative and match the SPEC.  Logic is Phase 1.

/// Create a new MemoryTree, genesis commit, and default-branch BranchACL.
/// Tree is shared immediately; genesis commit is frozen.
public entry fun init_tree(
    memwal_account_id: address, // passed as address; converted to ID inside
    default_branch: vector<u8>,
    ctx: &mut TxContext,
) {
    let owner = ctx.sender();
    let branch_str = std::string::utf8(default_branch);
    let memwal_account = object::id_from_address(memwal_account_id);
    let ts_ms = 0u64; // Phase 1: use Clock

    let mut tree = MemoryTree {
        id: object::new(ctx),
        owner,
        memwal_account,
        branches: table::new(ctx),
        default_branch: branch_str,
        delegates: table::new(ctx),
        commit_count: 0,
        created_at_ms: ts_ms,
    };

    let tree_id = object::id(&tree);
    let tree_id_bytes = object::id_to_bytes(&tree_id);
    let ns = branch_namespace(tree_id_bytes, &branch_str);

    // Genesis commit — empty payload, no parents.
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
    let genesis_id = object::id(&genesis);
    transfer::public_freeze_object(genesis);

    // Wire the branch head.
    tree.branches.add(branch_str, genesis_id);
    tree.commit_count = 1;

    // BranchACL for the default branch.
    acl::create(tree_id, branch_str, ns, ctx);

    event::emit(TreeCreated { tree_id, owner, memwal_account, default_branch: branch_str, ts_ms });

    transfer::share_object(tree);
}

/// Issue a DelegateCap to an agent.  Only the tree owner may call this.
public entry fun grant_delegate(
    tree: &mut MemoryTree,
    agent: address,
    allowed_branches: vector<String>,
    permissions: u8,
    expires_epoch: u64,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == tree.owner, E_NOT_OWNER);
    assert!(permissions & 0xE0 == 0, E_RESERVED_BITS_SET);
    // Phase 1: assert expires_epoch > current_epoch
    let cap = DelegateCap {
        agent,
        allowed_branches,
        permissions,
        expires_epoch,
        revoked: false,
    };
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

/// Flip a delegate's revoked flag.  Only the tree owner may call this.
public entry fun revoke_delegate(
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

/// Attach (or clear) a merge-authority resolver on a branch.
/// Only the tree owner may call this.
public entry fun set_branch_authority(
    tree: &MemoryTree,
    _branch: vector<u8>,
    _resolver_id: address,
    ctx: &mut TxContext,
) {
    assert!(ctx.sender() == tree.owner, E_NOT_OWNER);
    // Phase 1: look up BranchACL and call acl::set_merge_authority
}

/// Fork a new branch from an existing one.  Requires FORK on from_branch.
public entry fun branch(
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
    let head_id = *tree.branches.borrow(from_str);
    tree.branches.add(new_str, head_id);

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

/// Append a memory commit to a branch.  Requires WRITE on branch.
public entry fun commit(
    tree: &mut MemoryTree,
    branch: vector<u8>,
    memwal_blob_id: vector<u8>,
    message: vector<u8>,
    parents: vector<ID>,
    ctx: &mut TxContext,
) {
    let branch_str = std::string::utf8(branch);
    assert!(tree.branches.contains(branch_str), E_BRANCH_NOT_FOUND);

    let sender = ctx.sender();
    assert_delegate(tree, sender, perm_write(), &branch_str, ctx.epoch());

    // Validate parents: must be non-empty, all must belong to this tree.
    // Phase 1: verify each parent ID exists on-chain and has matching tree_id.
    assert!(!parents.is_empty(), E_INVALID_PARENTS);

    let tree_id = object::id(tree);
    let tree_id_bytes = object::id_to_bytes(&tree_id);
    let ns = branch_namespace(tree_id_bytes, &branch_str);

    let commit_obj = MemoryCommit {
        id: object::new(ctx),
        tree_id,
        parents,
        memwal_namespace: ns,
        memwal_blob_id,
        author: sender,
        author_branch: branch_str,
        message: std::string::utf8(message),
        merge_resolver: option::none(),
        attestations: vector[],
        epoch: ctx.epoch(),
        ts_ms: 0, // Phase 1: Clock
    };
    let commit_id = object::id(&commit_obj);

    // Advance branch head.
    tree.branches.remove(branch_str);
    tree.branches.add(branch_str, commit_id);
    tree.commit_count = tree.commit_count + 1;

    transfer::public_freeze_object(commit_obj);

    event::emit(CommitCreated {
        tree_id,
        commit_id,
        branch: branch_str,
        parents,
        memwal_namespace: ns,
        memwal_blob_id,
        author: sender,
        is_merge: false,
    });
}

// ─── Public accessors (used by resolver.move) ────────────────────────────────

public fun owner(tree: &MemoryTree): address            { tree.owner }
public fun memwal_account(tree: &MemoryTree): ID        { tree.memwal_account }
public fun commit_count(tree: &MemoryTree): u64         { tree.commit_count }
public fun default_branch(tree: &MemoryTree): &String   { &tree.default_branch }

public fun branch_head(tree: &MemoryTree, branch: &String): ID {
    assert!(tree.branches.contains(*branch), E_BRANCH_NOT_FOUND);
    *tree.branches.borrow(*branch)
}

public fun has_branch(tree: &MemoryTree, branch: &String): bool {
    tree.branches.contains(*branch)
}

/// Check delegate permission without aborting (used by resolver.move for
/// pre-flight checks before proposing a merge).
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
        let mut i = 0;
        while (i < cap.allowed_branches.length()) {
            if (&cap.allowed_branches[i] == branch) { found = true; break };
            i = i + 1;
        };
        if (!found) return false;
    };
    true
}

/// Advance branch head and increment commit_count.
/// Called by resolver.move after finalize_merge mints the merge commit.
public fun advance_branch(
    tree: &mut MemoryTree,
    branch: &String,
    new_head: ID,
) {
    assert!(tree.branches.contains(*branch), E_BRANCH_NOT_FOUND);
    tree.branches.remove(*branch);
    tree.branches.add(*branch, new_head);
    tree.commit_count = tree.commit_count + 1;
}

/// Mint a merge commit and freeze it.  Called by resolver::finalize_merge.
public fun mint_merge_commit(
    tree_id: ID,
    parents: vector<ID>,
    memwal_namespace: String,
    memwal_blob_id: vector<u8>,
    author: address,
    author_branch: String,
    message: String,
    resolver_id: ID,
    attestations: vector<Attestation>,
    epoch: u64,
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
        ts_ms: 0, // Phase 1: Clock
    };
    let commit_id = object::id(&merge_commit);
    transfer::public_freeze_object(merge_commit);
    commit_id
}
