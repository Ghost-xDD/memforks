/**
 * `memfork ui` — local HTTP server.
 *
 * Serves the pre-built React app from packages/cli/ui/ as static files and
 * exposes API routes so the React app can query MemWal without exposing
 * credentials in the browser bundle.
 *
 *   GET /api/config               → { treeId, packageId, network, rpcUrl, hasMemwal, rateLimited, retryInSeconds }
 *   GET /api/history?branch=<b>[&force=1]  → { commits[], branch, rateLimited, retryInSeconds }
 *   GET /api/facts?branch=<b>[&force=1]    → { facts[], rateLimited, retryInSeconds }
 *   GET /*                        → index.html (SPA fallback)
 *   GET /assets/*                 → static file
 *
 * Rate-limit strategy (relayer caps at 500 weighted-req/hour):
 *   • In-memory per-namespace cache (CACHE_TTL_MS). Most poll ticks served free.
 *   • On a 429, parse retry_after_seconds, set global backoff in memory AND
 *     persist just the timestamp to .memfork/.ui-backoff.json (a plain number —
 *     no decrypted content ever written to disk). Loaded on server start so
 *     restarts during a ban don't fire immediately.
 *   • ?force=1 bypasses the TTL but still respects the backoff window.
 *   • All responses include rateLimited + retryInSeconds so the UI can show a
 *     banner instead of looking silently empty.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readProjectConfig, readCredentials, MEMWAL_CONSTANTS } from "../config.js";
import { MemWal } from "@mysten-incubation/memwal";
import { branchNamespace } from "@memfork/core";

// ─── Static file serving ─────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  ".html":  "text/html; charset=utf-8",
  ".js":    "application/javascript",
  ".mjs":   "application/javascript",
  ".css":   "text/css",
  ".svg":   "image/svg+xml",
  ".png":   "image/png",
  ".jpg":   "image/jpeg",
  ".ico":   "image/x-icon",
  ".json":  "application/json",
  ".woff":  "font/woff",
  ".woff2": "font/woff2",
  ".map":   "application/json",
};

function getMime(filePath: string): string {
  return MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function json(res: http.ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control":               "no-store",
  });
  res.end(body);
}

// ─── Rate-limit state ─────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60_000;
const RECALL_LIMIT = 50;

type RecallEntry = { blob_id: string; text: string; distance?: number };
const recallCache = new Map<string, { ts: number; data: RecallEntry[] }>();
let rateLimitedUntil = 0;

/** Path used to persist the ban timestamp across restarts. Plain number only. */
function backoffFilePath(): string | null {
  try {
    // Walk up from cwd looking for .memfork/ — same logic as config resolution.
    let dir = process.cwd();
    while (true) {
      const candidate = path.join(dir, ".memfork");
      if (fs.existsSync(candidate)) return path.join(candidate, ".ui-backoff.json");
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    // Fallback: home dir .memfork/
    return path.join(os.homedir(), ".memfork", ".ui-backoff.json");
  } catch {
    return null;
  }
}

/** Load a persisted backoff timestamp so restarts during a ban stay quiet. */
function loadPersistedBackoff(): void {
  try {
    const p = backoffFilePath();
    if (!p || !fs.existsSync(p)) return;
    const { rateLimitedUntil: saved } = JSON.parse(fs.readFileSync(p, "utf8")) as {
      rateLimitedUntil?: number;
    };
    if (typeof saved === "number" && saved > Date.now()) {
      rateLimitedUntil = saved;
      console.warn(
        `[memforks] Rate-limit backoff active from previous run — pausing relayer calls for ${Math.round((saved - Date.now()) / 1000)}s.`,
      );
    }
  } catch { /* ignore — bad file, no problem */ }
}

function persistBackoff(until: number): void {
  try {
    const p = backoffFilePath();
    if (!p) return;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ rateLimitedUntil: until }));
  } catch { /* best-effort */ }
}

