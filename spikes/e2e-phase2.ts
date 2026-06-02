/**
 * Phase 2 E2E spike — merge ceremony: Jury(2,2) → finalize_merge
 *
 * What this tests:
 *   1. Create two branches with conflicting facts.
 *   2. Create a Jury(2,2) resolver with two funded judge wallets.
 *   3. proposeMerge (hypothesis-b → main) using the Jury resolver.
 *   4. Both judges sign + submit JURY_VOTE attestations.
 *   5. finalizeMerge mints a merge commit with both parents.
 *   6. Verify merge commit exists on-chain.
 *
 * For the full Sequence([Jury(2,3), LlmReconcile]) demo, run the
 * resolver runtime (`npm start` in runtime/resolver/) with funded judge
 * wallets + LLM API keys, then trigger proposeMerge from this script.
 *
 * Prerequisites:
 *   - MEMFORKS_PACKAGE_ID, MEMFORKS_TREE_ID in spikes/.env.local
 *   - SUI_OWNER_PRIVATE_KEY — tree owner, funds judge wallets
 *   - MEMFORKS_MEMWAL_KEY, MEMWAL_ACCOUNT_ID — for commit()
 */

import { config as loadEnv } from "dotenv";
loadEnv({ path: new URL(".env.local", import.meta.url).pathname });

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";

// SDK built from local source
import { MemForksClient } from "../sdk/src/client.js";
import { resolvers, addrToBytes } from "../sdk/src/resolvers.js";
import { ATTEST_KIND } from "../sdk/src/types.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const PACKAGE_ID  = process.env["MEMFORKS_PACKAGE_ID"]!;
const TREE_ID     = process.env["MEMFORKS_TREE_ID"]!;
const OWNER_KEY   = process.env["SUI_OWNER_PRIVATE_KEY"]!;
const MEMWAL_KEY  = process.env["MEMFORKS_MEMWAL_KEY"]!;
const MEMWAL_ACCT = process.env["MEMWAL_ACCOUNT_ID"]!;
const RPC_URL     = getFullnodeUrl("testnet");

if (!PACKAGE_ID || !TREE_ID || !OWNER_KEY || !MEMWAL_KEY || !MEMWAL_ACCT) {
  throw new Error("Missing required env vars — see spikes/.env.example");
}

// ─── Keypair helpers ─────────────────────────────────────────────────────────

function keypairFromKey(raw: string): Ed25519Keypair {
  if (raw.startsWith("suiprivkey")) {
    const { secretKey } = decodeSuiPrivateKey(raw);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  return Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(raw, "hex")));
}

/** Generate a fresh Ed25519 keypair (deterministic from a seed string). */
function deterministicKeypair(seed: string): Ed25519Keypair {
  // SHA-256-like: repeat+hash. For tests only — never use in prod.
  const buf = Buffer.alloc(32);
  Buffer.from(seed).copy(buf);
  return Ed25519Keypair.fromSecretKey(new Uint8Array(buf));
}

// ─── Attestation helper (does what MemForksClient.submitAttestation does) ────

