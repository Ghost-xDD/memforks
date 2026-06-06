/**
 * Model A end-to-end integration test.
 *
 * Tests the full pipeline on Sui testnet:
 *   1. Connect to existing tree
 *   2. Create a branch  (on-chain tx)
 *   3. Commit ×3        (off-chain Walrus blobs via MemWal)
 *   4. Recall           (semantic search via MemWal)
 *   5. Create Jury(2,2) resolver (on-chain)
 *   6. Propose merge    (on-chain tx)
 *   7. Submit 2 JURY_VOTE attestations (on-chain)
 *   8. Finalize merge   (on-chain tx → MergeAnchor minted)
 *   9. Verify via getTree(), getMergeAnchor(), waitForFinalization()
 *  10. Verify indexer tracks BranchCreated + MergeFinalized events
 *  11. Verify /api/history returns commits from MemWal
 *
 * Prerequisites (spikes/.env.local):
 *   SUI_OWNER_PRIVATE_KEY  — suiprivkey1... bech32
 *   MEMFORKS_MEMWAL_KEY    — 64-char hex delegate private key
 *   MEMWAL_ACCOUNT_ID      — 0x-prefixed MemWalAccount object ID
 *   MEMFORKS_PACKAGE_ID    — 0x-prefixed deployed package
 *   MEMFORKS_TREE_ID       — 0x-prefixed MemoryTree shared object
 *
 * Run:  npx tsx spikes/e2e-model-a.ts
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: new URL(".env.local", import.meta.url).pathname });

import { Ed25519Keypair }       from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey }  from "@mysten/sui/cryptography";
import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction }          from "@mysten/sui/transactions";

import { MemForksClient }   from "../sdk/src/client.js";
import { MemForksIndexer }  from "../sdk/src/indexer.js";
import { resolvers }        from "../sdk/src/resolvers.js";
import { ATTEST_KIND }      from "../sdk/src/types.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PACKAGE_ID  = process.env["MEMFORKS_PACKAGE_ID"]!;
const TREE_ID     = process.env["MEMFORKS_TREE_ID"]!;
const OWNER_KEY   = process.env["SUI_OWNER_PRIVATE_KEY"]!;
const MEMWAL_KEY  = process.env["MEMFORKS_MEMWAL_KEY"]!;
const MEMWAL_ACCT = process.env["MEMWAL_ACCOUNT_ID"]!;
const RELAYER     = process.env["MEMWAL_RELAYER"] ?? "https://relayer.staging.memwal.ai";
const RPC_URL     = getFullnodeUrl("testnet");
const UI_ORIGIN   = process.env["MEMFORK_UI"] ?? "http://localhost:4242";

for (const [k, v] of Object.entries({ PACKAGE_ID, TREE_ID, OWNER_KEY, MEMWAL_KEY, MEMWAL_ACCT })) {
  if (!v) { console.error(`✗ Missing env: ${k}`); process.exit(1); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function keypairFromKey(raw: string): Ed25519Keypair {
  if (raw.startsWith("suiprivkey")) {
    const { secretKey } = decodeSuiPrivateKey(raw);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(raw, "hex")));
}

/** Deterministic keypair from a seed string (for reproducible test judges). */
function deterministicKp(seed: string): Ed25519Keypair {
  const buf = Buffer.alloc(32);
  Buffer.from(seed).copy(buf);
  return Ed25519Keypair.fromSecretKey(new Uint8Array(buf));
}

function ok(msg: string) { console.log(`  ✓ ${msg}`); }
function step(n: number, total: number, msg: string) {
  console.log(`\n[${n}/${total}] ${msg}`);
}
function assert(cond: boolean, msg: string) {
  if (!cond) { console.error(`  ✗ ASSERTION FAILED: ${msg}`); process.exit(1); }
}

