# MemForks vs Git — A Direct Comparison

MemForks is designed to feel like git, applied to AI agent memory instead of source code.
This doc maps every core git concept to its MemForks equivalent, so you can build an
accurate mental model quickly.

---

## Core concept map

| Git | MemForks | Notes |
|-----|----------|-------|
| Repository (`.git/`) | `MemoryTree` | One Sui object per project. Owned by a wallet address. |
| Remote (GitHub, GitLab) | Sui + Walrus | On-chain ownership; blobs on Walrus. No separate hosting needed. |
| Working tree | Agent session | What the agent currently knows / has in context. |
| Staging area (`git add`) | `memwal_remember()` | Facts go into MemWal before they're committed. |
| Commit (`git commit`) | Off-chain Walrus blob | A JSON payload with `facts`, `parent_blob_ids`, `author`, `ts_ms`. No Sui tx per commit. |
| Merge commit | `MemoryCommit` (on-chain) | The only time a Sui object is minted. Settles which blobs won. |
| Branch pointer | Entry in `MemoryTree.branches` | `Table<String, blob_id>`. Points to the latest settled Walrus blob. |
| `HEAD` | Local head tracker | SDK in-memory `Map<branch, blob_id>`. Ahead of the on-chain pointer between merges. |
| `.git/objects/` | Walrus blob store | Content-addressed. Each commit blob references parent blob IDs (hash chain). |
| `git log` | `memfork log` | Walks the MemWal blob chain from the branch head backwards. |
| `git diff` | `memfork diff` | Semantic fact diff between two branches. |
| `git checkout -b` | `memfork branch` / `client.branch()` | Creates a branch on-chain (one Sui tx). Pointer write — no data is copied. |
| `git checkout` | `memfork checkout` *(coming soon)* | Switches the active branch in config. |
| `git clone` | `memfork join` *(coming soon)* | New team member links their machine to an existing tree. |
| `git push / pull` | Not needed | All state lives in Walrus + Sui. Any machine with credentials can read/write. |
| `git merge` | `memfork merge` | Opens a `MergeProposal` on-chain. A typed resolver (jury, LLM, etc.) settles it. |
| `git rebase` | Not supported | The DAG is append-only and immutable. Abandoned branches stay queryable. |
| `.gitignore` | `~/.memfork/credentials.json` is ignored | `memfork init` patches `.gitignore` automatically. |
| `git config` | `.memfork/config.json` + `~/.memfork/credentials.json` | Project config is committed; secrets stay on-machine. |
| SSH key / PAT | MemWal delegate key (`memwalKey`) | Required for encrypting/decrypting branch memory content. |
| GitHub access token | Sui private key (`privateKey`) | Required for on-chain operations (branching, merging). |
| GitHub org member | `DelegateCap` on the `MemoryTree` | Granted by the tree owner with `memfork grant`. Scoped by branch and permission bitmask. |
| `git blame` | `memfork blame` *(coming soon)* | Which commit introduced a given fact, and who authored it. |

---

## Workflow comparison

### Starting a new project

**Git:**
```bash
git init
git remote add origin git@github.com:org/repo.git
```

**MemForks:**
```bash
memfork init --quick   # keygen → faucet → MemWal account → tree (~30s, fully automated)
```

---

### Onboarding a teammate

**Git:**
```bash
# Teammate clones
git clone git@github.com:org/repo.git

# You add them on GitHub
# Done — they have full access immediately
```

**MemForks:**
```bash
# Teammate clones repo (.memfork/config.json is already there)
memfork join           # generates their delegate key, prints the grant command

# You run (on your machine):
memfork grant --agent <their-address> --perms read,write,fork,propose

# Teammate confirms:
memfork doctor
```

The extra step is because memory is encrypted. GitHub can give file access to anyone; MemForks memory is SEAL-encrypted — only registered delegates can decrypt. The grant registers them on-chain as an authorized decryptor.

---

### Creating a branch

**Git:**
```bash
git checkout -b hypothesis-redis
```

**MemForks:**
```bash
memfork branch hypothesis-redis    # from current branch
# or from a specific source:
memfork branch hypothesis-redis main
```

Under the hood this is one Sui transaction — it adds an entry to `MemoryTree.branches`. No memory is copied; history is shared up to the fork point, just like git.

---

### Committing

**Git:**
```bash
git add .
git commit -m "use AppError for consistency"
```

**MemForks** (agent does this automatically via MCP):
```bash
# Manual:
memfork commit -m "use AppError for consistency" \
  --facts "always use AppError wrapper for HTTP errors"
```

The key difference: **no Sui transaction per commit**. Each commit is a Walrus blob written through MemWal. Gas is only spent when a merge finalizes. This is the Model A architecture — "commit local, settle on merge."

---

### Merging

**Git:**
```bash
git merge hypothesis-redis
# If conflicts: resolve manually, git add, git commit
```

**MemForks:**
```bash
memfork merge hypothesis-redis main --resolver <resolver-id>
```

MemForks merges are typed and programmatic. You specify a resolver upfront — `LastWriteWins`, `Union`, `JuryReconcile(k=2, n=3)`, `LlmReconcile`, or composed combinations. The resolver runs off-chain (jury members sign attestations, LLM synthesizes), the contract verifies attestations, and `finalize_merge` mints an on-chain `MemoryCommit` as a permanent settlement record.

There is no manual conflict resolution. Conflicts are handled by the resolver logic.

---

### Viewing history

**Git:**
```bash
git log --oneline
git log --all --graph
```

**MemForks:**
```bash
memfork log                    # current branch
memfork log --branch main
memfork ui                     # DAG visualizer in browser (all branches, live)
```

---

### Reverting / time travel

**Git:**
```bash
git checkout abc123            # detach HEAD to old commit
git checkout -b recovery abc123   # branch from old commit
```

**MemForks:**
```bash
# Not yet a CLI command — available in the UI visualizer:
# Click any commit → "Checkout" → "Branch from here"
# SDK:
await mem.checkout(commitBlobId)   # returns historical memory view
```

Abandoned branches are never deleted. Unlike git's garbage collection, every reasoning path stays permanently queryable in Walrus (within blob epoch limits).

---

## Key differences to internalize

**Commits are cheap, merges are expensive (in gas).** Git commits are local and free; pushes cost a round-trip. MemForks commits are Walrus blobs and free; merges cost Sui gas. Design your branching strategy accordingly — branch liberally, merge deliberately.

**Branches don't sync automatically.** There is no `git pull`. Any machine with valid credentials can write to the same branch. The recommended convention is one branch per agent or feature — merge is the synchronization point, not a pull.

**Rejected branches stay queryable.** When a branch loses a merge, it's not deleted. `memfork recall "why not Redis?"` on the losing branch still returns its reasoning. This is the core value over a linear memory log — you remember what you rejected, not just what you kept.

**Access is per-person, not per-repo.** In git, repo access is binary (clone or not). In MemForks, each delegate has a permission bitmask (`READ | WRITE | FORK | MERGE | PROPOSE`) and an optional branch scope. You can give an agent write access to `feat/auth` only, with no ability to merge into `main`.

**The on-chain layer is the audit trail, not the storage.** Source code lives in git objects. Agent memory lives in Walrus blobs. Sui holds the ownership model, branch pointers, and merge settlement records — the notary, not the filing cabinet.
