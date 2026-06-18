/**
 * `memfork ui` — local HTTP server.
 *
 * Serves the pre-built React app from apps/visualizer/dist/ as static files and
 * exposes two API routes so the React app can discover the current tree
 * config and recall MemWal facts without exposing credentials in the
 * browser bundle.
 *
 *   GET /api/config   → { treeId, packageId, network, rpcUrl, hasMemwal }
 *   GET /api/facts    → { facts: MemWal results[] }  (proxied server-side)
 *   GET /*            → index.html (SPA fallback)
 *   GET /assets/*     → static file
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { readProjectConfig, readCredentials, MEMWAL_CONSTANTS } from "../config.js";
import { MemWal } from "@mysten-incubation/memwal";
import { branchNamespace } from "@memfork/core";

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
  });
}

type RecallEntry = { blob_id: string; text: string; distance?: number };

/**
 * Per-namespace cache + global rate-limit backoff. The relayer caps usage at
 * 500 weighted-requests/hour, so we must avoid redundant calls:
 *
 *   • Cache each namespace's recall result for CACHE_TTL_MS — the /api/facts
 *     and /api/history endpoints both recall the same namespace, and the UI
 *     polls on a timer, so most requests are served from cache for free.
 *   • On a 429, parse retry_after_seconds and refuse ALL relayer calls until
 *     it elapses, serving stale cache instead. This stops the polling loop
 *     from continually re-arming the ban.
 */
const CACHE_TTL_MS = 60_000;
const recallCache = new Map<string, { ts: number; data: RecallEntry[] }>();
let rateLimitedUntil = 0;

function parseRetryAfterMs(err: string): number {
  const m = err.match(/retry_after_seconds"?\s*:\s*(\d+)/);
  const secs = m ? Number(m[1]) : 300;
  return secs * 1_000;
}

/**
 * Recall entries from a MemWal namespace using the SDK (signed requests),
 * with caching and 429 backoff. A single broad query at a high limit returns
 * the whole namespace, since recall returns the top-`limit` nearest entries
 * and namespaces typically hold fewer than `limit` commits.
 */
async function memwalRecall(
  relayer: string,
  key: string,
  accountId: string,
  namespace: string,
  limit = 200,
): Promise<RecallEntry[]> {
  const now    = Date.now();
  const cached = recallCache.get(namespace);

  // Fresh cache hit — no relayer call needed.
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.data;

  // In a rate-limit backoff window — serve stale cache (or empty), don't call.
  if (now < rateLimitedUntil) return cached?.data ?? [];

  const mw = MemWal.create({ key, accountId, serverUrl: relayer, namespace });
  const seen = new Set<string>();
  const out: RecallEntry[] = [];
  try {
    const result = await mw.recall({
      query: "facts decisions conventions setup errors architecture memory",
      limit,
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
      console.warn(
        `[memforks] MemWal rate limit hit — pausing relayer calls for ${Math.round(backoff / 1000)}s, serving cached data.`,
      );
    }
    // Serve stale cache if we have it; otherwise empty.
    return cached?.data ?? [];
  }
}

async function handleApiFacts(
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const branch  = url.searchParams.get("branch") ?? "main";
  const project = readProjectConfig();
  const creds   = readCredentials();
  const treeId  = project?.treeId ?? creds.default;
  const network = (project?.network ?? "mainnet") as "testnet" | "mainnet";
  const stored  = treeId ? creds.trees[treeId] : undefined;

  if (!stored?.memwalKey || !stored?.memwalAccountId || !treeId) {
    json(res, { facts: [] });
    return;
  }

  const relayer   = stored.memwalRelayer ?? MEMWAL_CONSTANTS[network].relayer;
  const namespace = branchNamespace(treeId, branch);

  try {
    const facts = await memwalRecall(relayer, stored.memwalKey, stored.memwalAccountId, namespace);
    json(res, { facts });
  } catch (e) {
    json(res, { facts: [], error: String(e) });
  }
}

/**
 * GET /api/history?branch=<name>&limit=<n>
 *
 * Returns all off-chain CommitPayload objects stored in MemWal for this branch,
 * sorted oldest-first. Each entry includes the MemWal blob_id plus the parsed
 * payload fields that the UI needs (branch, author, ts_ms, delta, parent_blob_ids).
 *
 * The browser cannot call MemWal directly (SEAL-encrypted, key lives server-side),
 * so this endpoint acts as the commit-history proxy.
 */
async function handleApiHistory(
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const branch  = url.searchParams.get("branch") ?? "main";
  const limit   = Math.min(Number(url.searchParams.get("limit") ?? "500"), 1000);
  const project = readProjectConfig();
  const creds   = readCredentials();
  const treeId  = project?.treeId ?? creds.default;
  const network = (project?.network ?? "mainnet") as "testnet" | "mainnet";
  const stored  = treeId ? creds.trees[treeId] : undefined;

  if (!stored?.memwalKey || !stored?.memwalAccountId || !treeId) {
    json(res, { commits: [] });
    return;
  }

  const relayer   = stored.memwalRelayer ?? MEMWAL_CONSTANTS[network].relayer;
  const namespace = branchNamespace(treeId, branch);

  try {
    const results = await memwalRecall(relayer, stored.memwalKey, stored.memwalAccountId, namespace, limit);

    const commits = results.flatMap((entry) => {
      const blobId = entry.blob_id;
      const text   = entry.text;

      // Try to parse the stored text as a CommitPayload JSON.
      let payload: Record<string, unknown> | null = null;
      try { payload = JSON.parse(text) as Record<string, unknown>; } catch { return []; }
      if (payload["type"] !== "commit") return [];

      return [{
        blob_id:           blobId,
        branch:            String(payload["branch"] ?? branch),
        ts_ms:             Number(payload["ts_ms"] ?? 0),
        parent_blob_ids:   (payload["parent_blob_ids"] as string[] | undefined) ?? [],
        parent_blob_hashes:(payload["parent_blob_hashes"] as string[] | undefined) ?? [],
        // Extract readable facts from the delta.
        message: (() => {
          const delta = payload["delta"] as Record<string, unknown> | undefined;
          const facts = delta?.["facts"] as string[] | undefined;
          return facts?.length ? facts[0] : `commit ${blobId.slice(0, 8)}`;
        })(),
        delta: payload["delta"] ?? {},
      }];
    });

    // Sort oldest-first by ts_ms.
    commits.sort((a, b) => a.ts_ms - b.ts_ms);

    json(res, { commits, branch });
  } catch (e) {
    json(res, { commits: [], error: String(e) });
  }
}

function serveStatic(
  res: http.ServerResponse,
  distDir: string,
  urlPath: string,
): void {
  // Resolve the requested file path.
  let filePath = path.join(distDir, urlPath);

  // SPA fallback: no extension or file not found → serve index.html.
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
    "Cache-Control": isImmutable
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Access-Control-Allow-Origin": "*",
  });
  fs.createReadStream(filePath).pipe(res);
}

export function startUiServer(distDir: string, port = 4242): http.Server {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    // CORS pre-flight.
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      res.end();
      return;
    }

    if (url.pathname === "/api/config") {
      handleApiConfig(res).catch((e) =>
        json(res, { error: String(e) }, 500),
      );
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
