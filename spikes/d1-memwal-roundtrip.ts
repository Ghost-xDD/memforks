/**
 * D-1 SPIKE — MemWal delegate auth end-to-end on testnet.
 *
 * Package:  @mysten-incubation/memwal
 * Relayer:  https://relayer-staging.memory.walrus.xyz  (testnet)
 * Contract: 0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6
 * Registry: 0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437
 *
 * Two modes:
 *
 *   --setup  Create MemWal account + delegate key. Run once, paste output into .env.local.
 *            Requires: SUI_OWNER_PRIVATE_KEY in .env.local (64-char hex Ed25519 key)
 *
 *   (default) Run the remember → recall roundtrip.
 *            Requires: MEMFORKS_MEMWAL_KEY + MEMWAL_ACCOUNT_ID in .env.local
 *
 * Run:  npx tsx d1-memwal-roundtrip.ts --setup
 *       npx tsx d1-memwal-roundtrip.ts
 */

import { config } from 'dotenv';
config({ path: new URL('.env.local', import.meta.url).pathname });

import {
  generateDelegateKey,
  createAccount,
  addDelegateKey,
} from '@mysten-incubation/memwal/account';

// ─── Shared constants ─────────────────────────────────────────────────────────

const RELAYER_URL =
  process.env['MEMWAL_RELAYER'] ?? 'https://relayer-staging.memory.walrus.xyz';
const SUI_NETWORK = (process.env['SUI_NETWORK'] ?? 'testnet') as
  | 'testnet'
  | 'mainnet';
const PACKAGE_ID =
  '0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6';
const REGISTRY_ID =
  '0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437';

// ─── Mode: --setup ────────────────────────────────────────────────────────────

if (process.argv.includes('--setup')) {
  const OWNER_KEY = process.env['SUI_OWNER_PRIVATE_KEY'];
  if (!OWNER_KEY) {
    console.error(
      'Set SUI_OWNER_PRIVATE_KEY in .env.local (64-char hex Ed25519 private key).',
    );
    process.exit(1);
  }

  console.log('=== D-1 SETUP ===\n');
  console.log('Network:  ', SUI_NETWORK);
  console.log('Package:  ', PACKAGE_ID);
  console.log('Registry: ', REGISTRY_ID);

  // 1. Generate a fresh delegate keypair.
  const { privateKey, publicKey, suiAddress } = await generateDelegateKey();
  console.log('\n✓ Generated delegate keypair:');
  console.log('  suiAddress:', suiAddress);
  // privateKey printed at the end so it's easy to copy

  // 2. Create MemWal account (one per Sui owner address).
  console.log('\n→ Creating MemWal account on', SUI_NETWORK, '...');
  const result = await createAccount({
    suiPrivateKey: OWNER_KEY,
    suiNetwork: SUI_NETWORK,
    packageId: PACKAGE_ID,
    registryId: REGISTRY_ID,
  });
  const accountId = result.accountId;
  console.log('✓ MemWalAccount created:', accountId);

  // 3. Register the delegate key on the account.
  console.log('\n→ Adding delegate key to account...');
  await addDelegateKey({
    suiPrivateKey: OWNER_KEY,
    suiNetwork: SUI_NETWORK,
    packageId: PACKAGE_ID,
    accountId,
    publicKey,
    label: 'memforks-spike-d1',
  });
  console.log('✓ Delegate key registered.');

  // 4. Print values to add to .env.local.
  console.log('\n=== Add these to spikes/.env.local ===');
  console.log(`MEMFORKS_MEMWAL_KEY=${privateKey}`);
  console.log(`MEMWAL_ACCOUNT_ID=${accountId}`);
  console.log('======================================');
  process.exit(0);
}

// ─── Mode: roundtrip test ─────────────────────────────────────────────────────

const DELEGATE_KEY = process.env['MEMFORKS_MEMWAL_KEY'];
const ACCOUNT_ID = process.env['MEMWAL_ACCOUNT_ID'];

if (!DELEGATE_KEY || !ACCOUNT_ID) {
  console.error(
    'Set MEMFORKS_MEMWAL_KEY and MEMWAL_ACCOUNT_ID in spikes/.env.local.\n' +
      "Run --setup first if you haven't created a MemWal account yet:\n" +
      '  npx tsx d1-memwal-roundtrip.ts --setup',
  );
  process.exit(1);
}

import { MemWal } from '@mysten-incubation/memwal';

console.log('D-1: MemWal roundtrip spike');
console.log('  Relayer:   ', RELAYER_URL);
console.log('  Account ID:', ACCOUNT_ID);

const memwal = MemWal.create({
  key: DELEGATE_KEY,
  accountId: ACCOUNT_ID,
  serverUrl: RELAYER_URL,
  namespace: 'memforks/spike/d1',
});

// ─── Step 1: health check ─────────────────────────────────────────────────────

const health = await memwal.health();
console.log('\n✓ Relayer health:', health.status, `(v${health.version})`);

// ─── Step 2: remember ────────────────────────────────────────────────────────

const FACTS = [
  'REST avg p99 is 180ms at 10k RPS',
  'GraphQL adds 30% overhead at p99 compared to REST',
  'MemForks D-1 spike: delegate auth works end-to-end on testnet',
];

console.log('\n→ Calling rememberAndWait()...');
const memResult = await memwal.rememberAndWait(FACTS.join('\n'));

console.log('✓ remember() result:');
console.log('  blob_id:   ', memResult.blob_id);
console.log('  namespace: ', memResult.namespace);
console.log('  owner:     ', memResult.owner);
console.log(
  '  → blob_id format confirmed (this is MemoryCommit.memwal_blob_id)',
);

// ─── Step 3: recall ──────────────────────────────────────────────────────────

console.log('\n→ Calling recall()...');
const recallResult = await memwal.recall({
  query: 'What do we know about API latency and REST performance?',
  limit: 3,
});

console.log('✓ recall() results:', recallResult.total, 'total');
recallResult.results.forEach((r, i) => {
  console.log(
    `  [${i}] distance=${r.distance.toFixed(4)}  blob_id=${r.blob_id}`,
  );
  console.log(
    `       text: "${r.text.slice(0, 100)}${r.text.length > 100 ? '...' : ''}"`,
  );
});

if (recallResult.results.length === 0) {
  throw new Error('recall returned empty — D-1 FAILED');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n=== D-1 PASSED ===');
console.log('Record these in SPIKES.md §D-1:');
console.log('  blob_id length:        ', memResult.blob_id.length);
console.log(
  '  recall distance range: ',
  recallResult.results.map((r) => r.distance.toFixed(4)).join(', '),
);
console.log('  relayer version:       ', health.version);
