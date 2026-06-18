# Artifact Storage Architecture

Status: **design** (targeting v0.2). Network: **mainnet**.

This document specifies how MemForks stores and retrieves agent-produced
*artifacts* (datasets, logs, reports, intermediate files) and binds them to the
commit DAG with verifiable provenance. It is the design reference for the
implementation tracked in [What's next](../../README.md#whats-next).

---

## 1. Motivation

MemForks versions what an agent *knows* (facts/memory). Agents also *produce*
files: a research report, a CSV of trades, a generated image, a log. Today these
have nowhere to live inside the provenance trail — you can recall the reasoning
that produced a report, but not retrieve the report itself, and nothing proves
the bytes you have are the bytes that commit produced.

Goal: let a commit carry one or more artifacts so that a produced file inherits
the **same hash-chained, on-chain-anchored provenance** as the facts in that
commit, and can be retrieved by anyone with the reference.

---

## 2. Design principle: memory and artifacts take different paths

MemForks composes two storage layers with different jobs. Artifacts belong on a
different path than memory, and conflating them is the mistake to avoid.

| Concern | Layer | Why |
|---|---|---|
| **Memory** (facts, messages) | **MemWal** (Walrus Memory) | Needs SEAL encryption + semantic indexing + recall. Small text payloads. |
| **Artifacts** (files, blobs) | **Walrus directly** | Content-addressed binary blobs. No semantic indexing. Can be large. Public + verifiable by blob ID. |

Storing artifacts *through MemWal* would be wrong: MemWal SEAL-encrypts and
semantically indexes every entry, so (a) the public Walrus aggregator returns
ciphertext, not a usable file, (b) large binaries pollute the recall index, and
(c) recall round-trips inflate. The current `CommitDelta.files` field inlines
bytes into the commit payload blob and suffers all three problems; this design
replaces it.

Artifacts go **directly to Walrus** as standalone content-addressed blobs. The
commit payload stores only a *reference* (blob ID + hash + metadata). This also
strengthens the Walrus-track story: it is direct Walrus usage for persistent
file access, alongside MemWal as the memory layer.

```
            ┌──────────────────────── commit() ────────────────────────┐
            │                                                           │
 facts  ───▶│  MemWal.rememberAndWait()  ──▶  SEAL-encrypted Walrus blob │  (memory)
            │                                                           │
 files  ───▶│  WalrusClient.writeBlob()  ──▶  content-addressed blob    │  (artifact)
            │           │                                               │
            │           └─▶ ArtifactRef { blobId, sha256, … } ──┐       │
            │                                                   ▼       │
            │   commit payload.delta.artifacts[] ───────────────┘       │
            └───────────────────────────────────────────────────────────┘
                              │ payload hashed, parent-linked
                              ▼
                  branch head advances; merge anchors settle on Sui
```

---

## 3. Opt-in and funding model

Artifact storage is an **opt-in feature, disabled by default**. This keeps the
core promise intact: memory works with zero cost to the user because MemForks
gas is sponsored and MemWal handles storage. Artifacts are different — they
write standalone blobs to Walrus, which costs **WAL**, and WAL is *not*
sponsorable (the gas sponsor co-signs Sui MoveCalls to the MemForks package
only; WAL is a separate storage payment, not Sui gas). Rather than custody a WAL
pool, MemForks asks users who want artifacts to fund their own keypair.

The result reads as a deliberate capability, not a paywall: memory is free and
sponsored; if you also want produced files persisted on Walrus with provenance,
you enable artifacts and fund the keypair that already signs your commits.

### Configuration

Enabled via project config or env, off unless explicitly turned on:

```jsonc
// .memfork/config.json
{
  "artifacts": {
    "enabled": true,        // default false
    "epochs": 12,           // Walrus storage epochs (retention); default DEFAULT_ARTIFACT_EPOCHS
    "maxBytes": 10485760    // reject artifacts larger than this; default 10 MiB
  }
}
```

Env overrides (take precedence, for CI/headless): `MEMFORK_ARTIFACTS=1`,
`MEMFORK_ARTIFACTS_EPOCHS`, `MEMFORK_ARTIFACTS_MAX_BYTES`.

### Behavior when disabled

- `commit({ artifacts })`, `putArtifact()`, and `memfork commit --file` **throw a
  clear, actionable error** rather than silently dropping data:
  *"Artifact storage is disabled. Enable `artifacts.enabled` in
  `.memfork/config.json` and fund your signer keypair with WAL on mainnet."*
- Memory commits (facts) are unaffected — they never touch this path.

### Funding & diagnostics

- When enabled, the signer keypair must hold **WAL** (storage) and **SUI** (gas).
  Storage cost scales with size × epochs.
- `memfork doctor` gains a check: when artifacts are enabled, verify the signer's
  WAL balance is non-zero and warn if it looks too low for the configured epochs.

---

## 4. Data model

A new first-class reference type, stored on the commit payload (extends
`CommitPayload.delta`, SPEC §8). The existing `files` field is deprecated in
favor of `artifacts`.

```ts
// packages/core/src/types.ts
export interface ArtifactRef {
  /** Logical path/name within the commit, e.g. "report.md". */
  path: string;
  /** Walrus blob ID of the stored artifact (base64url, from Walrus). */
  blobId: string;
  /** SHA-256 of the raw artifact bytes (hex). Integrity check on read. */
  sha256: string;
  /** Size in bytes. */
  size: number;
  /** Optional MIME type, best-effort from extension. */
  mime?: string;
  /** Walrus storage epochs purchased at write time. */
  epochs?: number;
  /** True if the bytes were SEAL-encrypted before upload (default false). */
  encrypted?: boolean;
}

export interface CommitDelta {
  messages?: Array<{ role: string; content: string }>;
  facts?: string[];
  embeddings_hint?: number[];
  /** @deprecated inline bytes; use `artifacts` (referenced Walrus blobs). */
  files?: Array<{ path: string; blob: Uint8Array }>;
  artifacts?: ArtifactRef[];
}
```

`ArtifactRef` is part of the JSON commit payload, so it is itself covered by the
commit's `content_hash` and the parent hash chain. That is what gives the
artifact provenance: tampering with the bytes breaks `sha256`; tampering with
the reference breaks the commit hash chain; the chain terminates at an on-chain
merge anchor.

---

## 5. Write path

**Mainnet has no public publisher.** Per the
[Walrus docs](https://docs.wal.app/docs/http-api/storing-blobs), Walrus runs no
public unauthenticated publisher on mainnet and has no plans to. The supported
mainnet write paths are: run your own authenticated publisher, use the Upload
Relay, or **use the TypeScript SDK directly**. The `curl $PUBLISHER` HTTP flow is
testnet-only. We therefore write with the SDK directly — the only option that
needs no extra infrastructure.

Artifacts are written with the official Walrus TypeScript SDK
(`@mysten/walrus`), using the **same Sui keypair MemForks already holds**
(`this.keypair`). On mainnet this spends SUI for gas and **WAL for storage** —
the funded keypair pays directly; no separate publisher service required. For
reliability/throughput the `WalrusClient` MAY be configured with an
[Upload Relay](https://docs.wal.app/walrus-memory/relayer) so the client doesn't
fan out to every storage node itself; this is an optional optimization, not a
new dependency on a hosted service.

```ts
// packages/core/src/walrus.ts  (new)
import { WalrusClient } from '@mysten/walrus';

async putArtifact(
  bytes: Uint8Array,
  opts: { path: string; epochs?: number; mime?: string } = { path: 'artifact' },
): Promise<ArtifactRef> {
  const sha256 = await sha256Hex(bytesToString(bytes));          // integrity
  const { blobId } = await this.walrus.writeBlob({
    blob: bytes,
    epochs: opts.epochs ?? DEFAULT_ARTIFACT_EPOCHS,              // e.g. 12
    deletable: false,
    signer: this.keypair,                                        // pays WAL + gas
  });
  return {
    path: opts.path, blobId, sha256,
    size: bytes.length, mime: opts.mime, epochs: opts.epochs ?? DEFAULT_ARTIFACT_EPOCHS,
  };
}
```

`commit()` gains an optional `artifacts` input. The ordering is important:
**upload artifacts first, then write the commit** that references them. If an
upload fails the commit is never written, so the DAG never references a
nonexistent blob.

```ts
await client.commit(branch, {
  facts:   ["synthesized Q3 findings"],
  message: "research: Q3 report",
  artifacts: [{ path: "q3-report.md", bytes }],   // uploaded → ArtifactRef → payload
});
```

Funding, retention (`epochs`), and the opt-in gate are covered in §3. The
`--epochs` flag overrides the configured default per commit.

---

## 6. Read path

Reads are free. Two equivalent options; default to the public mainnet
aggregator for zero-dependency retrieval, fall back to the SDK.

```ts
async getArtifact(ref: Pick<ArtifactRef, 'blobId' | 'sha256'>): Promise<Uint8Array> {
  const res   = await fetch(`${WALRUS_AGGREGATOR_MAINNET}/v1/blobs/${ref.blobId}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got   = await sha256Hex(bytesToString(bytes));
  if (got !== ref.sha256) throw new Error('artifact integrity check failed');  // tamper-evident
  return bytes;
}
```

`WALRUS_AGGREGATOR_MAINNET = https://aggregator.walrus-mainnet.walrus.space`
(already used by the visualizer). Integrity is verified against the `sha256` in
the reference on every read.

**Read-after-write caveat.** Public aggregators are CDN-fronted and may briefly
cache a `404` from before the blob propagated. When retrieving an artifact right
after committing it (e.g. printing a `memfork cat` line at the end of a run),
retry with backoff rather than failing on the first `404`. See the Walrus
[Reading Blobs](https://docs.wal.app/docs/http-api/reading-blobs) notes.

---

## 7. Encryption

Default: **plaintext**. Artifacts are public, content-addressed, and verifiable
by anyone — the right default for reports/datasets you want to show and prove.

Optional (future): SEAL-encrypt bytes before upload (`encrypted: true` on the
ref) for private artifacts, decrypted client-side with the delegate key. Out of
scope for v0.2; the `encrypted` flag reserves the path.

---

## 8. API surface

### Core SDK (`@memfork/core`)

| Method | Description |
|---|---|
| `client.putArtifact(bytes, { path, epochs?, mime? }) → ArtifactRef` | Upload one blob to Walrus, return its reference. |
| `client.getArtifact(ref) → Uint8Array` | Fetch + integrity-check by reference. |
| `client.commit(branch, { facts, message, artifacts? })` | `artifacts: Array<{ path, bytes }>` uploaded, refs embedded in payload. |
| `client.history(...)` | Each `CommitEntry` surfaces `artifacts: ArtifactRef[]`. |

### CLI (`@memfork/cli`)

| Command | Description |
|---|---|
| `memfork commit -m <msg> --file <path>` | Repeatable `--file`; uploads each to Walrus, commits with refs, prints blob IDs. |
| `memfork cat <blobId> [--out <path>]` | Retrieve an artifact; write to stdout or `--out`. |
| `memfork show <commitId>` | Already lists commit detail; extend to list attached artifacts. |

---

## 9. Reference integration: memforks-research

The demo path. The LangGraph research pipeline (`apps/memforks-research`)
already synthesizes a final report in the supervisor step. Wire it to:

1. Write the synthesized report to Walrus via `putArtifact`.
2. Commit it on the shared branch with the report's `ArtifactRef`.
3. Print the Walrus blob ID + a `memfork cat` command to retrieve it.

This produces a single, judge-legible end-to-end story: *the research agents
accumulate memory on branches, the supervisor merges findings, and the final
report is persisted to Walrus with provenance back to the commit that wrote it.*

---

## 10. Provenance guarantee

For any artifact you can prove, without trusting MemForks:

1. The bytes hash to `ArtifactRef.sha256` (verified on read).
2. The `ArtifactRef` lives in a commit payload whose `content_hash` covers it.
3. That payload is linked by `parent_blob_hashes` up the chain to a branch head.
4. The branch head / merge anchor is a settled object on Sui.

Tampering at any layer is detectable. This is the artifact equivalent of the
memory provenance MemForks already provides.

---

## 11. Out of scope (v0.2)

- SEAL-encrypted private artifacts (flag reserved, not implemented).
- Automatic epoch renewal / lifecycle management.
- Visualizer artifact preview (link-out only, if any).
- Chunking / streaming for very large blobs (rely on Walrus SDK defaults).

---

## 12. Implementation checklist

- [ ] Config: parse `artifacts.{enabled,epochs,maxBytes}` from `.memfork/config.json` + `MEMFORK_ARTIFACTS*` env; default disabled.
- [ ] Add `@mysten/walrus` to `packages/core` deps; lazily init a `WalrusClient` in `MemForksClient` only when artifacts are enabled (mainnet network + existing keypair).
- [ ] `packages/core/src/walrus.ts`: `putArtifact` / `getArtifact` + aggregator/SDK constants + `sha256` integrity; throw the disabled-feature error when not enabled.
- [ ] `memfork doctor`: when artifacts enabled, check signer WAL balance and warn if low.
- [ ] `packages/core/src/types.ts`: add `ArtifactRef`, add `artifacts` to `CommitDelta`, deprecate `files`; surface `artifacts` on `CommitEntry`.
- [ ] `commit()`: accept `artifacts: Array<{ path, bytes }>`, upload-then-commit ordering, embed refs.
- [ ] `history()`: parse `delta.artifacts` into `CommitEntry`.
- [ ] CLI: `commit --file` (repeatable, `--epochs`), `memfork cat`, extend `show`.
- [ ] `apps/memforks-research`: persist final report as an artifact + print retrieval command.
- [ ] Developer-guide note: fund the signer with WAL + SUI on mainnet; epoch/retention behavior.
- [ ] Update README artifacts bullet to the shipped behavior (direct Walrus blob, referenced from commit, retrievable via CLI).
- [ ] Manual mainnet E2E: commit a file → `memfork cat` round-trips identical bytes; integrity check passes.
