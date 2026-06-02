/**
 * `memfork ui` — local HTTP server.
 *
 * Serves the pre-built React app from app/dist/ as static files and
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
  const network = (project?.network ?? "testnet") as "testnet" | "mainnet";
  const stored  = treeId ? creds.trees[treeId] : undefined;

  json(res, {
    treeId,
    packageId:  project?.packageId ?? "0xc9f0a4964f810c794479bc5b66347998969d2c59d6797c313b8a96d2bdd6a914",
    network,
    rpcUrl:     project?.rpcUrl ?? null,
    hasMemwal:  !!(stored?.memwalKey && stored?.memwalAccountId),
  });
}

async function handleApiFacts(
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  const branch  = url.searchParams.get("branch") ?? "main";
  const project = readProjectConfig();
  const creds   = readCredentials();
  const treeId  = project?.treeId ?? creds.default;
  const network = (project?.network ?? "testnet") as "testnet" | "mainnet";
  const stored  = treeId ? creds.trees[treeId] : undefined;

  if (!stored?.memwalKey || !stored?.memwalAccountId || !treeId) {
    json(res, { facts: [] });
    return;
  }

  const relayer    = stored.memwalRelayer ?? MEMWAL_CONSTANTS[network].relayer;
  const namespace  = `memforks/${treeId.slice(2, 10)}/${branch}`;

  try {
    const upstream = await fetch(`${relayer}/api/search`, {
      method: "POST",
      headers: {
        "Content-Type":        "application/json",
        "Authorization":       `Bearer ${stored.memwalKey}`,
        "x-memwal-account-id": stored.memwalAccountId,
      },
      body: JSON.stringify({ query: "", namespace, limit: 200 }),
      signal: AbortSignal.timeout(8_000),
    });

    if (!upstream.ok) {
      json(res, { facts: [], error: `MemWal returned ${upstream.status}` });
      return;
    }

    const data = await upstream.json() as Record<string, unknown>;
    json(res, { facts: data["results"] ?? data["entries"] ?? [] });
  } catch (e) {
    json(res, { facts: [], error: String(e) });
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
