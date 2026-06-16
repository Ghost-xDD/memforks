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

async function memwalSearch(
  relayer: string,
  key: string,
  accountId: string,
  namespace: string,
  limit = 200,
): Promise<unknown[]> {
  const upstream = await fetch(`${relayer}/api/search`, {
    method: "POST",
    headers: {
      "Content-Type":        "application/json",
      "Authorization":       `Bearer ${key}`,
      "x-memwal-account-id": accountId,
    },
    body: JSON.stringify({ query: "", namespace, limit }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!upstream.ok) return [];
  const data = await upstream.json() as Record<string, unknown>;
  return (data["results"] ?? data["entries"] ?? []) as unknown[];
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
  const treeHex   = treeId.startsWith("0x") ? treeId.slice(2) : treeId;
  const namespace = `memforks/${treeHex}/${branch}`;

  try {
    const facts = await memwalSearch(relayer, stored.memwalKey, stored.memwalAccountId, namespace);
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
  const treeHexH  = treeId.startsWith("0x") ? treeId.slice(2) : treeId;
  const namespace = `memforks/${treeHexH}/${branch}`;

  try {
    const results = await memwalSearch(relayer, stored.memwalKey, stored.memwalAccountId, namespace, limit);

    const commits = results.flatMap((entry) => {
      const e = entry as Record<string, unknown>;
      const blobId = String(e["blob_id"] ?? "");
      const text   = String(e["text"] ?? "");

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
