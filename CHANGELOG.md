# MemForks — Development Changelog

Internal session log. Not for public release.

---

## v0.1.49–v0.1.57 — Codex integration hardening; CLI exit fix; architecture corrections

### v0.1.57 — Architecture correction: commits are Walrus-only (no Sui tx)

**Problem:** The `memory-commit` Codex skill and `memfork install codex` summary copy
incorrectly described `memfork commit` as issuing "an on-chain transaction on Sui."

**Reality (per PRD §9.1):** `commit` is not a Move entry function. The CLI calls
`memwal.remember(payload)` which writes a structured blob to Walrus via the MemWal
relayer. No Sui transaction is issued per commit. On-chain events only occur on
`memfork branch` (creates `BranchACL`) and `memfork merge` (mints `MemoryCommit` anchor).

**Files changed:**
- `plugins/codex/plugins/memforks/skills/memory-commit/SKILL.md` — updated latency note
- `packages/cli/src/commands/install.ts` — corrected summary copy and inline comments

---

### v0.1.56 — Codex skill: wait for slow Walrus write before retrying

**Problem:** Codex's `exec_command` has a 10s default poll window. `memfork commit`
takes 20–60s (Walrus write latency). Codex saw "(no output)" at 10s, assumed the
command stalled, and retried — producing duplicate commits.

**Fix:** Added an explicit note in the `memory-commit` skill body:
> "This command writes to Walrus via the MemWal relayer. It takes 20–60 seconds —
> this is normal network latency, not a hang. Do not retry if output is slow; only
> retry on a non-zero exit or error line."

**Files changed:**
- `plugins/codex/plugins/memforks/skills/memory-commit/SKILL.md`

---

### v0.1.55 — Auto-approve `memwal_recall`; eliminate MCP approval prompts

**Problem:** With the memwal write tools disabled, the only remaining enabled tool
(`memwal_recall`) still prompted for per-call approval because `default_tools_approval_mode`
defaulted to `"prompt"`. Every recall required manual user input.

**Fix:** Added `default_tools_approval_mode = "auto"` to the `[mcp_servers.memwal]`
block written by `memfork install codex` and patched `~/.codex/config.toml` directly.
`memwal_recall`, `memwal_health`, and `memwal_restore` are read-only/diagnostic and
safe to auto-approve.

**Files changed:**
- `packages/cli/src/commands/install.ts`

---

### v0.1.54 — CLI hang fix: explicit exit after each command

**Problem:** After completing work, every `memfork` command (notably `commit`) hung
indefinitely instead of returning. The relayer and Sui RPC keep-alive sockets held
Node's event loop open. Codex interpreted this as a stuck process and retried,
producing duplicate commits after 1m+ waits.

**Root cause:** The `wrap()` helper in `cli.ts` fired the async command but never
awaited it, and the success path had no explicit exit. The process waited for the
event loop to drain, which never happened due to open sockets.

**Fix:** `wrap()` now awaits the command and calls `flushAndExit()` on resolve/reject.
`flushAndExit()` drains stdout/stderr before `process.exit()` (a zero-byte write with
callback) so piped output is never truncated in non-TTY contexts (always the case
when Codex runs the CLI as a subprocess).

`cmdUi` is unaffected — its promise only resolves on SIGINT after `server.close()`,
so exit-after-resolve is the correct behavior.

Verified live: `memfork commit` piped through `cat`, full output preserved, process
returned in ~29s (real Walrus latency), exit 0.

**Files changed:**
- `packages/cli/src/cli.ts` — `wrap()` + `flushAndExit()` helper

---

### v0.1.53 — Idempotent `memfork branch`; clear commit output in non-TTY

**Problem 1:** `memfork branch feat/auth` when the branch already existed on-chain
threw an uncaught `MoveAbort` with error code `E_BRANCH_EXISTS` (code 7, module
`memforks::tree`). Any script or runbook that re-ran the command would fail.

**Fix:** `cmdBranch` now catches `MoveAbort` matching `, 7)` and treats it as a
successful no-op, printing `"already exists — no action needed"`.

