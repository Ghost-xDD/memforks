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
  "0xc9f0a4964f810c794479bc5b66347998969d2c59d6797c313b8a96d2bdd6a914";

// Entry functions the sponsor will pay gas for.
const ALLOWED_FUNCTIONS = new Set([
  "init_tree",          // tree creation — rate-limited separately (1/IP/day)
  "grant_delegate",
  "revoke_delegate",
  "set_branch_authority",
  "branch",
  "propose_merge",
  "submit_attestation",
  "finalize_merge",
  "abort_merge",
  "claim_expired",
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
 * Parses the JSON emitted by `tx.serialize()` in the Sui TS SDK.
 * The structure is: { version, sender?, expiration?, gasData?, inputs, commands }
 */
export function validateTransaction(serialized: string): ValidationResult {
  // Size guard — large payloads are always suspicious.
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

  const tx       = parsed as Record<string, unknown>;
  const commands = tx["commands"] as Array<Record<string, unknown>> | undefined;

  if (!Array.isArray(commands) || commands.length === 0) {
    return { ok: false, reason: "tx has no commands" };
  }

  // Cap command count — a legitimate MemForks tx never needs more than a handful.
  if (commands.length > 10) {
    return { ok: false, reason: `tx has ${commands.length} commands; max is 10` };
  }

  for (const cmd of commands) {
    if (typeof cmd !== "object" || cmd === null) {
      return { ok: false, reason: "command is not an object" };
    }

    // Only MoveCall commands are allowed. No TransferObjects, SplitCoins, etc.
    const moveCall = cmd["MoveCall"] as Record<string, string> | undefined;
    if (!moveCall) {
      const kind = Object.keys(cmd)[0] ?? "unknown";
      return { ok: false, reason: `non-MoveCall command '${kind}' is not sponsored` };
    }

    const pkg  = moveCall["package"];
    const fn   = moveCall["function"];

    if (typeof pkg !== "string" || typeof fn !== "string") {
      return { ok: false, reason: "MoveCall is missing package or function field" };
    }

    if (pkg !== MEMFORK_PACKAGE_ID) {
      return {
        ok: false,
        reason: `tx calls non-MemForks package: ${pkg}`,
      };
    }

    if (!ALLOWED_FUNCTIONS.has(fn)) {
      return {
        ok: false,
        reason: `function '${fn}' is not on the sponsorship allowlist`,
      };
    }
  }

  return { ok: true };
}