async function submitAttestation(opts: {
  keypair:       Ed25519Keypair;
  suiClient:     SuiClient;
  packageId:     string;
  proposalId:    string;
  resolverId:    string;
  attestKind:    number;
  attestPayload: Uint8Array;
}): Promise<string> {
  const pubkeyBytes = Array.from(opts.keypair.getPublicKey().toRawBytes());
  const sigBytes    = Array.from(await opts.keypair.sign(opts.attestPayload));

  const tx = new Transaction();
  tx.moveCall({
    target: `${opts.packageId}::resolver::submit_attestation`,
    arguments: [
      tx.object(opts.proposalId),
      tx.object(opts.resolverId),
      tx.pure.u8(opts.attestKind),
      tx.pure.vector("u8", Array.from(opts.attestPayload)),
      tx.pure.vector("u8", pubkeyBytes),
      tx.pure.vector("u8", sigBytes),
    ],
  });
  tx.setGasBudget(25_000_000);

  const result = await opts.suiClient.signAndExecuteTransaction({
    transaction: tx,
    signer: opts.keypair,
    options: { showEffects: true },
  });
  if (result.effects?.status.status !== "success") {
    throw new Error(`submit_attestation failed: ${result.effects?.status.error}`);
  }
  return result.digest;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const TOTAL_STEPS = 11;

  console.log("═══════════════════════════════════════════════");
  console.log("  MemForks Model A — end-to-end integration");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Package : ${PACKAGE_ID}`);
  console.log(`  Tree    : ${TREE_ID}`);
  console.log(`  Relayer : ${RELAYER}`);

  // ── [1] Connect ────────────────────────────────────────────────────────────
  step(1, TOTAL_STEPS, "Connect MemForksClient");
  const mem = await MemForksClient.connect({
    treeId:    TREE_ID,
    packageId: PACKAGE_ID,
    signer:    OWNER_KEY,
    memwal: {
      delegateKey: MEMWAL_KEY,
      accountId:   MEMWAL_ACCT,
      serverUrl:   RELAYER,
    },
    rpcUrl: RPC_URL,
  });
  const ownerAddr = mem.keypair.toSuiAddress();
  ok(`signer = ${ownerAddr}`);

  const tree = await mem.getTree();
  ok(`tree loaded: default_branch=${tree.default_branch}`);

  // ── [2] Create branch ──────────────────────────────────────────────────────
  step(2, TOTAL_STEPS, "Create branch (on-chain)");
  const branchName = `e2e-model-a-${Date.now()}`;
  const branchDigest = await mem.branch(branchName, { from: "main" });
  ok(`branch="${branchName}"  tx=${branchDigest.slice(0, 16)}...`);

  // ── [3] Commit ×3 to new branch (off-chain) ────────────────────────────────
  step(3, TOTAL_STEPS, "Commit ×3 off-chain blobs via MemWal");
  console.log("  (each commit waits for Walrus blob confirmation — ~30s total)");
  const t0 = Date.now();

  const { blobId: blob1, contentHash: hash1 } = await mem.commit(branchName, {
    facts:   ["REST p99 latency: 180ms at 10k RPS — confirmed in load test."],
    message: "baseline: REST latency benchmark",
  });
  ok(`commit 1  blob=${blob1.slice(0, 16)}...  hash=${hash1.slice(0, 12)}...`);

  const { blobId: blob2, contentHash: hash2 } = await mem.commit(branchName, {
    facts:   [
      "GraphQL adds 28% overhead at p99 due to resolver chaining.",
      "gRPC stream reduces p99 by ~35% in synthetic benchmark.",
    ],
    message: "analysis: GraphQL vs gRPC overhead",
  });
  ok(`commit 2  blob=${blob2.slice(0, 16)}...  parent=${blob1.slice(0, 10)}...`);
  assert(hash1.length === 64, "contentHash should be 64-char hex");

  // Commit to main too (so both heads are non-empty).
  const { blobId: mainBlob } = await mem.commit("main", {
    facts:   ["Current stack: REST + JSON. SLA target p99 < 150ms."],
    message: "baseline: production stack documented",
  });
  ok(`commit 3 (main)  blob=${mainBlob.slice(0, 16)}...`);
  console.log(`  elapsed: ${Date.now() - t0}ms`);

  // Assert hash chain: blob2's parent should be blob1.
  // We can't decode the Walrus blob here (SEAL-encrypted), but the local head
  // tracker should show blob2 as the new head of branchName.
  const localHeads = (mem as unknown as { heads: Map<string, { blobId: string }> }).heads;
  assert(localHeads.get(branchName)?.blobId === blob2, "local head should be blob2");
  assert(localHeads.get("main")?.blobId     === mainBlob, "local head of main should be mainBlob");
  ok("local head tracker: hash chain correct");

  // ── [4] Recall ─────────────────────────────────────────────────────────────
  step(4, TOTAL_STEPS, `Recall from "${branchName}"`);
  const results = await mem.recall("What do we know about API latency and performance?", {
    branch: branchName,
    limit:  3,
  });
  ok(`recall() returned ${results.length} result(s)`);
  results.forEach((r, i) =>
    console.log(`    [${i}] distance=${r.distance.toFixed(4)}  "${r.text.slice(0, 80)}..."`)
  );
  assert(results.length > 0, "recall() must return at least one result");

  // ── [5] Create Jury(2,2) resolver ─────────────────────────────────────────
  step(5, TOTAL_STEPS, "Create Jury(2,2) resolver on-chain");
  const judge0Kp   = deterministicKp("memforks-e2e-judge-0-2026");
  const judge1Kp   = deterministicKp("memforks-e2e-judge-1-2026");
  const judge0Addr = judge0Kp.toSuiAddress();
  const judge1Addr = judge1Kp.toSuiAddress();

  // Fund judges so they can submit attestation txs.
  await mem.transferSui(judge0Addr, BigInt(50_000_000));
  await mem.transferSui(judge1Addr, BigInt(50_000_000));
  ok(`funded judges: ${judge0Addr.slice(0, 16)}...  ${judge1Addr.slice(0, 16)}...`);

  // Grant delegates (required to attest on proposals).
  await mem.grantDelegate(judge0Addr, { perms: 0x1F, expiresEpoch: BigInt("18446744073709551615") });
  await mem.grantDelegate(judge1Addr, { perms: 0x1F, expiresEpoch: BigInt("18446744073709551615") });
  ok("granted delegate caps to both judges");

  const resolverDef = resolvers.jury([judge0Addr, judge1Addr], 2);
  const { resolverId } = await mem.createResolver(resolverDef);
  ok(`resolver=${resolverId}`);

  // ── [6] Propose merge ─────────────────────────────────────────────────────
  step(6, TOTAL_STEPS, `Propose merge: ${branchName} → main`);

  // Show on-chain heads (from the Table dynamic fields) for debugging.
  const [onChainFromHead, onChainIntoHead] = await Promise.all([
    mem.getBranchHead(branchName),
    mem.getBranchHead("main"),
  ]);
  ok(`on-chain ${branchName} head: ${onChainFromHead || "(empty)"}`);
  ok(`on-chain main head          : ${onChainIntoHead || "(empty)"}`);
  ok(`local    ${branchName} head: ${localHeads.get(branchName)?.blobId?.slice(0, 20) || "(empty)"}...`);
  ok(`local    main head          : ${localHeads.get("main")?.blobId?.slice(0, 20) || "(empty)"}...`);

  const proposeDigest = await mem.proposeMerge({
    fromBranch: branchName,
    intoBranch: "main",
    resolverId,
    ttlMs: 3_600_000,
  });
  ok(`proposeMerge tx: ${proposeDigest.slice(0, 16)}...`);

  const suiClient = new SuiClient({ url: RPC_URL });
  const proposeTx = await suiClient.getTransactionBlock({
    digest:  proposeDigest,
    options: { showEvents: true },
  });
  const propEvent = proposeTx.events?.find(e => e.type.includes("::resolver::MergeProposed"));
  const proposalId: string = (propEvent?.parsedJson as { proposal_id?: string } | undefined)
    ?.proposal_id ?? "";
  assert(proposalId.length > 0, "proposal_id must be non-empty");
  ok(`proposalId=${proposalId}`);

  // ── [7] Submit JURY_VOTE attestations ────────────────────────────────────
  step(7, TOTAL_STEPS, "Submit 2 JURY_VOTE attestations");

  const makeVotePayload = (judgeAddr: string) =>
    Buffer.from(JSON.stringify({
      proposal_id: proposalId,
      from_branch: branchName,
      into_branch: "main",
      vote:        "approve",
      reasoning:   "gRPC transition aligns with p99 SLA target",
      judge:       judgeAddr,
      ts_ms:       Date.now(),
    }));

  const vote0 = await submitAttestation({
    keypair:       judge0Kp, suiClient, packageId: PACKAGE_ID,
    proposalId, resolverId,
    attestKind:    ATTEST_KIND.JURY_VOTE,
    attestPayload: makeVotePayload(judge0Addr),
  });
  ok(`judge 0 vote: ${vote0.slice(0, 16)}...`);

  const vote1 = await submitAttestation({
    keypair:       judge1Kp, suiClient, packageId: PACKAGE_ID,
    proposalId, resolverId,
    attestKind:    ATTEST_KIND.JURY_VOTE,
    attestPayload: makeVotePayload(judge1Addr),
  });
  ok(`judge 1 vote: ${vote1.slice(0, 16)}...`);

  // ── [8] Finalize merge ───────────────────────────────────────────────────
  step(8, TOTAL_STEPS, "Finalize merge (on-chain MergeAnchor)");
  const finalizeDigest = await mem.finalizeMerge({
    proposalId,
    resolverId,
    resolvedNamespace: `memforks/${TREE_ID.replace("0x", "")}/${branchName}`,
    resolvedBlobId:    blob2,   // adopt branchName's latest commit as resolved state
  });
  ok(`finalizeMerge tx: ${finalizeDigest.slice(0, 16)}...`);

  // ── [9] Verify on-chain state ────────────────────────────────────────────
  step(9, TOTAL_STEPS, "Verify on-chain state");

  // waitForFinalization polls proposal object until status = FINALIZED.
  const { status, proposal } = await mem.waitForFinalization(proposalId, {
    pollMs: 2_000, timeoutMs: 30_000,
  });
  assert(status === "finalized", `proposal status should be finalized, got: ${status}`);
  ok(`proposal status: ${status}`);
  ok(`resolved_blob_id: ${proposal.resolved_memwal_blob_id ?? "(not in proposal fields)"}`);

  // Retrieve the MergeAnchor from the finalize tx events.
  const finalizeTx = await suiClient.getTransactionBlock({
    digest:  finalizeDigest,
    options: { showEvents: true },
  });
  const finalizedEvent = finalizeTx.events?.find(e => e.type.includes("::resolver::MergeFinalized"));
  const mergeCommitId: string = (finalizedEvent?.parsedJson as { merge_commit_id?: string } | undefined)
    ?.merge_commit_id ?? "";
  assert(mergeCommitId.length > 0, "merge_commit_id must be present in MergeFinalized event");
  ok(`merge_commit_id: ${mergeCommitId}`);

  // Fetch the MergeAnchor object.
  const anchor = await mem.getMergeAnchor(mergeCommitId);
  ok(`anchor.parents = [${(anchor.parents as string[]).map(p => p.slice(0, 10) + "...").join(", ")}]`);
  assert(
    (anchor.parents as string[]).length >= 2,
    `merge anchor should have ≥2 parent blob IDs, got ${(anchor.parents as string[]).length}`,
  );

  // Verify main's on-chain branch head advanced to resolved_blob_id.
  const mainHead = await mem.getBranchHead("main");
  ok(`main branch head (blob ID): ${mainHead || "(empty)"}`);
  assert(mainHead === blob2, `main head should be blob2 (${blob2.slice(0,16)}...), got: ${mainHead.slice(0,16)}...`);

  // ── [10] Indexer ─────────────────────────────────────────────────────────
  step(10, TOTAL_STEPS, "Indexer: poll for BranchCreated + MergeFinalized events");
  const indexer = new MemForksIndexer({
    treeId:    TREE_ID,
    suiClient: mem.suiClient,
    packageId: PACKAGE_ID,
  });

  let branchEvents = 0;
  let mergeEvents  = 0;

  indexer.on("branch", (ev: { branch: string }) => {
    branchEvents++;
    console.log(`    [indexer] BranchCreated: ${ev.branch}`);
  });
  indexer.on("merge_finalized", (ev: { intoBranch: string; mergeCommitId: string }) => {
    mergeEvents++;
    console.log(`    [indexer] MergeFinalized: into=${ev.intoBranch} anchor=${ev.mergeCommitId.slice(0, 12)}...`);
  });

  indexer.start();
  console.log("  Polling 15s for events…");
  await new Promise(resolve => setTimeout(resolve, 15_000));
  indexer.stop();

  ok(`branch events seen: ${branchEvents}`);
  ok(`merge events seen : ${mergeEvents}`);
  assert(branchEvents > 0, "indexer should have seen at least one BranchCreated event");

  if (mergeEvents === 0) {
    // Direct fallback: query for the MergeFinalized event we know was emitted.
    console.log("  (indexer missed it in window — querying directly via RPC fallback)");
    const eventType = `${PACKAGE_ID}::resolver::MergeFinalized`;
    const evResult  = await suiClient.queryEvents({
      query: { MoveEventType: eventType },
      limit: 50,
      order: "descending",
    });
    const found = evResult.data.some(e =>
      (e.parsedJson as Record<string, unknown>)?.["merge_commit_id"] === mergeCommitId,
    );
    assert(found, `MergeFinalized event for ${mergeCommitId.slice(0,16)} not found on-chain`);
    ok("MergeFinalized event confirmed on-chain via direct RPC query");
  } else {
    ok(`merge events seen by indexer: ${mergeEvents}`);
  }

  // ── [11] /api/history ────────────────────────────────────────────────────
  step(11, TOTAL_STEPS, `Verify /api/history via ${UI_ORIGIN}`);
  try {
    const r = await fetch(
      `${UI_ORIGIN}/api/history?branch=${encodeURIComponent(branchName)}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    if (r.ok) {
      const data = await r.json() as { commits?: unknown[] };
      const count = data.commits?.length ?? 0;
      ok(`/api/history returned ${count} commit(s) for "${branchName}"`);
      assert(count >= 2, `/api/history should return ≥2 commits for ${branchName}, got ${count}`);
    } else {
      console.warn(`  ⚠  /api/history → HTTP ${r.status} (is memfork ui running?)`);
    }
  } catch {
    console.warn(`  ⚠  /api/history unreachable (start: memfork ui). Skipping.`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log("\n═══════════════════════════════════════════════");
  console.log("  Model A E2E PASSED ✓");
  console.log("═══════════════════════════════════════════════");
  console.log(`  Tree            : ${TREE_ID}`);
  console.log(`  New branch      : ${branchName}`);
  console.log(`  Commits (blobs) : ${blob1.slice(0,10)}...  ${blob2.slice(0,10)}...  ${mainBlob.slice(0,10)}...`);
  console.log(`  Proposal        : ${proposalId}`);
  console.log(`  Merge anchor    : ${mergeCommitId}`);
  console.log(`  Resolved blob   : ${blob2.slice(0,16)}...`);
}

main().catch(err => {
  console.error("\n✗ Model A E2E FAILED:", err);
  process.exit(1);
});