function parseRetryAfterMs(err: string): number {
  const m = err.match(/retry_after_seconds"?\s*:\s*(\d+)/);
  const secs = m ? Number(m[1]) : 300;
  return secs * 1_000;
}

function rateLimitStatus(): { rateLimited: boolean; retryInSeconds: number } {
  const remaining = rateLimitedUntil - Date.now();
  return remaining > 0
    ? { rateLimited: true,  retryInSeconds: Math.ceil(remaining / 1000) }
    : { rateLimited: false, retryInSeconds: 0 };
}

// ─── MemWal recall (cached + rate-limit-aware) ────────────────────────────────

/**
 * Recall entries from a MemWal namespace. Uses the SDK so requests are
 * properly signed (plain Bearer tokens are rejected by the relayer).
 *
 * - Fresh cache hit (< CACHE_TTL_MS): returns immediately, no relayer call.
 * - In backoff window: returns stale cache (or []), no relayer call.
 * - force=true: bypasses TTL but still respects the backoff window.
 * - On 429: sets + persists backoff, returns stale cache.
 */
async function memwalRecall(
  relayer: string,
  key: string,
  accountId: string,
  namespace: string,
  force = false,
): Promise<RecallEntry[]> {
  const now    = Date.now();
  const cached = recallCache.get(namespace);

  if (!force && cached && now - cached.ts < CACHE_TTL_MS) return cached.data;
  if (now < rateLimitedUntil) return cached?.data ?? [];

  const mw = MemWal.create({ key, accountId, serverUrl: relayer, namespace });
  const seen = new Set<string>();
  const out: RecallEntry[] = [];

  try {
    const result = await mw.recall({
      query: "facts decisions conventions setup errors architecture memory",
      limit: RECALL_LIMIT,
    });
    for (const r of result.results) {
      const blobId = String(r.blob_id ?? "");
      if (blobId && !seen.has(blobId)) {
        seen.add(blobId);
        out.push({ blob_id: blobId, text: String(r.text ?? ""), distance: r.distance });
      }
    }
    recallCache.set(namespace, { ts: now, data: out });
    return out;
  } catch (e) {
    const msg = String(e);
    if (msg.includes("429")) {
      const backoff = parseRetryAfterMs(msg);
      rateLimitedUntil = Date.now() + backoff;
      persistBackoff(rateLimitedUntil);
      console.warn(
        `[memforks] Rate limit hit — pausing relayer calls for ${Math.round(backoff / 1000)}s.`,
      );
    }
    return cached?.data ?? [];
  }
}

// ─── Shared credential resolver ───────────────────────────────────────────────

interface MemwalCreds {
  relayer: string;
  key: string;
  accountId: string;
  treeId: string;
  namespace: (branch: string) => string;
}

function resolveMemwalCreds(branch: string): MemwalCreds | null {
  const project = readProjectConfig();
  const creds   = readCredentials();
  const treeId  = project?.treeId ?? creds.default;
  const network = (project?.network ?? "mainnet") as "testnet" | "mainnet";
  const stored  = treeId ? creds.trees[treeId] : undefined;
  if (!stored?.memwalKey || !stored?.memwalAccountId || !treeId) return null;
  return {
    relayer:   stored.memwalRelayer ?? MEMWAL_CONSTANTS[network].relayer,
    key:       stored.memwalKey,
    accountId: stored.memwalAccountId,
    treeId,
    namespace: (b: string) => branchNamespace(treeId, b),
  };
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleApiConfig(res: http.ServerResponse): Promise<void> {
  const project = readProjectConfig();
  const creds   = readCredentials();
  const treeId  = project?.treeId ?? creds.default ?? null;
  const network = (project?.network ?? "mainnet") as "testnet" | "mainnet";
  const stored  = treeId ? creds.trees[treeId] : undefined;

  json(res, {
    treeId,
    packageId:  project?.packageId ?? "0xc13cc014fb8084b3468f6e5ffdc272e64ef35b7a912332eba7a0d44dd66b3121",
    network,
    rpcUrl:     project?.rpcUrl ?? null,
    hasMemwal:  !!(stored?.memwalKey && stored?.memwalAccountId),
    ...rateLimitStatus(),
  });
}

async function handleApiFacts(
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const branch = url.searchParams.get("branch") ?? "main";
  const force  = url.searchParams.get("force") === "1";
  const mc     = resolveMemwalCreds(branch);
  if (!mc) { json(res, { facts: [], ...rateLimitStatus() }); return; }

  try {
    const facts = await memwalRecall(mc.relayer, mc.key, mc.accountId, mc.namespace(branch), force);
    json(res, { facts, ...rateLimitStatus() });
  } catch (e) {
    json(res, { facts: [], error: String(e), ...rateLimitStatus() });
  }
}

async function handleApiHistory(
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const branch = url.searchParams.get("branch") ?? "main";
  const force  = url.searchParams.get("force") === "1";
  const mc     = resolveMemwalCreds(branch);
  if (!mc) { json(res, { commits: [], ...rateLimitStatus() }); return; }

  try {
    const results = await memwalRecall(mc.relayer, mc.key, mc.accountId, mc.namespace(branch), force);

    const commits = results.flatMap((entry) => {
      let payload: Record<string, unknown> | null = null;
      try { payload = JSON.parse(entry.text) as Record<string, unknown>; } catch { return []; }
      if (payload["type"] !== "commit") return [];

      const delta = payload["delta"] as Record<string, unknown> | undefined;
      const facts = delta?.["facts"] as string[] | undefined;
      const artifacts = delta?.["artifacts"] as unknown[] | undefined;

      return [{
        blob_id:            entry.blob_id,
        branch:             String(payload["branch"] ?? branch),
        ts_ms:              Number(payload["ts_ms"] ?? 0),
        parent_blob_ids:    (payload["parent_blob_ids"]    as string[] | undefined) ?? [],
        parent_blob_hashes: (payload["parent_blob_hashes"] as string[] | undefined) ?? [],
        message:            facts?.length ? facts[0] : `commit ${entry.blob_id.slice(0, 8)}`,
        delta:              payload["delta"] ?? {},
        ...(artifacts?.length ? { artifacts } : {}),
      }];
    });

    commits.sort((a, b) => a.ts_ms - b.ts_ms);
    json(res, { commits, branch, ...rateLimitStatus() });
  } catch (e) {
    json(res, { commits: [], error: String(e), ...rateLimitStatus() });
  }
}

// ─── Static serving ───────────────────────────────────────────────────────────

function serveStatic(
  res: http.ServerResponse,
  distDir: string,
  urlPath: string,
): void {
  let filePath = path.join(distDir, urlPath);
  if (!path.extname(filePath) || !fs.existsSync(filePath)) {
    filePath = path.join(distDir, "index.html");
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const mimeType = getMime(filePath);
  const isImmutable = urlPath.startsWith("/assets/");
  res.writeHead(200, {
    "Content-Type": mimeType,
    "Cache-Control": isImmutable ? "public, max-age=31536000, immutable" : "no-cache",
    "Access-Control-Allow-Origin": "*",
  });
  fs.createReadStream(filePath).pipe(res);
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function startUiServer(distDir: string, port = 4242): http.Server {
  loadPersistedBackoff();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      res.end();
      return;
    }

    if (url.pathname === "/api/config") {
      handleApiConfig(res).catch((e) => json(res, { error: String(e) }, 500));
      return;
    }
    if (url.pathname === "/api/facts") {
      handleApiFacts(res, url).catch((e) =>
        json(res, { facts: [], error: String(e) }, 500),
      );
      return;
    }
    if (url.pathname === "/api/history") {
      handleApiHistory(res, url).catch((e) =>
        json(res, { commits: [], error: String(e) }, 500),
      );
      return;
    }

    serveStatic(res, distDir, url.pathname);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log(`  http://localhost:${port}`);
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") {
      console.error(`  Port ${port} is already in use. Is memfork ui already running?`);
      process.exit(1);
    }
    throw e;
  });

  return server;
}