**Problem 2:** `memfork commit` output raw JSON (`{"blobId":"...","artifacts":[]}`)
when stdout was not a TTY (i.e., always when Codex ran it as a subprocess). Codex
saw `"artifacts":[]` and couldn't recognize success, triggering retries.

**Fix:** The human-readable `✓ Committed to <branch>` line now prints unconditionally
in both TTY and non-TTY contexts. JSON is additionally emitted in non-TTY for machine
consumption.

**Files changed:**
- `packages/cli/src/commands/ops.ts` — `cmdBranch`, `cmdCommit`

---

### v0.1.52 — Enforce all memory writes through `memfork commit`; revert skills-path regression

**Core change:** Disabled the raw MemWal write tools in Codex so the agent cannot
bypass the on-chain-anchored DAG. `memfork commit` becomes the only persistence path.

**Why this matters for the demo and for judges:** The raw `memwal_remember` tool's
own description says "call this PROACTIVELY whenever you learn something worth
remembering" — actively competing with the `memory-commit` skill every turn. With the
raw tools present, the model routed to them ~50% of the time, producing unanchored
memories in `namespace=default` with no branch scoping, silently contradicting
MemForks' core value proposition. Disabling them makes the guarantee literal and
verifiable: every saved memory is anchored on Sui.

**`memfork install codex` now writes:**
```toml
[mcp_servers.memwal]
url = "..."
http_headers = { ... }
disabled_tools = ["memwal_remember", "memwal_remember_bulk", "memwal_analyze"]
```

**Also:** Fixed `upsertCodexMcp`'s block-replacement regex which stopped at the first
`[`, corrupting the TOML on reinstall when `disabled_tools = [...]` was present.
Replaced with a table-boundary-aware multiline regex.

**Also:** Reverted the `"../skills/"` path introduced in v0.1.51. Per Codex plugin
docs, `plugin.json` paths resolve relative to the plugin root (not `.codex-plugin/`),
so `"./skills/"` was correct all along. The v0.1.51 change pointed at `plugins/skills/`
which doesn't exist.

**Docs updated:**
- `memory-commit` skill body — dropped "use `memwal_remember` for transient notes" guidance
- `plugins/cursor/rules/memforks.mdc` and `.cursor/rules/memforks.mdc` — same

**Files changed:**
- `packages/cli/src/commands/install.ts`
- `plugins/codex/plugins/memforks/skills/memory-commit/SKILL.md`
- `plugins/codex/plugins/memforks/.codex-plugin/plugin.json`
- `plugins/cursor/rules/memforks.mdc`
- `.cursor/rules/memforks.mdc`

---

### v0.1.51 — Fix Codex plugin skills path *(regressed in this release, fixed in v0.1.52)*

**Problem:** `plugin.json` had `"skills": "./skills/"`. This resolved relative to
`.codex-plugin/` (where `plugin.json` lives), looking for `.codex-plugin/skills/` which
doesn't exist. Codex loaded the plugin but found zero skills, so `memwal_remember` was
always called instead of `memfork commit`.

**Note:** The fix (`"../skills/"`) was itself incorrect per the Codex plugin spec and
was reverted in v0.1.52. The correct value `"./skills/"` resolves relative to the
plugin root.

**Root cause of the original issue:** Skills are behind a `[features] skills = true`
feature flag in `~/.codex/config.toml` that was not being set. Added by `flushAndExit`
session. The feature flag enables user-level skills in `~/.codex/skills/`; plugin-bundled
skills load via a separate path but the flag also needs to be present.

---

### v0.1.50 — Author display name for commits

**Problem:** The visualizer's commit inspector showed a raw Sui signer address
(`0x89e127bd…`) for the author field. No tool chip (e.g., "Codex" or "Cursor") was
shown either.

**Resolution chain (highest to lowest priority):**
1. `--author <name>` CLI flag
2. `MEMFORK_AUTHOR` environment variable
3. `author` field in `.memfork/config.json`
4. `git config user.name`

