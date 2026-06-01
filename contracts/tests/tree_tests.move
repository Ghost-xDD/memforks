/// Phase 0 placeholder — ensures `sui move test` exits 0 with no failures.
/// Real tests land in Phase 1 alongside init_tree / commit / revoke implementations.
#[test_only]
module memforks::tree_tests;

// Phase 1 tests to add:
//   - genesis invariant: init_tree → branches["main"] exists, commit_count == 1
//   - WRITE-without-permission aborts with E_MISSING_PERMISSION
//   - revoked delegate aborts with E_DELEGATE_REVOKED
//   - branch-out-of-scope aborts with E_BRANCH_OUT_OF_SCOPE

#[test]
fun test_placeholder_passes() {
    // Intentionally empty — a green Phase 0 gate.
}
