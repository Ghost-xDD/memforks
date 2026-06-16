/**
 * Gas pool — manages the sponsor's SUI coins used to pay gas.
 *
 * Concurrency safety:
 *   Sui requires that the gas coin's object version in the transaction matches
 *   the version on-chain at submission time. If two concurrent requests pick the
 *   same coin, one transaction will fail with "object version mismatch".
 *
 *   We solve this with a simple in-process round-robin pool. On startup the pool
 *   is loaded with all available SUI coins. Each request atomically claims one
 *   coin (removing it from the available set). The claimed coin is returned to
 *   the pool after the transaction is finalised — or discarded and refreshed if
 *   it's been used (its version changed on-chain).
 *
 *   For production at scale, replace the in-process pool with a Redis-backed
 *   distributed lock. The in-process pool is correct for a single-instance deploy.
 *
 * Setup:
 *   Pre-split the sponsor wallet into N coins so concurrent requests can each
 *   claim a different coin:
 *     sui client split-coin --coin-id <ID> --amounts <MIST>... --gas-budget 10000000
 *
 *   N = expected peak concurrent sponsorships. 20 coins covers most cases.
 */

import {
  SuiJsonRpcClient as SuiClient,
  JsonRpcHTTPTransport,
  getJsonRpcFullnodeUrl,
} from "@mysten/sui/jsonRpc";
import { Ed25519Keypair }   from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";

export interface CoinRef {
  objectId: string;
  version:  string;
  digest:   string;
}

export const GAS_BUDGET = Number(process.env.SPONSOR_GAS_BUDGET ?? 10_000_000); // 0.01 SUI

// ─── In-process coin pool ──────────────────────────────────────────────────────

// Coins available for sponsorship. Loaded at startup, rotated at runtime.
let coinPool: CoinRef[] = [];
let poolLoaded = false;

export function buildSuiClient(): SuiClient {
  const network = (process.env.SUI_NETWORK ?? "mainnet") as "mainnet" | "testnet";
  const rpcUrl  = process.env.SUI_RPC_URL ?? getJsonRpcFullnodeUrl(network);
  return new SuiClient({ transport: new JsonRpcHTTPTransport({ url: rpcUrl }), network });
}

export function buildSponsorKeypair(): Ed25519Keypair {
  const raw = process.env.SPONSOR_PRIVATE_KEY;
  if (!raw) throw new Error("SPONSOR_PRIVATE_KEY env var is required");

  if (raw.startsWith("suiprivkey")) {
    const { secretKey } = decodeSuiPrivateKey(raw);
    return Ed25519Keypair.fromSecretKey(secretKey);
  }
  return Ed25519Keypair.fromSecretKey(Buffer.from(raw, "hex"));
}

/**
 * Load (or refresh) the coin pool from the sponsor wallet.
 * Called once at startup and whenever the pool runs dry.
 */
export async function loadCoinPool(client: SuiClient, sponsor: Ed25519Keypair): Promise<void> {
  const address = sponsor.toSuiAddress();
  const coins   = await client.getCoins({ owner: address, coinType: "0x2::sui::SUI" });

  if (coins.data.length === 0) {
    throw new Error(
      `Sponsor wallet ${address} has no SUI coins. ` +
      "Fund the wallet before starting the sponsor service.",
    );
  }

  // Only include coins large enough to cover the gas budget.
  const usable = coins.data.filter((c) => BigInt(c.balance) >= BigInt(GAS_BUDGET));
  if (usable.length === 0) {
    throw new Error(
      `No sponsor coins have sufficient balance for gas budget ${GAS_BUDGET} MIST. ` +
      "Top up the sponsor wallet.",
    );
  }

  coinPool = usable.map((c) => ({
    objectId: c.coinObjectId,
    version:  c.version,
    digest:   c.digest,
  }));

  console.log(`[gas-pool] loaded ${coinPool.length} gas coin(s)`);
  poolLoaded = true;
}

/**
 * Atomically claim a gas coin from the pool.
 * Returns the coin ref and two callbacks:
 *   release(used)  — call after a tx attempt:
 *     used=true  → coin version changed on-chain; discard it (reloadPool will refresh)
 *     used=false → tx failed before submission; put the coin back immediately
 *
 * If the pool is empty, waits up to 5 seconds for a coin to become available.
 * Pass client+sponsor so the last-resort reload can run if the pool stays empty.
 */
export async function claimGasCoin(
  client: SuiClient,
  sponsor: Ed25519Keypair,
): Promise<{ coinRef: CoinRef; release: (used: boolean) => void }> {
  const deadline = Date.now() + 5_000;

  while (Date.now() < deadline) {
    const coin = coinPool.shift();
    if (coin) {
      return {
        coinRef: coin,
        release: (used: boolean) => {
          if (!used) {
            // Tx never reached the chain — coin version is still current; recycle it.
            coinPool.unshift(coin);
          }
          // used=true: version changed on-chain; the background reload in index.ts
          // will refetch it at its new version. Don't add stale ref back.
        },
      };
    }
    // Pool momentarily empty — wait briefly and retry.
    await new Promise((r) => setTimeout(r, 100));
  }

  // Last resort: try a synchronous reload before giving up. This covers the case
  // where the background reload failed (flaky RPC) and left the pool empty.
  try {
    await loadCoinPool(client, sponsor);
    const coin = coinPool.shift();
    if (coin) {
      return {
        coinRef: coin,
        release: (used: boolean) => {
          if (!used) coinPool.unshift(coin);
        },
      };
    }
  } catch {
    // loadCoinPool already logs; fall through to the error below.
  }

  throw new Error(
    "Gas pool exhausted — all coins are in-flight or wallet is empty. " +
    "Add more coins to the sponsor wallet (sui client split-coin) or reduce concurrency.",
  );
}

export { poolLoaded };