async function submitAttestation(opts: {
  keypair:      Ed25519Keypair;
  suiClient:    SuiClient;
  packageId:    string;
  proposalId:   string;
  resolverId:   string;
  attestKind:   number;
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

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n══════════════════════════════════════════");
  console.log("  Phase 2 E2E — Jury merge ceremony");
  console.log("══════════════════════════════════════════\n");

  const suiClient = new SuiClient({ url: RPC_URL });
  const ownerKp   = keypairFromKey(OWNER_KEY);
  const ownerAddr = ownerKp.toSuiAddress();

  // ── Generate two deterministic judge keypairs ──────────────────────────────
  const judge0Kp   = deterministicKeypair("memforks-judge-0-testnet-2026");
  const judge1Kp   = deterministicKeypair("memforks-judge-1-testnet-2026");
  const judge0Addr = judge0Kp.toSuiAddress();
  const judge1Addr = judge1Kp.toSuiAddress();

  console.log(`Owner  : ${ownerAddr}`);
  console.log(`Judge 0: ${judge0Addr}`);
  console.log(`Judge 1: ${judge1Addr}\n`);

  // ── Connect owner client ───────────────────────────────────────────────────
  const mem = await MemForksClient.connect({
    treeId:    TREE_ID,
    packageId: PACKAGE_ID,
    signer:    OWNER_KEY,
    memwal: {
      delegateKey: MEMWAL_KEY,
      accountId:   MEMWAL_ACCT,
    },
  });

  // ── Fund judge wallets (5M MIST each ≈ 0.005 SUI) ─────────────────────────
  console.log("[1/8] Funding judge wallets…");
  await mem.transferSui(judge0Addr, BigInt(5_000_000));
  await mem.transferSui(judge1Addr, BigInt(5_000_000));
  console.log("      done\n");

  // ── Grant both judges WRITE + FORK + PROPOSE + MERGE on all branches ──────
  console.log("[2/8] Granting delegate caps to judges…");
  const expiresEpoch = BigInt("18446744073709551615"); // u64::MAX
  await mem.grantDelegate(judge0Addr, { perms: 0x1F, expiresEpoch });
  await mem.grantDelegate(judge1Addr, { perms: 0x1F, expiresEpoch });
  console.log("      done\n");

  // ── Create branch hypothesis-b ─────────────────────────────────────────────
  const hypothesisBranch = `hypothesis-b-${Date.now()}`;
  console.log(`[3/8] Creating branch "${hypothesisBranch}"…`);
  await mem.branch(hypothesisBranch, { from: "main" });
  console.log("      done\n");

  // ── Commit conflicting facts ───────────────────────────────────────────────
  console.log("[4/8] Committing facts to both branches…");
  const { blobId: fromBlobId } = await mem.commit(hypothesisBranch, {
    facts:   ["GPU cluster: 8× H100 80GB", "batch size: 512", "FLOPS: 3.9e15"],
    message: "hypothesis: scale up GPU cluster",
  });
  const { blobId: intoBlobId } = await mem.commit("main", {
    facts:   ["GPU cluster: 4× A100 40GB", "batch size: 256", "FLOPS: 1.2e15"],
    message: "baseline: current production setup",
  });
  console.log(`      ${hypothesisBranch} blob: ${fromBlobId}`);
  console.log(`      main blob:                ${intoBlobId}\n`);

  // ── Create Jury(2,2) resolver ──────────────────────────────────────────────
  console.log("[5/8] Creating Jury(2,2) resolver on-chain…");
  const resolverDef = resolvers.jury([judge0Addr, judge1Addr], 2);
  const { resolverId } = await mem.createResolver(resolverDef);
  console.log(`      resolver: ${resolverId}\n`);

  // ── Propose merge ──────────────────────────────────────────────────────────
  console.log("[6/8] Proposing merge (hypothesis-b → main)…");
  const proposalDigest = await mem.proposeMerge({
    fromBranch: hypothesisBranch,
    intoBranch: "main",
    resolverId,
    ttlMs: 3_600_000, // 1 hour
  });
  console.log(`      proposeMerge tx: ${proposalDigest}`);

  // Extract proposal ID from events.
  const proposeTx = await suiClient.getTransactionBlock({
    digest: proposalDigest,
    options: { showEvents: true },
  });
  const proposalEvent = proposeTx.events?.find(
    e => e.type.includes("::resolver::MergeProposed"),
  );
  const proposalId: string = (proposalEvent?.parsedJson as { proposal_id: string } | undefined)
    ?.proposal_id ?? "";
  if (!proposalId) throw new Error("Could not extract proposal_id from events");
  console.log(`      proposal: ${proposalId}\n`);

  // ── Both judges submit JURY_VOTE attestations ──────────────────────────────
  console.log("[7/8] Judges submitting JURY_VOTE attestations…");

  const votePayload = (judgeAddr: string) => Buffer.from(JSON.stringify({
    proposal_id:    proposalId,
    from_branch:    hypothesisBranch,
    into_branch:    "main",
    vote:           "approve",
    reasoning:      "H100 cluster provides necessary throughput for Phase 3 workloads",
    judge:          judgeAddr,
    ts_ms:          Date.now(),
  }));

  const vote0Digest = await submitAttestation({
    keypair:       judge0Kp,
    suiClient,
    packageId:     PACKAGE_ID,
    proposalId,
    resolverId,
    attestKind:    ATTEST_KIND.JURY_VOTE,
    attestPayload: votePayload(judge0Addr),
  });
  console.log(`      judge 0 vote: ${vote0Digest}`);

  const vote1Digest = await submitAttestation({
    keypair:       judge1Kp,
    suiClient,
    packageId:     PACKAGE_ID,
    proposalId,
    resolverId,
    attestKind:    ATTEST_KIND.JURY_VOTE,
    attestPayload: votePayload(judge1Addr),
  });
  console.log(`      judge 1 vote: ${vote1Digest}\n`);

  // ── Finalize merge ─────────────────────────────────────────────────────────
  console.log("[8/8] Calling finalize_merge…");
  const finalizeDigest = await mem.finalizeMerge({
    proposalId,
    resolverId,
    resolvedNamespace: `memforks/${TREE_ID.replace("0x", "")}/${hypothesisBranch}`,
    resolvedBlobId:    fromBlobId,  // adopting hypothesis-b's state
  });
  console.log(`      finalizeMerge tx: ${finalizeDigest}\n`);

  // ── Verify ────────────────────────────────────────────────────────────────
  const { status, proposal } = await mem.waitForFinalization(proposalId, {
    pollMs: 2_000, timeoutMs: 30_000,
  });
  console.log(`\n✓ Proposal status : ${status}`);
  console.log(`  Resolved ns      : ${proposal.resolved_memwal_namespace ?? "—"}`);
  console.log(`  Resolved blob    : ${proposal.resolved_memwal_blob_id ?? "—"}`);
  console.log(`  Attestations     : ${proposal.attestations.length}`);

  // Verify merge commit exists on main.
  const mainHead = await mem.getBranchHead("main");
  const mergeCommit = await mem.getCommit(mainHead);
  console.log(`\n  merge commit     : ${mainHead}`);
  console.log(`  parents          : ${mergeCommit.parents.join(", ")}`);
  console.log(`  merge_resolver   : ${mergeCommit.merge_resolver}`);
  console.log(`  ts_ms            : ${mergeCommit.ts_ms}`);

  if (mergeCommit.parents.length < 2) {
    throw new Error("FAIL: merge commit should have 2 parents");
  }
  if (!mergeCommit.merge_resolver) {
    throw new Error("FAIL: merge commit should reference the resolver");
  }

  console.log("\n══════════════════════════════════════════");
  console.log("  Phase 2 E2E PASSED ✓");
  console.log("══════════════════════════════════════════\n");
}

main().catch(err => { console.error("\n✗ Phase 2 E2E FAILED:", err); process.exit(1); });
