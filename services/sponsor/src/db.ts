/**
 * Persistent storage for the sponsor service via libsql / Turso.
 *
 * Connection config (env vars):
 *   LIBSQL_URL          — libsql://xxx.turso.io  (production, Turso)
 *                         file:./sponsor.db       (local dev, no auth needed)
 *                         Defaults to file:./sponsor.db when unset.
 *   LIBSQL_AUTH_TOKEN   — required for remote Turso URLs, omit for file://
 *
 * Two tables:
 *   sponsor_events   — every /drip and /sponsor call.
 *                      Makes METRICS.md Tier 2 real: DAU/MAU, retention, op breakdown.
 *   telemetry_events — SDK commit/recall/branch/merge counts from @memfork/core.
 *                      Makes METRICS.md Tier 3a real: active depth, recall hit rate.
 *
 * IP addresses are one-way hashed (SHA-256 prefix) before storage.
 * No query text, no fact content, no raw namespace names are stored here.
 */

import { createClient } from "@libsql/client";
import { createHash }   from "node:crypto";

const url       = process.env["LIBSQL_URL"]       ?? "file:./sponsor.db";
const authToken = process.env["LIBSQL_AUTH_TOKEN"];

export const db = createClient({ url, ...(authToken ? { authToken } : {}) });

console.log(`[db] libsql: ${url.startsWith("file:") ? url : url.replace(/\/\/.*?\./, "//<host>.")}`);

// ─── Migrations ───────────────────────────────────────────────────────────────

export async function migrate(): Promise<void> {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS sponsor_events (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      ts        INTEGER NOT NULL,
      endpoint  TEXT    NOT NULL,
      address   TEXT    NOT NULL,
      tx_kind   TEXT,
      ip_hash   TEXT    NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_se_ts       ON sponsor_events(ts)`,
    `CREATE INDEX IF NOT EXISTS idx_se_address  ON sponsor_events(address)`,
    `CREATE INDEX IF NOT EXISTS idx_se_endpoint ON sponsor_events(endpoint)`,
    `CREATE TABLE IF NOT EXISTS telemetry_events (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ts             INTEGER NOT NULL,
      op             TEXT    NOT NULL,
      namespace_hash TEXT    NOT NULL,
      bytes          INTEGER,
      result_count   INTEGER,
      latency_ms     INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_te_ts ON telemetry_events(ts)`,
    `CREATE INDEX IF NOT EXISTS idx_te_op ON telemetry_events(op)`,
    `CREATE INDEX IF NOT EXISTS idx_te_ns ON telemetry_events(namespace_hash)`,
  ], "deferred");
  console.log("[db] migrations applied");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

// ─── Write helpers ─────────────────────────────────────────────────────────────

export async function recordSponsor(opts: {
  endpoint: "drip" | "sponsor";
  address:  string;
  txKind?:  string;
  ip:       string;
}): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO sponsor_events (ts, endpoint, address, tx_kind, ip_hash)
            VALUES (?, ?, ?, ?, ?)`,
      args: [Date.now(), opts.endpoint, opts.address, opts.txKind ?? null, hashIp(opts.ip)],
    });
  } catch (err) {
    console.warn("[db] recordSponsor failed (non-fatal):", err);
  }
}

