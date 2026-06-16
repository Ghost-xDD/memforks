/**
 * Phase 1 end-to-end integration test.
 *
 * Exercises the full branch → commit → recall flow on testnet through
 * @memfork/core, proving the Phase 1 MVP gate.
 *
 * Prerequisites (in spikes/.env.local):
 *   SUI_OWNER_PRIVATE_KEY  — suiprivkey1... bech32 string
 *   MEMFORKS_MEMWAL_KEY    — 64-char hex delegate private key
 *   MEMWAL_ACCOUNT_ID      — 0x-prefixed MemWalAccount object ID
 *   MEMFORKS_PACKAGE_ID    — 0x-prefixed deployed package
 *   MEMFORKS_TREE_ID       — 0x-prefixed MemoryTree shared object (set after init_tree)
 *
 * Run:  npx tsx e2e-phase1.ts
 */

import { config } from 'dotenv';
config({ path: new URL('.env.local', import.meta.url).pathname });

import { MemForksClient, MemForksIndexer } from '../packages/core/src/index.js';
import { getFullnodeUrl } from '@mysten/sui/client';

const OWNER_KEY = process.env['SUI_OWNER_PRIVATE_KEY']!;
const DELEGATE_KEY = process.env['MEMFORKS_MEMWAL_KEY']!;
const ACCOUNT_ID = process.env['MEMWAL_ACCOUNT_ID']!;
const PACKAGE_ID = process.env['MEMFORKS_PACKAGE_ID']!;
const TREE_ID = process.env['MEMFORKS_TREE_ID'];
const SUI_RPC = process.env['SUI_RPC'] ?? getFullnodeUrl('testnet');
const RELAYER =
  process.env['MEMWAL_RELAYER'] ?? 'https://relayer-staging.memory.walrus.xyz';

for (const [k, v] of Object.entries({
  OWNER_KEY,
  DELEGATE_KEY,
  ACCOUNT_ID,
  PACKAGE_ID,
})) {
  if (!v) {
    console.error(`Missing env: ${k}`);
    process.exit(1);
  }
}

// ─── Step 0: Connect client first, then init_tree ────────────────────────────
// We always create a fresh tree for this test so the signer is guaranteed to
// be the owner (avoids cross-wallet mismatches with pre-existing trees).

// ─── Connect ──────────────────────────────────────────────────────────────────

console.log('→ Connecting MemForksClient...');
// We use a placeholder treeId for connect(); it will be updated after initTree().
const mem = await MemForksClient.connect({
  treeId: TREE_ID ?? '0x0', // placeholder — overwritten below
  signer: OWNER_KEY,
  packageId: PACKAGE_ID,
  memwal: {
    accountId: ACCOUNT_ID,
    delegateKey: DELEGATE_KEY,
    serverUrl: RELAYER,
  },
  rpcUrl: SUI_RPC,
});
const signerAddress = mem.keypair.toSuiAddress();
console.log(`✓ Connected. Signer: ${signerAddress}`);

// ─── Step 0: Create a fresh MemoryTree owned by the signer ───────────────────

console.log('\n→ Creating MemoryTree (owned by signer)...');
const { digest: initDigest, treeId } = await mem.initTree(ACCOUNT_ID, 'main');
// Patch treeId into the client instance (it's readonly but we use it via closure below).
Object.assign(mem, { treeId });
console.log(`✓ MemoryTree created: ${treeId}`);
console.log(`  Tx: ${initDigest}`);

// ─── Step 1: grant_delegate to self (owner must be a delegate to use commit/branch) ──

const ownerAddress = mem.keypair.toSuiAddress();
console.log(
  `\n→ Granting delegate to self (${ownerAddress.slice(0, 16)}...)...`,
);
const grantDigest = await mem.grantDelegate(ownerAddress, {
  branches: [], // all branches
  perms: 0x1f, // READ | WRITE | FORK | MERGE | PROPOSE
  expiresEpoch: BigInt('18446744073709551615'),
});
console.log(`✓ grant_delegate tx: ${grantDigest}`);