**Changes across the stack:**
- `CommitPayload` in `packages/core/src/types.ts` — added `author_name?: string` and `tool?: string`
- `MemForksClient.commit()` — accepts and stores `authorName` and `tool` in the payload
- `memfork commit` CLI — added `--tool <tool>` and `--author <name>` flags
- `packages/cli/src/branch.ts` — added `gitUserName()` and `resolveAuthor()` functions
- `packages/cli/src/commands/ui-server.ts` `/api/history` — extracts `author_name`
  (falls back to base64-decoded signer address hex) and `tool` from payload for the visualizer

---

### v0.1.49 — Visualizer: memory-tab drawer click; correct MemWal namespace

**Problem 1:** Clicking a fact in the Memory tab of the visualizer did not open the
commit inspector drawer. `handleFactClick` was trying to match a blobId against
`MergeAnchor` records, which never matched for off-chain commits.

**Fix:** `MemoryView.tsx` now checks `offChainCommits.get(blobId)` first and calls
`openCommit()`, falling back to the merge anchor lookup only if that misses.

**Problem 2:** Cursor and Codex agents were calling `memwal_recall` with
`namespace="branch/<current-branch>"` (e.g., `"branch/feat/auth"`), which matched
nothing. The correct format is `memforks/<treeId>/<branch>` (e.g.,
`"memforks/3c23e9fa…/feat/auth"`).

**Fix:** Added `memfork namespace [branch]` CLI command that prints the correct
MemWal namespace string for the current (or specified) branch. Updated:
- `plugins/cursor/rules/memforks.mdc`
- `plugins/codex/plugins/memforks/skills/memory-recall/SKILL.md`
- `plugins/codex/plugins/memforks/README.md`

All three now instruct agents to call `memfork namespace` and pass the result as the
`namespace` argument to `memwal_recall`.

---

## v0.1.38 — memory-fork skill: implicit decision detection

### Plugin: `memory-fork` skill + Cursor/Codex fork rules

**Problem:** the fork skill only triggered on explicit feature-naming phrases
("explore both paths", "compare A vs B"). Prompts that used that exact wording
looked staged on camera — a technically literate judge could see the seam
between "feature being triggered" and "agent acting naturally."

**Change:** the skill now also triggers on **implicit decision questions**
where the agent itself identifies two credible, competing approaches:

- Before: required the user to say "explore both paths" or similar.
- After: also fires when the user asks an open question like "What's the
  fastest way to cut our auth latency?" — the agent identifies the two
  alternatives (e.g. Redis caching vs. bcrypt cost tuning) and forks on
  its own.

**Announce output updated** to reflect that the agent made the decision, not
the user:

```
[memforks] Two viable approaches detected — Redis caching vs. bcrypt cost.
[memforks] Branching memory so each can be tested without contamination.
[memforks] Forking from main@HEAD
```

**Guard added:** the skill explicitly says *not* to fork when there is one
sensible approach, the question is rhetorical, or alternatives are trivial
variations — preventing over-forking on ordinary questions.

**Files changed:**
- `plugins/codex/skills/memory-fork/SKILL.md`
- `plugins/cursor/rules/memforks.mdc`
- `.cursor/rules/memforks.mdc` (installed copy in this repo)

**Cleanup:** removed `tests/cli/.codex-plugin/` and `tests/cli/.cursor/` —
stale committed artifacts from an old `memfork install` run inside the tests
directory. Tests install into a `tmpDir` and never referenced these files.

---

## Session: Hackathon sprint — README, artifact storage, visualizer, tests

### README & project communication