export async function recordTelemetry(opts: {
  op:            string;
  namespaceHash: string;
  bytes?:        number;
  resultCount?:  number;
  latencyMs?:    number;
}): Promise<void> {
  try {
    await db.execute({
      sql: `INSERT INTO telemetry_events (ts, op, namespace_hash, bytes, result_count, latency_ms)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [
        Date.now(),
        opts.op,
        opts.namespaceHash,
        opts.bytes       ?? null,
        opts.resultCount ?? null,
        opts.latencyMs   ?? null,
      ],
    });
  } catch (err) {
    console.warn("[db] recordTelemetry failed (non-fatal):", err);
  }
}

// ─── Metrics queries ──────────────────────────────────────────────────────────

const DAY  = 86_400_000;
const WEEK = 7  * DAY;
const MON  = 30 * DAY;

export async function getMetrics() {
  const now = Date.now();

  const [[totalUsers], [newUsersWeek], [dau], [wau], [mau], [retD1], [retD7], opBreakdown, telByOp, [activeNs], [recallHit], [totalCommits], [totalRecalls]] =
    await Promise.all([
      db.execute({ sql: `SELECT COUNT(DISTINCT address) AS n FROM sponsor_events WHERE endpoint = 'drip'`, args: [] }),
      db.execute({ sql: `SELECT COUNT(DISTINCT address) AS n FROM sponsor_events WHERE endpoint = 'drip' AND ts > ?`, args: [now - WEEK] }),
      db.execute({ sql: `SELECT COUNT(DISTINCT address) AS n FROM sponsor_events WHERE endpoint = 'sponsor' AND ts > ?`, args: [now - DAY] }),
      db.execute({ sql: `SELECT COUNT(DISTINCT address) AS n FROM sponsor_events WHERE endpoint = 'sponsor' AND ts > ?`, args: [now - WEEK] }),
      db.execute({ sql: `SELECT COUNT(DISTINCT address) AS n FROM sponsor_events WHERE endpoint = 'sponsor' AND ts > ?`, args: [now - MON] }),
      db.execute({
        sql: `SELECT COUNT(DISTINCT d.address) AS n
              FROM sponsor_events d JOIN sponsor_events s ON d.address = s.address
              WHERE d.endpoint = 'drip' AND s.endpoint = 'sponsor'
                AND s.ts BETWEEN d.ts AND d.ts + ?`,
        args: [DAY],
      }),
      db.execute({
        sql: `SELECT COUNT(DISTINCT d.address) AS n
              FROM sponsor_events d JOIN sponsor_events s ON d.address = s.address
              WHERE d.endpoint = 'drip' AND s.endpoint = 'sponsor'
                AND s.ts BETWEEN d.ts + ? AND d.ts + ?`,
        args: [2 * DAY, WEEK],
      }),
      db.execute({ sql: `SELECT tx_kind, COUNT(*) AS n FROM sponsor_events WHERE endpoint = 'sponsor' GROUP BY tx_kind ORDER BY n DESC`, args: [] }),
      db.execute({ sql: `SELECT op, COUNT(*) AS n, ROUND(AVG(latency_ms), 0) AS avg_latency_ms FROM telemetry_events GROUP BY op ORDER BY n DESC`, args: [] }),
      db.execute({ sql: `SELECT COUNT(DISTINCT namespace_hash) AS n FROM telemetry_events WHERE ts > ?`, args: [now - WEEK] }),
      db.execute({ sql: `SELECT ROUND(100.0 * SUM(CASE WHEN result_count > 0 THEN 1 ELSE 0 END) / MAX(COUNT(*), 1), 1) AS rate FROM telemetry_events WHERE op = 'recall'`, args: [] }),
      db.execute({ sql: `SELECT COUNT(*) AS n FROM telemetry_events WHERE op = 'commit'`, args: [] }),
      db.execute({ sql: `SELECT COUNT(*) AS n FROM telemetry_events WHERE op = 'recall'`, args: [] }),
    ]).then(results => results.map(r => r.rows));

  const num = (row: Record<string, unknown> | undefined, col: string) =>
    row ? Number(row[col] ?? 0) : 0;

  const row = (r: typeof totalUsers[0] | undefined) => r as Record<string, unknown> | undefined;

  return {
    onboarding: {
      totalUsers:    num(row(totalUsers[0]),    "n"),
      newUsersWeek:  num(row(newUsersWeek[0]),  "n"),
    },
    activity: {
      dau: num(row(dau[0]), "n"),
      wau: num(row(wau[0]), "n"),
      mau: num(row(mau[0]), "n"),
    },
    retention: {
      d1: num(row(retD1[0]), "n"),
      d7: num(row(retD7[0]), "n"),
    },
    opBreakdown: opBreakdown.map(r => ({ tx_kind: String((r as Record<string, unknown>)["tx_kind"] ?? ""), n: Number((r as Record<string, unknown>)["n"] ?? 0) })),
    telemetry: {
      byOp:               telByOp.map(r => ({ op: String((r as Record<string, unknown>)["op"]), n: Number((r as Record<string, unknown>)["n"] ?? 0), avg_latency_ms: Number((r as Record<string, unknown>)["avg_latency_ms"] ?? 0) })),
      activeNamespacesD7: num(row(activeNs[0]), "n"),
      recallHitRate:      num(row(recallHit[0]), "rate"),
      totalCommits:       num(row(totalCommits[0]), "n"),
      totalRecalls:       num(row(totalRecalls[0]), "n"),
    },
  };
}
