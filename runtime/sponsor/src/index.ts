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
import { Transaction } from "@mysten/sui/transactions";
import { validateTransaction, validateAddress, MAX_BODY_BYTES, STRICT_FUNCTIONS, STRICT_IP_DAILY_MAX } from "./validate.js";
import {
  buildSuiClient,
  buildSponsorKeypair,
  loadCoinPool,
  claimGasCoin,
  GAS_BUDGET,
} from "./gas-pool.js";
import { checkRateLimit, checkStrictRateLimit } from "./rate-limit.js";

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

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Extract the real client IP, respecting common proxy headers. */
function getClientIp(c: Parameters<Parameters<typeof app.post>[1]>[0]): string {
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
  // Detect whether this tx contains a strict function by re-parsing the commands.
  // Cheap — validation already confirmed valid JSON with valid structure.
  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const commands = parsed["commands"] as Array<Record<string, unknown>>;
    for (const cmd of commands) {
      const fn = (cmd["MoveCall"] as Record<string, string> | undefined)?.["function"];
      if (fn && STRICT_FUNCTIONS.has(fn)) {
        const strict = checkStrictRateLimit(clientIp, STRICT_IP_DAILY_MAX);
        if (!strict.allowed) {
          return c.json({ error: strict.reason }, 429);
        }
        break; // only need one match to trigger the check
      }
    }
  } catch { /* validation already passed — this parse is safe; ignore */ }

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
  let txBytes:    Uint8Array;
  let sponsorSig: string;
  try {
    txBytes = await tx.build({ client });
    const signed = await sponsor.signTransaction(txBytes);
    sponsorSig   = signed.signature;
  } catch (err) {
    coinClaim.release();
    console.error("[sponsor] build/sign error:", err);
    return c.json({ error: `failed to build or sign tx: ${String(err)}` }, 500);
  }

  coinClaim.release();
  console.log(`[sponsor] co-signed for ${sender} from ${clientIp}`);

  return c.json({
    txBytes:    Buffer.from(txBytes).toString("base64"),
    sponsorSig,
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 3100);
console.log(`[sponsor] listening on :${port}`);

export default { port, fetch: app.fetch };
