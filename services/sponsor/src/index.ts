/**
 * MemForks Gas Sponsorship Service
 *
 * POST /sponsor
 *   Body:    { tx: string (serialized Transaction), sender: string (Sui address) }
 *   Returns: { txBytes: string (base64), sponsorSig: string }
 *
 * Security layers (in order of evaluation):
 *   1. Request body size cap (64 KB) — rejects oversized payloads before parsing.
 *   2. Sender address format validation — must be a valid 0x-prefixed 32-byte address.
 *   3. Per-IP rate limit — stops Sybil attacks (fresh addresses from one host).
 *   4. Per-address rate limit — per-identity ceiling.
 *   5. Global daily tx cap — absolute ceiling regardless of address/IP count.
 *   6. Transaction allowlist — only specific MemForks entry functions sponsored.
 *   7. Coin pool — concurrent coin claims are serialised; no two requests share a coin.
 *
 * Flow (per docs.sui.io/develop/transaction-payment/sponsor-txn):
 *   1. Client serializes an unsigned Transaction and POSTs it here with their address.
 *   2. All security layers run.
 *   3. Service adds gasOwner + gasPayment + gasBudget, builds final tx bytes, signs.
 *   4. Returns { txBytes, sponsorSig } to client.
 *   5. Client signs the same bytes (now with gas) and submits both sigs to Sui.
 */

import "dotenv/config";
import { Hono }        from "hono";
import type { Context } from "hono";
import { serve }       from "@hono/node-server";
import { Transaction } from "@mysten/sui/transactions";
import { validateTransaction, validateAddress, extractFunctions, MAX_BODY_BYTES, STRICT_FUNCTIONS, STRICT_IP_DAILY_MAX } from "./validate.js";
import {
  buildSuiClient,
  buildSponsorKeypair,
  loadCoinPool,
  claimGasCoin,
  GAS_BUDGET,
} from "./gas-pool.js";
import { checkRateLimit, checkStrictRateLimit, checkDripRateLimit } from "./rate-limit.js";

const app     = new Hono();
const client  = buildSuiClient();
const sponsor = buildSponsorKeypair();

// ─── Startup ───────────────────────────────────────────────────────────────────

console.log(`[sponsor] wallet:  ${sponsor.toSuiAddress()}`);
console.log(`[sponsor] network: ${process.env.SUI_NETWORK ?? "mainnet"}`);
console.log(`[sponsor] gas budget per tx: ${GAS_BUDGET} MIST`);

// Load gas coins at startup. Fail fast if wallet is empty.
await loadCoinPool(client, sponsor).catch((err) => {
  console.error("[sponsor] FATAL — cannot load gas pool:", err);
  process.exit(1);
});

// ─── Drip config ──────────────────────────────────────────────────────────────

// Amount sent per drip in MIST (1 SUI = 1_000_000_000 MIST).
// 0.02 SUI covers two MemWal on-chain calls (~2–5M MIST each) with 2× headroom.
const DRIP_AMOUNT_MIST       = Number(process.env.DRIP_AMOUNT_MIST       ?? 20_000_000);
// If the target address already has this much, skip the drip.
const DRIP_MIN_BALANCE_MIST  = Number(process.env.DRIP_MIN_BALANCE_MIST  ?? 5_000_000);
// Max drips per originating IP per 24 h.
const DRIP_IP_DAILY_MAX      = Number(process.env.DRIP_IP_DAILY_MAX      ?? 1);

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the real client IP, respecting common proxy headers. */
function getClientIp(c: Context): string {
  return (
    c.req.header("cf-connecting-ip") ??       // Cloudflare
    c.req.header("x-real-ip") ??              // nginx
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    "unknown"
  );
}

// ─── Health check ──────────────────────────────────────────────────────────────

// Deliberately does NOT expose the sponsor wallet address — no need to publish it.
app.get("/health", (c) => c.json({ ok: true, network: process.env.SUI_NETWORK ?? "mainnet" }));

// ─── Sponsor endpoint ──────────────────────────────────────────────────────────

