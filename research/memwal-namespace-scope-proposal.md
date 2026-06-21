# Proposal: Namespace-scoped delegate keys

**Type:** Feature (security hardening)
**Module:** `memwal::account` (plus SDK/relayer encryption path)
**Effort:** ~90 lines of Move + tests, plus a focused SDK/relayer change (see Scope and effort)
**Breaking changes:** None to struct or event layouts (upgrade-compatible by design). The encryption change is forward-only and additive.
**Author:** MemForks team (Sui Overflow 2026)

---

## Summary

Today a `DelegateKey` grants decryption access to every namespace on a
`MemWalAccount`. Namespaces are MemWal's core scoping primitive, but the
boundary between them is currently enforced only by the relayer (it filters by
`owner + namespace` in PostgreSQL). It is not a cryptographic boundary: the
SEAL identity is derived per owner, so one derived key decrypts every namespace
that owner has.

This proposal makes namespace a real, enforceable access boundary for
delegates. It has two parts that must ship together to deliver the security
guarantee:

1. **Namespaced SEAL identity** (SDK/relayer): encrypt under
   `id = [package_id][bcs(owner)][namespace]` instead of per owner, so each
   namespace derives a distinct key.
2. **On-chain delegate scope + binding check** (Move): an allow-list of
   namespaces per delegate, stored as a dynamic field on the `MemWalAccount`
   `UID`, enforced by a new `seal_approve_namespaced` entry function that also
   binds the requested namespace to the SEAL identity so it cannot be spoofed.

The Move part changes no struct or event layouts (same dynamic-field pattern
the module already uses for versioning) and can merge first, but it is inert
until the SDK adopts namespaced identities. Delegates with no scope keep the
current all-access behaviour. Legacy blobs encrypted under the per-owner
identity continue to use the existing `seal_approve` path unchanged.

---

## Problem

Every `DelegateKey` today is an all-or-nothing pass. One key grants full
decryption access to every namespace on a `MemWalAccount`, for the lifetime of
the key. This is fine for a single user with a single trusted agent. It becomes
a meaningful security gap the moment an account has more than one agent or more
than one application.

### Concrete failures

| Scenario                                                                                    | What happens today                                                                             | What should happen                                       |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| User has `work`, `personal`, `financials` namespaces. Grants a coding agent a delegate key. | The coding agent can decrypt blobs from `financials` and `personal`.                           | The coding agent should only see `work`.                 |
| App A (noter) and App B (researcher) both connect to the same account.                      | Both apps share a key, or get separate full-access keys, and can read each other's namespaces. | Each app gets a key scoped to its own namespaces.        |
| A CI/CD pipeline needs access to `config` and `deployment-logs`.                            | The pipeline key also unlocks `secrets`.                                                       | Scoped to `["config", "deployment-logs"]` only.          |
| A team shares one account. Member A owns `frontend`. Member B owns `backend`.               | Giving B a key exposes A's namespace.                                                          | Strict compartmentalisation, enforced cryptographically. |

This is a violation of **least-privilege**, a foundational security principle
that today has no enforcement path below the relayer in MemWal.

---

## Background: how decryption authorization works today

Two facts from the current `memwal::account` module and the SEAL model
determine the design.

**1. The SEAL identity is per owner, not per namespace.** SEAL is
identity-based encryption: a key server derives a private key from the identity
string `id`, and that one key decrypts everything encrypted under that `id`.
MemWal builds the identity as:

```move
/// Key ID format: [package_id][bcs::to_bytes(owner_address)]
public fun seal_key_id(owner: address): vector<u8> {
    sui::bcs::to_bytes(&owner)
}
```

There is no namespace component. `seal_approve` confirms this: it authorizes
by checking the identity ends with the owner address and the caller is the
owner or a registered delegate.

```move
let owner_bytes = sui::bcs::to_bytes(&account.owner);
let is_owner = (caller == account.owner) && has_suffix(&id, &owner_bytes);
let is_delegate = is_delegate_address(account, caller);
assert!(is_owner || is_delegate, ENoAccess);
```

**2. Namespace separation today is a relayer concern.** Per the MemWal docs,
the relayer searches by `owner + namespace` in PostgreSQL. That keeps recall
results scoped, but it is application-level filtering, not a property of the
ciphertext. Any holder of the per-owner SEAL key can decrypt any namespace.

