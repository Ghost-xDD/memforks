/**
 * Opt-out anonymised SDK telemetry for @memfork/core.
 *
 * Emits counts and timing only — no query text, no fact content, no raw
 * namespace names. Namespace strings are SHA-256 hashed (first 16 hex chars)
 * before transmission.
 *
 * Opt out:  set MEMFORK_TELEMETRY=0  (or omit a sponsor/telemetry URL entirely)
 * Endpoint: MEMFORK_TELEMETRY_URL takes priority; otherwise the sponsor service
 *           base URL (MEMFORK_SPONSOR_URL or the sponsorUrl client option) is
 *           used with /ingest appended. If neither is configured, telemetry is
 *           silently disabled — nothing is sent and no error is thrown.
 *
 * All events are fire-and-forget with a 3 s abort timeout. They never throw,
 * never block the caller, and are not awaited in any hot path.
 */

export interface TelemetryEvent {
  op:           "commit" | "recall" | "branch" | "merge";
  namespace:    string;   // hashed before sending
  bytes?:       number;   // payload byte size (commit)
  resultCount?: number;   // results returned (recall)
  latencyMs?:   number;   // wall-clock duration
}

// Cache resolved endpoint per sponsor URL so we don't re-evaluate env vars on
// every call. null = explicitly disabled; undefined = not yet resolved.
const _cache = new Map<string, string | null>();

function resolveEndpoint(sponsorUrl?: string): string | null {
  const cacheKey = sponsorUrl ?? "__default__";
  if (_cache.has(cacheKey)) return _cache.get(cacheKey)!;

  // Hard opt-out.
  if (process.env["MEMFORK_TELEMETRY"] === "0") {
    _cache.set(cacheKey, null);
    return null;
  }

  // Explicit override wins.
  const explicit = process.env["MEMFORK_TELEMETRY_URL"];
  if (explicit) {
    _cache.set(cacheKey, explicit);
    return explicit;
  }

  // Derive from the client's sponsorUrl or the env var equivalent.
  const base = sponsorUrl ?? process.env["MEMFORK_SPONSOR_URL"];
  if (base) {
    const endpoint = base.replace(/\/$/, "") + "/ingest";
    _cache.set(cacheKey, endpoint);
    return endpoint;
  }

  // No URL available — telemetry silently disabled.
  _cache.set(cacheKey, null);
  return null;
}

async function sha256Short(input: string): Promise<string> {
  const bytes  = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

/**
 * Emit a telemetry event. Always fire-and-forget — safe to call without await.
 *
 * @param event     The event to record.
 * @param sponsorUrl Optional sponsor base URL (from MemForksClientConfig).
 *                   Used to derive the /ingest endpoint if MEMFORK_TELEMETRY_URL
 *                   is not set.
 */
export async function emitTelemetry(
  event:      TelemetryEvent,
  sponsorUrl?: string,
): Promise<void> {
  const endpoint = resolveEndpoint(sponsorUrl);
  if (!endpoint) return;

  try {
    const namespaceHash = await sha256Short(event.namespace);

    const payload: Record<string, unknown> = {
      op:             event.op,
      namespace_hash: namespaceHash,
    };
    if (event.bytes       !== undefined) payload["bytes"]        = event.bytes;
    if (event.resultCount !== undefined) payload["result_count"] = event.resultCount;
    if (event.latencyMs   !== undefined) payload["latency_ms"]   = event.latencyMs;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);

    fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    })
      .catch(() => { /* intentionally swallowed */ })
      .finally(() => clearTimeout(timer));

  } catch {
    // Never propagate telemetry errors to callers.
  }
}
