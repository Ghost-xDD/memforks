/**
 * One-shot script: split the sponsor wallet's single coin into 20 x 1 SUI coins.
 *
 * Run from the repo root:
 *   node scripts/split-sponsor-coins.mjs
 */

import {
  SuiJsonRpcClient as SuiClient,
  JsonRpcHTTPTransport,
  getJsonRpcFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Ed25519Keypair }     from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction }         from "@mysten/sui/transactions";

const PRIVATE_KEY  = process.env.SPONSOR_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Error: set SPONSOR_PRIVATE_KEY env var before running.");
  console.error("  Example: SPONSOR_PRIVATE_KEY=suiprivkey1q… node scripts/split-sponsor-coins.mjs");
  process.exit(1);
}

const COIN_ID      = process.env.COIN_ID ?? "0xdf6c611235121d275d4b572c4ac46c4659bd838b8f80815d0f60994bf36d8053";
const SPLIT_COUNT  = 20;
const AMOUNT_MIST  = 1_000_000_000n; // 1 SUI each
const GAS_BUDGET   = 20_000_000n;    // 0.02 SUI

// ── Keypair ─────────────────────────────────────────────────────────────────
const { secretKey } = decodeSuiPrivateKey(PRIVATE_KEY);
const keypair = Ed25519Keypair.fromSecretKey(secretKey);
const address = keypair.getPublicKey().toSuiAddress();

// ── Client ───────────────────────────────────────────────────────────────────
const client = new SuiClient({
  transport: new JsonRpcHTTPTransport({ url: getJsonRpcFullnodeUrl("mainnet") }),
  network: "mainnet",
});

console.log("Sponsor address :", address);
console.log(`Splitting ${COIN_ID.slice(0, 20)}… into ${SPLIT_COUNT} × ${Number(AMOUNT_MIST) / 1e9} SUI`);

// ── Fetch current object ref ─────────────────────────────────────────────────
const coinObj = await client.getObject({ id: COIN_ID, options: { showOwner: true } });
if (!coinObj.data) {
  console.error("Could not fetch coin object:", coinObj.error);
  process.exit(1);
}
const { version, digest } = coinObj.data;
console.log(`Coin version: ${version}  digest: ${digest}`);

// ── Build transaction ────────────────────────────────────────────────────────
const tx = new Transaction();
tx.setSender(address);
tx.setGasBudget(GAS_BUDGET);
tx.setGasPayment([{ objectId: COIN_ID, version, digest }]);

// splitCoins from tx.gas returns an array of coin results
const newCoins = tx.splitCoins(
  tx.gas,
  Array.from({ length: SPLIT_COUNT }, () => tx.pure.u64(AMOUNT_MIST)),
);

// Transfer all split coins back to the sponsor (explicit, no ambiguity)
tx.transferObjects(
  Array.from({ length: SPLIT_COUNT }, (_, i) => newCoins[i]),
  address,
);

// ── Sign & execute ───────────────────────────────────────────────────────────
console.log("\nSigning and submitting…");
const result = await client.signAndExecuteTransaction({
  transaction: tx,
  signer: keypair,
  options: { showEffects: true, showObjectChanges: true },
});

const status = result.effects?.status?.status;
if (status === "success") {
  const created = (result.objectChanges ?? []).filter(c => c.type === "created").length;
  console.log("\n✓ Split successful!");
  console.log("  Digest    :", result.digest);
  console.log(`  New coins : ${created} objects created`);
  console.log("\nRestart the sponsor service so loadCoinPool() picks up all coins.");
} else {
  console.error("\n✗ Transaction failed:");
  console.error(JSON.stringify(result.effects?.status, null, 2));
  process.exit(1);
}