**Consequence:** a delegate scope check alone (without changing the identity)
cannot be cryptographic. If the relayer keeps encrypting under the per-owner
identity, a scoped delegate that is granted any one namespace still obtains the
per-owner key and can decrypt the rest. The identity has to carry the namespace
for isolation to be real. That is part 1 of this proposal.

---

## Design constraint: Sui upgrade compatibility

The obvious on-chain design, adding a `namespace_scope` field to `DelegateKey`,
is **not possible**: Sui package upgrades freeze struct and event layouts after
publish. The module already documents and works around this for versioning:

> Adding a `version: u64` field to the structs after publish is impossible in
> Sui Move, so dynamic fields are used.

This proposal follows the same pattern: delegate scope lives in a dynamic field
on the account's `UID`, keyed by the delegate's Sui address. Zero layout
changes, zero migration, and legacy objects behave identically.

---

## Proposed change

### Part 1: Namespaced SEAL identity (SDK/relayer)

Encrypt blobs under an identity that includes the namespace:

```
id = [package_id][bcs(owner)][utf8(namespace)]
```

A matching on-chain helper lets clients construct it consistently (the
`package_id` prefix is added by the SEAL SDK, exactly as for `seal_key_id`):

```move
/// Compute the namespaced SEAL key id for encryption.
/// Layout: bcs(owner) || namespace_bytes (package id prefix added by SEAL SDK).
public fun seal_key_id_namespaced(owner: address, namespace: String): vector<u8> {
    let mut id = sui::bcs::to_bytes(&owner);
    id.append(*namespace.as_bytes());
    id
}
```

Because each namespace yields a distinct identity, the key server derives a
**distinct private key per namespace**. A delegate that can only obtain the key
for `work` literally cannot derive the key for `financials`. This is what turns
namespace into a cryptographic boundary. It is forward-only: blobs already
encrypted under the per-owner identity keep using `seal_approve` and are not
retroactively isolated (re-encryption would be required for that).

### Part 2: On-chain delegate scope and binding check (Move)

#### 2.1 Dynamic field key for delegate scopes

```move
/// Dynamic field key: namespace scope for one delegate address.
/// Stored on the MemWalAccount UID. Absent means the delegate is unrestricted
/// (current behaviour for all existing keys).
public struct NamespaceScopeKey has copy, drop, store {
    delegate: address,
}
```

#### 2.2 New error codes

```move
/// Delegate key is not authorised for the requested namespace.
const ENamespaceNotAllowed: u64 = 12;
/// Requested namespace is not bound to the provided SEAL identity.
const ENamespaceMismatch: u64 = 13;
```

(12 and 13 are the next free slots; 0-11 are in use, 100 is reserved for
`ENoAccess`.)

#### 2.3 New entry function: `set_delegate_namespace_scope`

Owner-only. Sets or replaces the allow-list for an existing delegate.

```move
/// Restrict a delegate to the given namespaces.
/// Replaces any existing scope for that delegate.
/// Owner-only. The delegate must already be registered.
entry fun set_delegate_namespace_scope(
    account:   &mut MemWalAccount,
    delegate:  address,
    namespaces: vector<String>,
    ctx:       &TxContext,
) {
    assert_object_version(&account.id);
    assert!(account.owner == ctx.sender(), ENotOwner);
    assert!(account.active, EAccountDeactivated);
    assert!(is_delegate_address(account, delegate), EDelegateKeyNotFound);

    let key = NamespaceScopeKey { delegate };
    if (df::exists_with_type<NamespaceScopeKey, vector<String>>(&account.id, key)) {
        let scope = df::borrow_mut<NamespaceScopeKey, vector<String>>(&mut account.id, key);
        *scope = namespaces;
    } else {
        df::add(&mut account.id, key, namespaces);
    };

    event::emit(DelegateNamespaceScopeSet {
        account_id: object::id(account),
        delegate,
        namespaces,
    });
}
```

#### 2.4 New entry function: `clear_delegate_namespace_scope`

Owner-only. Returns a delegate to unrestricted access. Allowed while the
account is deactivated (mirrors `remove_delegate_key`'s rationale: owners must
be able to manage access after freezing).