// ─── Step 2: branch ───────────────────────────────────────────────────────────

const branchName = `hypothesis-${Date.now()}`;
console.log(`\n→ Creating branch "${branchName}" from "main"...`);
const branchDigest = await mem.branch(branchName, { from: 'main' });
console.log(`✓ branch tx: ${branchDigest}`);

// ─── Step 3: commit on new branch ─────────────────────────────────────────────

const facts = [
  'REST p99 latency is 180ms at 10k RPS — confirmed in load test.',
  'GraphQL adds 28% overhead at p99 due to resolver chaining.',
  'Hypothesis: switching to gRPC would reduce p99 by ~35%.',
];

console.log(`\n→ Committing ${facts.length} facts to "${branchName}"...`);
console.log('  (MemWal rememberAndWait — may take ~30s)');
const t0 = Date.now();

const { digest: commitDigest, blobId } = await mem.commit(branchName, {
  facts,
  message: 'perf benchmarks: REST vs GraphQL latency',
});

console.log(`✓ commit tx: ${commitDigest}`);
console.log(`  blob_id: ${blobId}`);
console.log(`  elapsed: ${Date.now() - t0}ms`);

// ─── Step 4: commit on main branch too ───────────────────────────────────────

const mainFacts = [
  'Current stack: REST + JSON. SLA target: p99 < 150ms.',
  'Baseline p99: 180ms at 10k RPS (over budget).',
];

console.log(`\n→ Committing baseline facts to "main"...`);
const { digest: mainDigest } = await mem.commit('main', {
  facts: mainFacts,
  message: 'baseline performance established',
});
console.log(`✓ commit tx (main): ${mainDigest}`);

// ─── Step 5: recall ───────────────────────────────────────────────────────────

console.log(`\n→ Recalling from "${branchName}"...`);
const results = await mem.recall(
  'What do we know about API latency and performance?',
  {
    branch: branchName,
    limit: 3,
  },
);

console.log(`✓ recall() returned ${results.length} results:`);
results.forEach((r, i) => {
  console.log(`  [${i}] distance=${r.distance.toFixed(4)} blob=${r.blobId}`);
  console.log(
    `       "${r.text.slice(0, 100)}${r.text.length > 100 ? '...' : ''}"`,
  );
});

if (results.length === 0) {
  throw new Error('recall returned 0 results — FAILED');
}

// ─── Step 6: indexer test ─────────────────────────────────────────────────────

console.log(`\n→ Starting indexer (polling for 8s)...`);
const indexer = new MemForksIndexer({
  treeId,
  suiClient: mem.suiClient,
  packageId: PACKAGE_ID,
});

let indexedCommits = 0;
indexer.on('commit', (node) => {
  indexedCommits++;
  console.log(
    `  [indexer] CommitCreated branch=${node.branch} isMerge=${node.isMerge}`,
  );
});
indexer.on('branch', (ev) => {
  console.log(
    `  [indexer] BranchCreated branch=${ev.branch} from=${ev.fromBranch}`,
  );
});

indexer.start();
await new Promise((resolve) => setTimeout(resolve, 8_000));
indexer.stop();

console.log(`  Indexed ${indexedCommits} commit(s).`);
console.log(`  Known branches: ${indexer.allBranches().join(', ')}`);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log('\n=== PHASE 1 E2E PASSED ===');
console.log(`Tree:            ${treeId}`);
console.log(`Branch created:  ${branchName}`);
console.log(
  `Commits on-chain: ${indexedCommits > 0 ? 'yes (indexed)' : 'yes (not yet indexed)'}`,
);
console.log(
  `Recall works:    yes (distance ${results[0].distance.toFixed(4)})`,
);
console.log(
  `Indexer:         ${indexer.allBranches().length} branch(es) tracked`,
);
console.log(
  `\nTo reuse this tree, add to spikes/.env.local:\n  MEMFORKS_TREE_ID=${treeId}`,
);
