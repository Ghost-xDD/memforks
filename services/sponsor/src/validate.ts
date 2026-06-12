/**
 * Transaction validation — ensures the sponsor only co-signs MemForks operations.
 *
 * Defence-in-depth approach:
 *   1. Body size cap (enforced upstream before this is called).
 *   2. Sender address format check.
 *   3. Command-level allowlist: only specific MemForks entry functions accepted.
 *   4. `init_tree` is intentionally excluded — it requires prior registration
 *      to prevent Sybil tree creation on the sponsor's SUI.
 *   5. No non-MoveCall commands (TransferObjects, SplitCoins, etc.) allowed.
 */

// The MemForks package ID. Override via MEMFORK_PACKAGE_ID env var.
const MEMFORK_PACKAGE_ID =
  process.env.MEMFORK_PACKAGE_ID ??
  "0x7df9719d799386d34d657c49ae8cd6f5f03b39036f7c428b556095e42afd852f";

// Entry functions the sponsor will pay gas for.
const ALLOWED_FUNCTIONS = new Set([
  "init_tree",                  // tree creation — rate-limited separately (1/IP/day)
  "grant_delegate",
  "revoke_delegate",
  "set_branch_authority",
  "branch",
  "propose_merge",
  "submit_attestation",
  "finalize_merge",
  "abort_merge",
  "claim_expired",
  "create_and_keep_resolver",   // one-time setup per tree — safe to sponsor
]);

// Functions with a stricter per-IP daily cap (separate from the main rate limit).
// init_tree: a developer only needs to create one tree. 1/IP/day is generous for
// legitimate use and expensive enough to deter Sybil attacks (need real IPs).
export const STRICT_FUNCTIONS = new Set(["init_tree"]);
export const STRICT_IP_DAILY_MAX = Number(process.env.RATE_INIT_TREE_PER_IP_DAY ?? 1);

// Sui addresses are 32-byte hex strings prefixed with 0x (66 chars total).
const SUI_ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/;

// Maximum allowed serialized tx size (64 KB — well above any real MemForks tx).
export const MAX_BODY_BYTES = 64 * 1024;

export interface ValidationResult {
  ok: boolean;
  reason?: string;
}

/** Validate a Sui address string. */
export function validateAddress(addr: string): ValidationResult {
  if (typeof addr !== "string" || !SUI_ADDRESS_RE.test(addr)) {
    return { ok: false, reason: `invalid Sui address format: ${addr}` };
  }
  return { ok: true };
}

/**
 * Validate that a serialized Transaction only calls MemForks entry functions.
 *
 * Parses the JSON emitted by `tx.serialize()` in the Sui TS SDK (v2.x).
 * The structure is:
 *   { version, expiration, gasConfig, inputs, transactions: [ { kind, target, ... } ] }
 *
 * `target` format: "<packageId>::<module>::<function>"
 */
export function validateTransaction(serialized: string): ValidationResult {
  if (Buffer.byteLength(serialized, "utf8") > MAX_BODY_BYTES) {
    return { ok: false, reason: "serialized tx exceeds 64 KB size limit" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return { ok: false, reason: "tx is not valid JSON" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ok: false, reason: "tx must be a JSON object" };
  }

  const tx = parsed as Record<string, unknown>;

  // Sui SDK v2.x serializes commands under "transactions", not "commands".
  const txns = tx["transactions"] as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(txns) || txns.length === 0) {
    return { ok: false, reason: "tx has no commands" };
  }

  if (txns.length > 10) {
    return { ok: false, reason: `tx has ${txns.length} commands; max is 10` };
  }

  for (const cmd of txns) {
    if (typeof cmd !== "object" || cmd === null) {
      return { ok: false, reason: "command is not an object" };
    }

    const kind = cmd["kind"] as string | undefined;

    // Only MoveCall commands are allowed.
    if (kind !== "MoveCall") {
      return { ok: false, reason: `non-MoveCall command '${kind ?? "unknown"}' is not sponsored` };
    }

    // target = "<packageId>::<module>::<function>"
    const target = cmd["target"] as string | undefined;
    if (typeof target !== "string" || !target.includes("::")) {
      return { ok: false, reason: "MoveCall is missing or malformed target field" };
    }

    const [pkg, , fn] = target.split("::");

    if (pkg !== MEMFORK_PACKAGE_ID) {
      return { ok: false, reason: `tx calls non-MemForks package: ${pkg}` };
    }

    if (!ALLOWED_FUNCTIONS.has(fn)) {
      return { ok: false, reason: `function '${fn}' is not on the sponsorship allowlist` };
    }
  }

  return { ok: true };
}

/**
 * Extract the set of function names called in a serialized transaction.
 * Used by index.ts to check for strict-rate-limited functions (e.g. init_tree).
 */
export function extractFunctions(serialized: string): string[] {
  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    const txns = parsed["transactions"] as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(txns)) return [];
    return txns
      .filter(cmd => cmd["kind"] === "MoveCall")
      .map(cmd => {
        const target = cmd["target"] as string | undefined;
        return target ? target.split("::")[2] ?? "" : "";
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}