app.post("/sponsor", async (c) => {
  const clientIp = getClientIp(c);

  // ── 1. Body size cap ─────────────────────────────────────────────────────────
  const contentLength = Number(c.req.header("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return c.json({ error: "request body too large" }, 413);
  }

  let body: { tx: string; sender: string };
  try {
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return c.json({ error: "request body too large" }, 413);
    }
    body = JSON.parse(raw) as { tx: string; sender: string };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const { tx: serialized, sender } = body;
  if (typeof serialized !== "string" || typeof sender !== "string") {
    return c.json({ error: "body must contain { tx: string, sender: string }" }, 400);
  }

  // ── 2. Sender address format ──────────────────────────────────────────────────
  const addrCheck = validateAddress(sender);
  if (!addrCheck.ok) {
    return c.json({ error: addrCheck.reason }, 400);
  }

  // ── 3–5. Rate limits (IP + address + daily cap) ───────────────────────────────
  const rl = checkRateLimit(sender, clientIp);
  if (!rl.allowed) {
    return c.json({ error: rl.reason }, 429);
  }

  // ── 6. Transaction allowlist ──────────────────────────────────────────────────
  const validation = validateTransaction(serialized);
  if (!validation.ok) {
    return c.json({ error: `tx rejected: ${validation.reason}` }, 403);
  }

  // ── 6b. Strict per-IP daily cap for sensitive functions (e.g. init_tree) ──────
  const calledFns = extractFunctions(serialized);
  for (const fn of calledFns) {
    if (STRICT_FUNCTIONS.has(fn)) {
      const strict = checkStrictRateLimit(clientIp, STRICT_IP_DAILY_MAX);
      if (!strict.allowed) {
        return c.json({ error: strict.reason }, 429);
      }
      break;
    }
  }

  // ── 7. Reconstruct Transaction and add gas ────────────────────────────────────
  let tx: Transaction;
  try {
    tx = Transaction.from(serialized);
  } catch (err) {
    return c.json({ error: `could not deserialize tx: ${String(err)}` }, 400);
  }

  // Set sender to the address the client claims. The client will sign the final
  // txBytes with their keypair — if the address is wrong, the signature won't
  // verify and Sui will reject the transaction. We cannot impersonate the sender.
  tx.setSender(sender);
  tx.setGasOwner(sponsor.toSuiAddress());

  // Atomically claim a gas coin — no two concurrent requests share a coin.
  let coinClaim: Awaited<ReturnType<typeof claimGasCoin>>;
  try {
    coinClaim = await claimGasCoin();
  } catch (err) {
    console.error("[sponsor] gas pool error:", err);
    return c.json({ error: "gas pool unavailable — try again later" }, 503);
  }

  tx.setGasBudget(GAS_BUDGET);
  tx.setGasPayment([coinClaim.coinRef]);

  // ── 8. Build, sign, return ────────────────────────────────────────────────────
  // Retry once if the gas coin is stale (version mismatch after a concurrent
  // drip). Reload the pool and claim a fresh coin, then rebuild.
  let txBytes:    Uint8Array;
  let sponsorSig: string;
  let buildAttempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      txBytes = await tx.build({ client });
      const signed = await sponsor.signTransaction(txBytes);
      sponsorSig = signed.signature;
      break;
    } catch (err) {
      const msg = String(err);
      const isStale =
        msg.includes("needs to be rebuilt") ||
        msg.includes("unavailable for consumption");

      if (isStale && buildAttempt === 0) {
        buildAttempt++;
        console.warn("[sponsor] stale gas coin — reloading pool and retrying");
        coinClaim.release();
        try {
          await loadCoinPool(client, sponsor);
          coinClaim = await claimGasCoin();
          tx.setGasPayment([coinClaim.coinRef]);
        } catch (poolErr) {
          console.error("[sponsor] pool reload failed:", poolErr);
          return c.json({ error: "gas pool unavailable — try again later" }, 503);
        }
        continue;
      }

      coinClaim.release();
      console.error("[sponsor] build/sign error:", err);
      return c.json({ error: `failed to build or sign tx: ${String(err)}` }, 500);
    }
  }

  coinClaim.release();
  console.log(`[sponsor] co-signed for ${sender} from ${clientIp}`);

  return c.json({
    txBytes:    Buffer.from(txBytes).toString("base64"),
    sponsorSig,
  });
});

