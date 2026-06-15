# MemForks Vs Git

MemForks is designed to feel like Git, applied to AI agent memory instead of source code. This page maps core Git concepts to their MemForks equivalents.

## Concept Map

| Git | MemForks | Notes |
| --- | --- | --- |
| Repository (`.git/`) | `MemoryTree` | One Sui object per project or app memory root. |
| Remote | Sui + Walrus | Ownership and settlement on Sui; content on Walrus. |
| Working tree | Agent session | The current context the agent is operating with. |
| Staging area | MemWal remembered facts | Facts are available for semantic recall before merge settlement. |
| Commit | Walrus commit blob | JSON payload containing facts, parents, author, and timestamp. |
| Branch pointer | `MemoryTree` branch entry | Maps branch name to head blob. |
| `HEAD` | Local head tracker | SDK tracks live branch tips between settled operations. |
| `.git/objects/` | Walrus blob store | Content-addressed memory payloads. |
| `git log` | `memfork log` | Walk memory history from a branch head. |
| `git diff` | `memfork diff` | Semantic fact diff between branches. |
| `git checkout -b` | `memfork branch` / `client.branch()` | Creates a branch from a parent. |
| `git checkout` | `memfork checkout` | Switches default branch in local config. |
| `git clone` | `memfork join` | Onboards another developer or agent to a memory tree. |
| `git merge` | `memfork merge` / `proposeMerge()` | Opens a resolver-backed merge flow. |
| `.gitignore` | Ignored credentials | `~/.memfork/credentials.json` must never be committed. |

## Starting A Project

Git:

```bash
git init
git remote add origin git@github.com:org/repo.git
```

MemForks:

```bash
memfork init --quick
```

`init --quick` provisions the wallet, MemWal account, delegate key, and `MemoryTree`.

## Branching

Git:

```bash
git checkout -b hypothesis-redis
```

MemForks:

```bash
memfork branch hypothesis-redis --from main
memfork checkout hypothesis-redis
```

SDK:

```ts
await client.branch("hypothesis-redis", { from: "main" });
```

Like Git, branching is cheap conceptually because history is shared up to the fork point.

## Committing

Git:

```bash
git add .
git commit -m "use postgres"
```

MemForks:

```bash
memfork commit \
  --branch hypothesis-redis \
  -m "use postgres" \
  --facts "Postgres chosen for ACID guarantees"
```

SDK:

```ts
await client.commit("hypothesis-redis", {
  message: "use postgres",
  facts: ["Postgres chosen for ACID guarantees"],
});
```

MemForks commits are Walrus blobs written through MemWal. Merge settlement is where the heavier governance path appears.

## Merging

Git:

```bash
git merge hypothesis-redis
```

MemForks:

```bash
memfork merge hypothesis-redis main --resolver <resolver-id>
```

SDK:

```ts
await client.proposeMerge({
  fromBranch: "hypothesis-redis",
  intoBranch: "main",
  resolverId,
});
```

Resolvers make merge behavior explicit. A resolver can union facts, apply last-write-wins, ask a jury, or use an LLM reconciliation policy.

## Key Differences

**Commits are semantic.** Source code diffs are text-based. Memory diffs are meaning-based and recall-driven.

**Rejected branches remain useful.** Abandoned branches are still queryable, so an agent can remember why a path was rejected without teaching `main` that the rejected path is true.

**Access control is memory-native.** Delegates can be scoped by branch and permission bitmask. This is more granular than typical repository access.

**The chain is the settlement layer.** Walrus stores the content. Sui anchors ownership, branch pointers, access control, and merge governance.
