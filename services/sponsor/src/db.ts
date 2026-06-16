/**
 * SQLite persistence for the sponsor service.
 *
 * Two tables:
 *   sponsor_events  — every /drip and /sponsor call (address, op, ip_hash, ts).
 *                     Makes METRICS.md Tier 2 real: DAU/MAU, retention, op breakdown.
 *   telemetry_events — SDK-emitted commit/recall/branch/merge counts from @memfork/core.
 *                     Makes metrics real: active depth, recall hit rate.
 *
 * All synchronous (better-sqlite3). DB path defaults to ./sponsor.db beside cwd,
 * override with SPONSOR_DB_PATH.
 *
 * IP addresses are one-way hashed (SHA-256, 16-char hex prefix) before storage.
 * No query text, no fact content, no raw namespace names are ever stored here.
 */

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { join }       from "node:path";

const DB_PATH = process.env["SPONSOR_DB_PATH"] ?? join(process.cwd(), "sponsor.db");

const db = new Database(DB_PATH);

// WAL mode: readers don't block writers; safe for the occasional /metrics read.
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// ─── Migrations ───────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS sponsor_events (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    endpoint  TEXT    NOT NULL,   -- 'drip' | 'sponsor'
    address   TEXT    NOT NULL,   -- Sui address (0x...)
    tx_kind   TEXT,               -- 'onboard' | 'branch' | 'merge_propose' | etc.
    ip_hash   TEXT    NOT NULL    -- sha256(ip)[0:16] — anonymised
  );
  CREATE INDEX IF NOT EXISTS idx_se_ts       ON sponsor_events(ts);
  CREATE INDEX IF NOT EXISTS idx_se_address  ON sponsor_events(address);
  CREATE INDEX IF NOT EXISTS idx_se_endpoint ON sponsor_events(endpoint);

  CREATE TABLE IF NOT EXISTS telemetry_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL,
    op             TEXT    NOT NULL,   -- 'commit' | 'recall' | 'branch' | 'merge'
    namespace_hash TEXT    NOT NULL,   -- sha256(namespace)[0:16]
    bytes          INTEGER,            -- payload bytes for commit
    result_count   INTEGER,            -- results returned for recall
    latency_ms     INTEGER             -- wall-clock duration
  );
  CREATE INDEX IF NOT EXISTS idx_te_ts  ON telemetry_events(ts);
  CREATE INDEX IF NOT EXISTS idx_te_op  ON telemetry_events(op);
  CREATE INDEX IF NOT EXISTS idx_te_ns  ON telemetry_events(namespace_hash);
`);

console.log(`[db] sqlite open: ${DB_PATH}`);

// ─── Prepared statements ──────────────────────────────────────────────────────

const stmtInsertSponsor = db.prepare(`
  INSERT INTO sponsor_events (ts, endpoint, address, tx_kind, ip_hash)
  VALUES (@ts, @endpoint, @address, @tx_kind, @ip_hash)
`);

const stmtInsertTelemetry = db.prepare(`
  INSERT INTO telemetry_events (ts, op, namespace_hash, bytes, result_count, latency_ms)
  VALUES (@ts, @op, @namespace_hash, @bytes, @result_count, @latency_ms)