// ─── Drip endpoint ─────────────────────────────────────────────────────────────
//
// POST /drip  { address: "0x..." }
//
// Sends a small SUI amount to a fresh address so it can pay gas for the two
// MemWal bootstrap calls (createAccount + addDelegateKey) during `memfork init`.
// After those two calls the address holds enough SUI to self-pay going forward,
// and all subsequent MemForks operations are covered by /sponsor.
//
// Guards:
//   1. Valid Sui address format.
//   2. 1 drip per originating IP per 24 h  (configurable via DRIP_IP_DAILY_MAX).
//   3. Skip if the address already has ≥ DRIP_MIN_BALANCE_MIST.

app.post("/drip", async (c) => {
  const clientIp = getClientIp(c);

  // ── Parse body ───────────────────────────────────────────────────────────────
  let body: { address: string };
  try {
    body = await c.req.json() as { address: string };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const recipient = body?.address;

  // ── Validate address ─────────────────────────────────────────────────────────
  const addrCheck = validateAddress(recipient);
  if (!addrCheck.ok) {
    return c.json({ error: addrCheck.reason }, 400);
  }

  // ── Rate limit: 1 drip per IP per day ────────────────────────────────────────
  const rl = checkDripRateLimit(clientIp, DRIP_IP_DAILY_MAX);
  if (!rl.allowed) {
    return c.json({ error: rl.reason }, 429);
  }

  // ── Balance check: skip if already funded ────────────────────────────────────
  try {
    const coins = await client.getCoins({ owner: recipient, coinType: "0x2::sui::SUI" });
    const total = (coins.data ?? []).reduce((sum, c) => sum + BigInt(c.balance), 0n);
    if (total >= BigInt(DRIP_MIN_BALANCE_MIST)) {
      console.log(`[drip] skip ${recipient} — already has ${total} MIST (from ${clientIp})`);
      return c.json({ skipped: true, message: "address already has sufficient balance", balance: total.toString() });
    }
  } catch (err) {
    // Balance check failed — proceed anyway; worst case is a double-drip.
    console.warn("[drip] balance check failed, proceeding:", err);
  }

  // ── Build and execute transfer ────────────────────────────────────────────────
  // The sponsor is the sender; it splits DRIP_AMOUNT_MIST off its own gas coin
  // and transfers it to the recipient. No co-signing needed.
  const tx = new Transaction();
  const [drip] = tx.splitCoins(tx.gas, [DRIP_AMOUNT_MIST]);
  tx.transferObjects([drip], recipient);

  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (client as any).signAndExecuteTransaction({ signer: sponsor, transaction: tx });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (client as any).waitForTransaction({ digest: result.digest });

    console.log(`[drip] sent ${DRIP_AMOUNT_MIST} MIST → ${recipient} (from ${clientIp}) tx: ${result.digest}`);

    // The drip's auto-selected gas coin is now at a new on-chain version, so the
    // pool's cached ref for it is stale. A subsequent /sponsor request that claims
    // it would fail with "Transaction needs to be rebuilt". We await the reload
    // BEFORE responding so the next request (the CLI fires initTree immediately
    // after this returns) sees a fresh pool — closing the race at the source.
    // Non-fatal: a reload failure must never turn a successful on-chain drip into
    // an error response (the /sponsor retry-on-stale path is the backstop).
    try {
      await loadCoinPool(client, sponsor);
    } catch (e) {
      console.warn("[drip] post-drip pool reload failed (non-fatal):", e);
    }

    return c.json({ digest: result.digest as string, amount: DRIP_AMOUNT_MIST });
  } catch (err) {
    console.error("[drip] execute failed:", err);
    return c.json({ error: `drip failed: ${String(err)}` }, 500);
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 3100);

serve({ fetch: app.fetch, port }, () => {
  console.log(`[sponsor] listening on :${port}`);
});