```move
entry fun clear_delegate_namespace_scope(
    account:  &mut MemWalAccount,
    delegate: address,
    ctx:      &TxContext,
) {
    assert_object_version(&account.id);
    assert!(account.owner == ctx.sender(), ENotOwner);

    let key = NamespaceScopeKey { delegate };
    if (df::exists_with_type<NamespaceScopeKey, vector<String>>(&account.id, key)) {
        let _: vector<String> = df::remove(&mut account.id, key);
        event::emit(DelegateNamespaceScopeCleared {
            account_id: object::id(account),
            delegate,
        });
    };
}
```

#### 2.5 New entry function: `seal_approve_namespaced`

The namespace-aware SEAL policy. Relayers call this for blobs encrypted under a
namespaced identity. It does two things the plain `seal_approve` cannot:

- **Binds** the `namespace` argument to the SEAL identity, so it cannot be
  spoofed. A caller cannot claim namespace `work` for a blob whose key id was
  derived under `financials`, because the identity it must submit (to receive
  the right key) ends with the `financials` bytes and fails the suffix check.
- **Enforces** the delegate's namespace allow-list.

```move
/// SEAL policy with namespace binding and delegate scope enforcement.
///
/// Identity layout: [package_id][bcs(owner)][namespace_bytes].
/// The package_id prefix is added by the SEAL SDK; on-chain we verify the
/// identity ends with bcs(owner) followed by the namespace bytes. This binds
/// the requested namespace to the key id and makes it non-spoofable.
///
/// Owner is unrestricted across namespaces. A delegate must be registered and,
/// if a scope is set, the requested namespace must be in it. A delegate with no
/// scope is unrestricted (identical to today's behaviour).
entry fun seal_approve_namespaced(
    id:        vector<u8>,
    namespace: String,
    account:   &MemWalAccount,
    ctx:       &TxContext,
) {
    assert_object_version(&account.id);
    assert!(account.active, EAccountDeactivated);

    // Bind namespace to the identity: id must end with bcs(owner) || namespace.
    let mut expected = sui::bcs::to_bytes(&account.owner);
    expected.append(*namespace.as_bytes());
    assert!(has_suffix(&id, &expected), ENamespaceMismatch);

    let caller = ctx.sender();

    // Owner is unrestricted across namespaces.
    if (caller == account.owner) return;

    // Caller must be a registered delegate.
    assert!(is_delegate_address(account, caller), ENoAccess);

    // Namespace scope check: only if a scope is set for this delegate.
    let key = NamespaceScopeKey { delegate: caller };
    if (df::exists_with_type<NamespaceScopeKey, vector<String>>(&account.id, key)) {
        let scopes = df::borrow<NamespaceScopeKey, vector<String>>(&account.id, key);
        let mut allowed = false;
        let mut i = 0;
        while (i < scopes.length()) {
            if (&scopes[i] == &namespace) { allowed = true; break };
            i = i + 1;
        };
        assert!(allowed, ENamespaceNotAllowed);
    };
}
```

#### 2.6 New events

New event structs (existing `DelegateKeyAdded` is untouched, event layouts are
frozen by the upgrade rules, same as structs):

```move
public struct DelegateNamespaceScopeSet has copy, drop {
    account_id: ID,
    delegate:   address,
    namespaces: vector<String>,
}

public struct DelegateNamespaceScopeCleared has copy, drop {
    account_id: ID,
    delegate:   address,
}
```

#### 2.7 Cleanup in `remove_delegate_key`

Function bodies may change in upgrades (only signatures and layouts are
frozen), so `remove_delegate_key` gains three lines: after removing the key,
drop any scope dynamic field for that delegate. This prevents a stale scope
from silently applying if the same address is later re-added with different
intent.

#### 2.8 New view function

```move
/// Get a delegate's namespace scope.
/// Returns none() if the delegate is unrestricted (or not registered).
public fun delegate_namespace_scope(
    account:  &MemWalAccount,
    delegate: address,
): Option<vector<String>> {
    let key = NamespaceScopeKey { delegate };
    if (df::exists_with_type<NamespaceScopeKey, vector<String>>(&account.id, key)) {
        option::some(*df::borrow<NamespaceScopeKey, vector<String>>(&account.id, key))
    } else {
        option::none()
    }
}
```

---

## Why both parts are required

The two parts are not independent layers of the same guarantee; the on-chain
check only bites once identities are namespaced.