- Added a full hierarchical **Table of Contents** to README.md.
- Added a "**Built with MemForks**" showcase section featuring [AlgoLore](https://github.com/0xTemplar/alpaca-trading-agent) — a community-built daytrading research lab with three competing ORB strategies on their own MemForks branches.
- Updated the `memfork init --quick` walkthrough to mention the MemForks drip (not a generic testnet faucet), and fixed the on-chain package ID table to link both testnet and mainnet package IDs to SuiScan.
- Corrected the TOC grouping style to use indented sub-headers with quittance-style nesting.
- Cleaned up phrasing, removed em dashes throughout.
- Added references to [`research/SPEC.md`](research/SPEC.md), [`docs/git-comparison.md`](docs/git-comparison.md), and the new architecture docs.
- Added a **What's next** roadmap section covering: self-hosted MemWal relayer, per-branch cryptographic isolation, CrewAI adapter, cross-tree references, Vercel AI SDK v5 support, `memfork blame`.
- Clarified the status of CLI time-travel (`memfork checkout --at` ships) and `memfork blame` (planned).

---

### Artifact storage — design and full-stack implementation

**Motivation:** The [Walrus track problem statement](https://mystenlabs.notion.site/walrus-track-problem-statement) requires artifact-driven workflows (datasets, logs, reports stored on Walrus). MemForks commits already form a hash-chained provenance graph; the natural extension is to let commits _reference_ Walrus artifact blobs so produced files inherit the same audit trail.

**Key design decision:** Artifacts are opt-in and user-funded. Every project funds its own Walrus storage (WAL tokens for blob cost + SUI for gas). This is controlled by a new `artifacts` config block in `.memfork/config.json`. The default is `enabled: false` so existing users are not affected.

**New type: `ArtifactRef`** (`packages/core/src/types.ts`):
```ts
interface ArtifactRef {
  path:    string;   // original file path at commit time
  blobId:  string;   // Walrus blob ID
  sha256:  string;   // hex digest for integrity
  size:    number;   // bytes
  mime?:   string;
  epochs?: number;   // Walrus storage epochs
}
```
`CommitDelta` now carries `artifacts?: ArtifactRef[]`. `CommitEntry` exposes `artifacts: ArtifactRef[]` in history.

**New module: `packages/core/src/artifacts.ts`:**
- `ArtifactConfig` + `DEFAULT_ARTIFACT_CONFIG` (`enabled: false`, `epochs: 12`, `maxBytes: 10 MiB`)
- `ArtifactStorageError` — custom error class with a `.reason` code (15 codes: `disabled`, `too_large`, `empty_file`, `invalid_path`, `insufficient_wal`, `insufficient_sui`, `epoch_change`, `not_enough_confirmations`, `network`, `rate_limit`, `blob_blocked`, `corrupted`, `not_found`, `integrity`, `unknown`)
- `putArtifact()` — pre-flight guards (disabled, empty, too large, invalid path) → SHA-256 hash → upload via `@mysten/walrus` SDK with up to 3 auto-retries on epoch-boundary errors → returns `ArtifactRef`
- `getArtifact()` — fetch from public Walrus HTTP aggregator (free, no auth) → optional SHA-256 integrity check → retries 404 twice for CDN lag → clear errors on 451 (legally blocked)
- `classifyWriteError()` — maps raw SDK errors (`BehindCurrentEpochError`, `RetryableWalrusClientError`, `NotEnoughBlobConfirmationsError`, `ConnectionError`, `RateLimitError`, `BlobBlockedError`, `InconsistentBlobError`, `WalrusInternalServerError`) and parses generic Sui transaction failure messages to detect `insufficient_wal` / `insufficient_sui` with actionable user guidance
- Walrus client caching per `(network, uploadRelayUrl)` key — avoids repeated WASM initialization across artifact uploads in the same session; evicts cache on retryable errors

**SDK integration (`packages/core/src/client.ts`):**
- `MemForksClientConfig` accepts `artifacts?: Partial<ArtifactConfig>`
- `MemForksClient.commit()` accepts `artifacts?: Array<{ path, bytes, mime?, epochs? }>` — uploads each file to Walrus before constructing the payload, with batch-level error context (which artifacts already succeeded and which did not) to warn about unreferenced blobs
- `history()` extracts `delta.artifacts` into `CommitEntry.artifacts`
- `MemForksClient.artifactConfig` exposed for downstream consumers

**CLI integration (`packages/cli/`):**
- `config.ts` — `ProjectConfig` + `ResolvedConfig` include `artifacts`; parses env vars `MEMFORK_ARTIFACTS_ENABLED`, `MEMFORK_ARTIFACTS_EPOCHS`, `MEMFORK_ARTIFACTS_MAX_BYTES`, `MEMFORK_ARTIFACTS_UPLOAD_RELAY_URL`
- `ops.ts` — `memfork commit` accepts `--file <path>` (repeatable) and `--epochs <n>`; TTY output includes blob ID, SHA-256 digest (truncated), file size, and the retrieval command
- `ops.ts` — new `memfork cat <blobId>` command: fetches artifact from Walrus, optionally saves to `--output <path>`, supports `--sha256 <hex>` for integrity verification, `--network <name>` override; handles `ArtifactStorageError` per reason code for clear messages
- `cli.ts` — wired both commands into the Commander tree
- `doctor.ts` — added WAL balance check (check #8): detects the correct WAL coin type (`0x356a26eb9...::wal::WAL`, same for mainnet and testnet), warns with actionable advice if balance is low

**Reference app (`apps/memforks-research/src/research.ts`):**
- If `artifactConfig.enabled`, the supervisor stage uploads the final Markdown report to Walrus via `putArtifact()` and records the `ArtifactRef` in a commit on the supervisor branch via `delta: { artifacts: [ref] }`. Prints the `memfork cat` retrieval command with `--sha256` for verification. Wrapped in `try/catch` to prevent artifact failures from stopping the research pipeline.

**New architecture doc (`docs/architecture/artifacts.md`):**
- Motivation, memory vs artifact distinction, `ArtifactRef` data model, write/read paths, encryption strategy (artifacts are plaintext — no SEAL), API surfaces (SDK + CLI), `memforks-research` integration, opt-in / user-funded model, provenance guarantees.

---

### Visualizer artifact integration

**`apps/visualizer/src/sui/types.ts`:**
- Added `ArtifactRef` interface (local copy of core type).
- Added `artifacts?: ArtifactRef[]` to `OffChainCommit`.

**`packages/cli/src/commands/ui-server.ts`:**
- `/api/history` now extracts `delta.artifacts` from the commit payload and includes it in the response when present, so the browser receives artifact metadata without re-parsing the encrypted blob.

**`apps/visualizer/src/views/history/HistoryView.tsx`:**
- `CommitRow` shows a `📎 N` chip badge on any commit that has attached artifacts, with a tooltip listing the count.

**`apps/visualizer/src/drawers/OffChainCommitInspector.tsx`:**
- Added an "Artifacts" section that renders before the Blob ID section. Each artifact shows: original file path, file size, MIME type, a copy-to-clipboard button for the blob ID, and a live "↗ view" link to the network-correct Walrus aggregator (via `getWalrusBlobBase()`). Footer distinguishes artifact blobs ("Plaintext · stored on Walrus · public read") from the SEAL-encrypted memory blob above.

---

### Tests

`tests/cli/test-artifacts.mjs` — 41 tests across 10 `describe` blocks:

| Group | Coverage |
|-------|----------|
| `ArtifactStorageError` | Constructor, name, all 15 reason codes, default reason, throw/catch |
| `DEFAULT_ARTIFACT_CONFIG` | All fields: enabled, epochs, maxBytes, uploadRelayUrl |
| `artifactSha256` | Empty digest, determinism, distinctness, hex format, known vector |
| `putArtifact — guard: disabled` | Throws `disabled`, message mentions config path |
| `putArtifact — guard: empty_file` | Throws `empty_file`, message names the file |
| `putArtifact — guard: too_large` | Throws `too_large`, exact-at-limit passes, message shows MiB |
| `putArtifact — guard: invalid_path` | Empty, null byte, 256-char; 255-char passes |
| `putArtifact — guard priority` | `disabled` before `empty_file`; `empty_file` before `too_large` |
| `getArtifact — HTTP responses` | 200 no-verify, 200 with sha256, integrity mismatch, 404×3 retry, 451, 503, fetch throws, testnet/mainnet URL, empty sha256, Uint8Array return type |
| `ArtifactRef shape` | sha256 is 64-char hex; config has all required fields |

Added `test:artifacts` script to `tests/cli/package.json` and included it in `test:unit` and the default `test` run.

**Total unit tests:** 201 (up from 160 before this session), all passing.
