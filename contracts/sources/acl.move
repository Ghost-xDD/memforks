/// `memforks::acl` — BranchACL objects, one per (tree_id, branch) pair.
///
/// Each BranchACL is a shared object. It records:
///   - which MemWal namespace holds payloads for that branch
///   - an optional ResolverRef that must gate merges INTO that branch
///
/// Namespace convention (SPEC §4.5):  memforks/<tree_id_hex>/<branch>
module memforks::acl;

use std::string::String;
use sui::object::{Self, UID, ID};
use sui::transfer;
use sui::tx_context::TxContext;

// ─── Structs ─────────────────────────────────────────────────────────────────

/// One per (tree_id, branch) pair. Shared object.
public struct BranchACL has key {
    id: UID,
    tree_id: ID,
    branch: String,
    memwal_namespace: String,
    /// ResolverRef ID that must gate merges INTO this branch. None = unrestricted.
    merge_authority: Option<ID>,
}

// ─── Public constructors (called from memforks::tree) ────────────────────────

/// Create a BranchACL and share it.  Returns the new ACL's ID so tree.move
/// can store it in its own index.
public fun create(
    tree_id: ID,
    branch: String,
    memwal_namespace: String,
    ctx: &mut TxContext,
): ID {
    let acl = BranchACL {
        id: object::new(ctx),
        tree_id,
        branch,
        memwal_namespace,
        merge_authority: option::none(),
    };
    let acl_id = object::id(&acl);
    transfer::share_object(acl);
    acl_id
}

// ─── Accessors ───────────────────────────────────────────────────────────────

public fun tree_id(acl: &BranchACL): ID                  { acl.tree_id }
public fun branch(acl: &BranchACL): &String              { &acl.branch }
public fun memwal_namespace(acl: &BranchACL): &String    { &acl.memwal_namespace }
public fun merge_authority(acl: &BranchACL): &Option<ID> { &acl.merge_authority }

// ─── Mutators (owner-gated; tree.move enforces the owner check) ──────────────

/// Set (or clear) the merge_authority resolver on this branch.
/// The caller (tree.move) MUST have already verified tree ownership.
public fun set_merge_authority(acl: &mut BranchACL, resolver_id: Option<ID>) {
    acl.merge_authority = resolver_id;
}