| Configuration                                           | Effect                                                                                                                                                                                                                              |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Part 2 only (per-owner identity unchanged)              | `seal_approve_namespaced` cannot be used for these blobs at all: the binding assert (`id` ends with `bcs(owner)                                                                                                                     |     | namespace`) fails, because the identity has no namespace bytes. Blobs keep using `seal_approve`, and namespace remains a relayer-only boundary. No cryptographic change. |
| Part 1 only (namespaced identity, plain `seal_approve`) | Each namespace has a distinct key, but `seal_approve` does not check scope, so any registered delegate can still request any namespace's key. Isolation depends entirely on the relayer.                                            |
| Part 1 + Part 2 (this proposal)                         | Distinct key per namespace, the namespace is bound to the identity (non-spoofable), and the delegate's allow-list is enforced on-chain. A scoped delegate can only obtain keys for its namespaces. This is cryptographic isolation. |

This is why the proposal asks for both, and is explicit that the Move PR is
inert until the SDK adopts namespaced identities.

---

## SDK / relayer changes required (Part 1)

1. **Encryption:** build the SEAL identity with `seal_key_id_namespaced(owner, namespace)`
   instead of `seal_key_id(owner)` when storing a blob under a namespace.
2. **Decryption / recall:** when requesting keys, call `seal_approve_namespaced(id, namespace, account)`
   for namespaced blobs, passing the namespace the blob was stored under.
3. **Fallback:** blobs encrypted under the legacy per-owner identity keep using
   `seal_approve`. The relayer can detect which path to use from stored metadata
   (it already records the namespace per blob).

We are happy to contribute this change alongside the Move PR.

---

## Backwards compatibility

| Existing behaviour                             | After this change                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------------------- |
| `DelegateKey` / `MemWalAccount` struct layouts | Untouched, scope lives in a dynamic field                                       |
| `seal_key_id(owner)` and per-owner encryption  | Unchanged, still used for existing blobs                                        |
| `add_delegate_key(...)`                        | Unchanged, new keys are unrestricted until a scope is set                       |
| `seal_approve(...)`                            | Unchanged, used for legacy per-owner blobs                                      |
| `DelegateKeyAdded` event                       | Unchanged, scoping emits its own events                                         |
| Existing `DelegateKey` entries on-chain        | Unaffected, no scope dynamic field exists for them, so they remain unrestricted |
| Existing blobs (per-owner identity)            | Unaffected, no re-encryption, decrypt via `seal_approve` as before              |

New capability is opt-in end to end:

- The SDK/relayer encrypts new blobs under namespaced identities.
- Owners call `set_delegate_namespace_scope` to restrict a delegate.
- Relayers call `seal_approve_namespaced` for namespaced blobs.
- Unscoped delegates and legacy blobs continue using the existing paths.

---

## Enforcement model

```
Namespaced blob (encrypted under id = [pkg][bcs(owner)][namespace]):
  relayer calls seal_approve_namespaced(id, namespace, account)
    1. assert id ends with bcs(owner) || namespace   -> ENamespaceMismatch
       (namespace is bound to the identity, cannot be spoofed)
    2. owner -> allowed (unrestricted across namespaces)
    3. delegate -> must be registered                -> ENoAccess
    4. if scope set, namespace must be in it          -> ENamespaceNotAllowed
  key server releases the namespace-specific key only if all checks pass.
  That key decrypts only blobs in this namespace, because each namespace
  has a distinct identity and thus a distinct derived key.

Legacy blob (encrypted under id = [pkg][bcs(owner)]):
  relayer calls seal_approve(id, account) as today
  no namespace check, behaviour unchanged.
```

For blobs encrypted under namespaced identities, namespace enforcement is
cryptographic: the scope check gates which keys a delegate can obtain, and the
per-namespace identity ensures an obtained key cannot decrypt other namespaces.
For legacy per-owner blobs, namespace remains a relayer-level boundary (the
status quo); making them cryptographic would require re-encryption.

---

## Test cases

```move
// Binding
#[test]
fun test_namespace_must_match_identity() { ... }            // expects ENamespaceMismatch
#[test]
fun test_cannot_spoof_namespace_for_other_blob() { ... }    // expects ENamespaceMismatch

// Scope enforcement
#[test]
fun test_scoped_delegate_allows_matching_namespace() { ... }
#[test]
fun test_scoped_delegate_denies_other_namespace() { ... }   // expects ENamespaceNotAllowed
#[test]
fun test_unscoped_delegate_allows_any_namespace() { ... }
#[test]
fun test_owner_always_passes_namespace_check() { ... }

// Scope management
#[test]
fun test_set_scope_requires_owner() { ... }                 // expects ENotOwner
#[test]
fun test_set_scope_requires_registered_delegate() { ... }   // expects EDelegateKeyNotFound
#[test]
fun test_set_scope_replaces_existing_scope() { ... }
#[test]
fun test_clear_scope_restores_unrestricted_access() { ... }
#[test]
fun test_remove_delegate_key_drops_stale_scope() { ... }

// Legacy path
#[test]
fun test_seal_approve_unchanged_for_legacy_path() { ... }
```