`);

// ─── Write helpers ─────────────────────────────────────────────────────────────

export function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

export function recordSponsor(opts: {
  endpoint: "drip" | "sponsor";
  address:  string;
  txKind?:  string;
  ip:       string;
}): void {
  try {
    stmtInsertSponsor.run({
      ts:       Date.now(),
      endpoint: opts.endpoint,
      address:  opts.address,
      tx_kind:  opts.txKind ?? null,
      ip_hash:  hashIp(opts.ip),
    });
  } catch (err) {
    console.warn("[db] recordSponsor failed (non-fatal):", err);
  }
}

export function recordTelemetry(opts: {
  op:            string;
  namespaceHash: string;
  bytes?:        number;
  resultCount?:  number;
  latencyMs?:    number;
}): void {
  try {
    stmtInsertTelemetry.run({
      ts:             Date.now(),
      op:             opts.op,
      namespace_hash: opts.namespaceHash,
      bytes:          opts.bytes        ?? null,
      result_count:   opts.resultCount  ?? null,
      latency_ms:     opts.latencyMs    ?? null,
    });
  } catch (err) {
    console.warn("[db] recordTelemetry failed (non-fatal):", err);
  }
}

// ─── Metrics queries ──────────────────────────────────────────────────────────

const DAY  = 86_400_000;
const WEEK = 7 * DAY;
const MON  = 30 * DAY;

export function getMetrics() {
  const now = Date.now();

  // ── Onboarding ──
  const totalUsers = (db.prepare(
    `SELECT COUNT(DISTINCT address) AS n FROM sponsor_events WHERE endpoint = 'drip'`,
  ).get() as { n: number }).n;

  const newUsersWeek = (db.prepare(
    `SELECT COUNT(DISTINCT address) AS n FROM sponsor_events WHERE endpoint = 'drip' AND ts > ?`,
  ).get(now - WEEK) as { n: number }).n;

  // ── Activity ──
  const dau = (db.prepare(
    `SELECT COUNT(DISTINCT address) AS n FROM sponsor_events WHERE endpoint = 'sponsor' AND ts > ?`,
  ).get(now - DAY) as { n: number }).n;

  const wau = (db.prepare(
    `SELECT COUNT(DISTINCT address) AS n FROM sponsor_events WHERE endpoint = 'sponsor' AND ts > ?`,
  ).get(now - WEEK) as { n: number }).n;

  const mau = (db.prepare(
    `SELECT COUNT(DISTINCT address) AS n FROM sponsor_events WHERE endpoint = 'sponsor' AND ts > ?`,
  ).get(now - MON) as { n: number }).n;

  // ── Retention ──
  // D1: any /sponsor call within 24 h of /drip.
  const retentionD1 = (db.prepare(`
    SELECT COUNT(DISTINCT d.address) AS n
    FROM   sponsor_events d
    JOIN   sponsor_events s ON d.address = s.address
    WHERE  d.endpoint = 'drip'
      AND  s.endpoint = 'sponsor'
      AND  s.ts BETWEEN d.ts AND d.ts + ?
  `).get(DAY) as { n: number }).n;

  // D7: any /sponsor call 2–7 days after /drip.
  const retentionD7 = (db.prepare(`
    SELECT COUNT(DISTINCT d.address) AS n
    FROM   sponsor_events d
    JOIN   sponsor_events s ON d.address = s.address
    WHERE  d.endpoint = 'drip'
      AND  s.endpoint = 'sponsor'
      AND  s.ts BETWEEN d.ts + ? AND d.ts + ?
  `).get(2 * DAY, WEEK) as { n: number }).n;

  // ── Op breakdown ──
  const opBreakdown = db.prepare(`
    SELECT tx_kind, COUNT(*) AS n
    FROM   sponsor_events
    WHERE  endpoint = 'sponsor'
    GROUP  BY tx_kind
    ORDER  BY n DESC
  `).all() as { tx_kind: string; n: number }[];

  // ── SDK telemetry ──
  const telemetryByOp = db.prepare(`
    SELECT op, COUNT(*) AS n, ROUND(AVG(latency_ms), 0) AS avg_latency_ms
    FROM   telemetry_events
    GROUP  BY op
    ORDER  BY n DESC
  `).all() as { op: string; n: number; avg_latency_ms: number }[];

  const activeNamespacesD7 = (db.prepare(`
    SELECT COUNT(DISTINCT namespace_hash) AS n
    FROM   telemetry_events
    WHERE  ts > ?
  `).get(now - WEEK) as { n: number }).n;

  const recallHitRate = (db.prepare(`
    SELECT ROUND(100.0 * SUM(CASE WHEN result_count > 0 THEN 1 ELSE 0 END) / COUNT(*), 1) AS rate
    FROM   telemetry_events
    WHERE  op = 'recall'
  `).get() as { rate: number | null }).rate ?? 0;

  const totalCommits = (db.prepare(
    `SELECT COUNT(*) AS n FROM telemetry_events WHERE op = 'commit'`,
  ).get() as { n: number }).n;

  const totalRecalls = (db.prepare(
    `SELECT COUNT(*) AS n FROM telemetry_events WHERE op = 'recall'`,
  ).get() as { n: number }).n;

  return {
    onboarding: { totalUsers, newUsersWeek },
    activity:   { dau, wau, mau },
    retention:  { d1: retentionD1, d7: retentionD7 },
    opBreakdown,
    telemetry: {
      byOp:               telemetryByOp,
      activeNamespacesD7,
      recallHitRate,
      totalCommits,
      totalRecalls,
    },
  };
}