---

## Context: why this matters for MemForks

[MemForks](https://github.com/memforks-dev/memforks) builds a git-like commit graph
on top of MemWal. Branches are separate memory namespaces. Agents get a
`DelegateCap` scoped to one branch, but that scoping is currently enforced only
in the MemForks Move contract, not at the MemWal/SEAL layer. A delegate with a
leaked key could decrypt blobs from any branch, because all branches share the
per-owner SEAL identity.

With this proposal, MemForks can scope an agent's delegate to
`["branch/hypothesis-A"]` and have the restriction enforced cryptographically,
not just logically. The same benefit applies to every multi-agent, multi-app,
or multi-tenant MemWal deployment.

---

## Scope and effort

### Move (upgrade-safe, mergeable first, inert until Part 1 ships)

| Component                                                | Change                                         | Lines |
| -------------------------------------------------------- | ---------------------------------------------- | ----- |
| `NamespaceScopeKey` struct                               | New dynamic field key                          | +3    |
| Error codes `ENamespaceNotAllowed`, `ENamespaceMismatch` | New constants                                  | +2    |
| `seal_key_id_namespaced`                                 | New helper                                     | +5    |
| `set_delegate_namespace_scope`                           | New entry function                             | +20   |
| `clear_delegate_namespace_scope`                         | New entry function                             | +12   |
| `seal_approve_namespaced`                                | New entry function                             | +28   |
| `remove_delegate_key`                                    | Drop stale scope on removal (body-only change) | +3    |
| `delegate_namespace_scope`                               | New view                                       | +8    |
| New events (2)                                           | `...ScopeSet`, `...ScopeCleared`               | +10   |
| Tests                                                    | 12 new test cases                              | ~140  |

Move production code: ~91 lines. Tests: ~140 lines. No struct/event layout
changes. A `VERSION` bump is not strictly required since no existing invariants
change (happy to bump if you prefer gating the new entry points on a fresh
version).

### SDK / relayer (Part 1, forward-only)

| Component           | Change                                                         |
| ------------------- | -------------------------------------------------------------- |
| Encryption          | Use `seal_key_id_namespaced(owner, namespace)` for new blobs   |
| Decryption / recall | Call `seal_approve_namespaced` for namespaced blobs            |
| Routing             | Choose namespaced vs legacy path from stored per-blob metadata |

This is the larger and more sensitive piece because it touches the encryption
path. We are happy to contribute it.

---

## Open questions for the MemWal team

1. **Identity layout.** We propose `bcs(owner) || utf8(namespace)` as the
   suffix. If you prefer a hashed or length-prefixed namespace component (to
   avoid any ambiguity between owner bytes and namespace bytes), we are happy to
   match whatever you standardise on. The binding check changes accordingly.

2. **Scope as a blocklist vs allowlist?** The proposal uses an allowlist (scope
   present = only these namespaces). A blocklist variant could be added later as
   a separate dynamic field key if there's demand.

3. **Wildcard / prefix matching?** E.g. `branch/*` matching any namespace
   starting with `branch/`. Not included here to keep the change small, could be
   a follow-on. For MemForks this would reduce one scope-update per branch to a
   single prefix grant. Note this interacts with the identity layout: prefix
   matching cannot be purely cryptographic unless the prefix is itself the
   encrypted-under identity.

4. **Migration of legacy blobs.** Out of scope here (forward-only). If retroactive
   isolation is desired, a background re-encryption job could move per-owner
   blobs onto namespaced identities. Happy to discuss.

5. **Scope-at-creation convenience?** A combined `add_delegate_key_scoped(...)`
   entry (register + scope in one tx) would be a nice ergonomic addition, but
   since struct layouts are frozen it would internally do the same two writes,
   left out for minimality.

---

_We're happy to submit a PR implementing this (contract + tests, and the
SDK/relayer change) once the design direction is settled._
