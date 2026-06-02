/**
 * Demo seed — pre-populates the DAG store with a realistic 6-week history
 * so the visualizer is usable without a live Sui connection.
 *
 * Mirrors the showpiece setup described in DEMO.md:
 *   - ≥ 41 commits, ≥ 8 branches, prior merge commits visible
 *   - AppError commit on feat/auth (authored via Codex, 3 days ago)
 *   - dev/redis-first + dev/bcrypt-first with a Jury(2,3) merge into main
 */

import type { CommitCreatedEvent, BranchCreatedEvent, MergeProposedEvent, AttestationSubmittedEvent, MergeFinalizedEvent } from "../sui/types.js";

const TREE = "0xeb88a31b9ef8c015e0182929c6b499126e176939ccfe5fd419dd8e1b35bea93c";
const PACKAGE = "0xc9f0a4964f810c794479bc5b66347998969d2c59d6797c313b8a96d2bdd6a914";

const ADDR_A = "0x4a2b8e3f1c9d57a08b16ec43f2d90e7c3b854a12";
const ADDR_B = "0x7f1c3a9e5d28b04f62e87a1c3d9b45e7f2c810a3";
const ADDR_JURY_1 = "0x9e4d2c8a1b57f3e06d29c84b7f1e53a2d08c6b95";
const ADDR_JURY_2 = "0x3b16e8f2c94a07d53e1b62f49c8a27b5e31d0e84";
const ADDR_JURY_3 = "0x6c83a4e1b92d75f08e34b17c6a50e2d49b8c3f21";

const RESOLVER = "0xd5a3b7e9c2f10864a83c5d2e7b94f1c63a07e582";

// Base timestamps — spread across ~6 weeks
const NOW = Date.now();
const DAY = 86_400_000;
const W6 = NOW - 42 * DAY;

function ts(daysAgo: number, h = 10, m = 0): number {
  return W6 + (42 - daysAgo) * DAY + (h * 60 + m) * 60_000;
}

function id(hex: string): string { return `0x${hex}`; }
function txd(suffix: string): string { return `${PACKAGE.slice(0, 10)}tx${suffix}`; }
function blob(suffix: string): string { return `${suffix}blob`; }

// ─── Branch events ────────────────────────────────────────────────────────────

export const DEMO_BRANCHES: BranchCreatedEvent[] = [
  { tree_id: TREE, branch: "main",          from_branch: "",     memwal_namespace: `memforks/${TREE}/main`,          tx_digest: txd("b00"), ts_ms: ts(42) },
  { tree_id: TREE, branch: "feat/auth",     from_branch: "main", memwal_namespace: `memforks/${TREE}/feat/auth`,     tx_digest: txd("b01"), ts_ms: ts(38) },
  { tree_id: TREE, branch: "feat/billing",  from_branch: "main", memwal_namespace: `memforks/${TREE}/feat/billing`,  tx_digest: txd("b02"), ts_ms: ts(30) },
  { tree_id: TREE, branch: "feat/payments", from_branch: "main", memwal_namespace: `memforks/${TREE}/feat/payments`, tx_digest: txd("b03"), ts_ms: ts(20) },
  { tree_id: TREE, branch: "hotfix/jwt",    from_branch: "main", memwal_namespace: `memforks/${TREE}/hotfix/jwt`,    tx_digest: txd("b04"), ts_ms: ts(14) },
  { tree_id: TREE, branch: "dev/redis-first",   from_branch: "main", memwal_namespace: `memforks/${TREE}/dev/redis-first`,   tx_digest: txd("b05"), ts_ms: ts(5, 9) },
  { tree_id: TREE, branch: "dev/bcrypt-first",  from_branch: "main", memwal_namespace: `memforks/${TREE}/dev/bcrypt-first`,  tx_digest: txd("b06"), ts_ms: ts(5, 9, 5) },
  { tree_id: TREE, branch: "explore/3ds",   from_branch: "feat/payments", memwal_namespace: `memforks/${TREE}/explore/3ds`,  tx_digest: txd("b07"), ts_ms: ts(10) },
];

// ─── Commit events ────────────────────────────────────────────────────────────

export const DEMO_COMMITS: CommitCreatedEvent[] = [
  // ── main ──────────────────────────────────────────────────────────────────
  { tree_id: TREE, commit_id: id("c001aa"), branch: "main", parents: [],            memwal_namespace: `memforks/${TREE}/main`, memwal_blob_id: blob("c001"), author: ADDR_A, is_merge: false, ts_ms: ts(42),     tx_digest: txd("c001"), seq: "0" },
  { tree_id: TREE, commit_id: id("c002bb"), branch: "main", parents: [id("c001aa")], memwal_namespace: `memforks/${TREE}/main`, memwal_blob_id: blob("c002"), author: ADDR_A, is_merge: false, ts_ms: ts(40),     tx_digest: txd("c002"), seq: "0" },
  { tree_id: TREE, commit_id: id("c003cc"), branch: "main", parents: [id("c002bb")], memwal_namespace: `memforks/${TREE}/main`, memwal_blob_id: blob("c003"), author: ADDR_B, is_merge: false, ts_ms: ts(36),     tx_digest: txd("c003"), seq: "0" },
  { tree_id: TREE, commit_id: id("c010dd"), branch: "main", parents: [id("c003cc")], memwal_namespace: `memforks/${TREE}/main`, memwal_blob_id: blob("c010"), author: ADDR_B, is_merge: false, ts_ms: ts(28),     tx_digest: txd("c010"), seq: "0" },
  { tree_id: TREE, commit_id: id("c020ee"), branch: "main", parents: [id("c010dd")], memwal_namespace: `memforks/${TREE}/main`, memwal_blob_id: blob("c020"), author: ADDR_A, is_merge: false, ts_ms: ts(22),     tx_digest: txd("c020"), seq: "0" },
  // merge of feat/auth → main
  { tree_id: TREE, commit_id: id("c030ff"), branch: "main", parents: [id("c020ee"), id("c015au")], memwal_namespace: `memforks/${TREE}/main`, memwal_blob_id: blob("c030"), author: ADDR_A, is_merge: true,  ts_ms: ts(18),     tx_digest: txd("c030"), seq: "0" },
  // merge of hotfix/jwt → main
  { tree_id: TREE, commit_id: id("c035gg"), branch: "main", parents: [id("c030ff"), id("c012jw")], memwal_namespace: `memforks/${TREE}/main`, memwal_blob_id: blob("c035"), author: ADDR_B, is_merge: true,  ts_ms: ts(12),     tx_digest: txd("c035"), seq: "0" },
  { tree_id: TREE, commit_id: id("c040hh"), branch: "main", parents: [id("c035gg")], memwal_namespace: `memforks/${TREE}/main`, memwal_blob_id: blob("c040"), author: ADDR_A, is_merge: false, ts_ms: ts(6),      tx_digest: txd("c040"), seq: "0" },
  { tree_id: TREE, commit_id: id("c041ii"), branch: "main", parents: [id("c040hh")], memwal_namespace: `memforks/${TREE}/main`, memwal_blob_id: blob("c041"), author: ADDR_B, is_merge: false, ts_ms: ts(5, 8),   tx_digest: txd("c041"), seq: "0" },
  // merge of dev/redis-first → main (the big demo merge)
  { tree_id: TREE, commit_id: id("c045jj"), branch: "main", parents: [id("c041ii"), id("c044rd"), id("c044bc")], memwal_namespace: `memforks/${TREE}/main`, memwal_blob_id: blob("c045"), author: ADDR_A, is_merge: true, ts_ms: ts(5, 14), tx_digest: txd("c045"), seq: "0" },

  // ── feat/auth ─────────────────────────────────────────────────────────────
  { tree_id: TREE, commit_id: id("c005au"), branch: "feat/auth", parents: [id("c002bb")], memwal_namespace: `memforks/${TREE}/feat/auth`, memwal_blob_id: blob("c005"), author: ADDR_A, is_merge: false, ts_ms: ts(38),     tx_digest: txd("c005"), seq: "0" },
  { tree_id: TREE, commit_id: id("c008au"), branch: "feat/auth", parents: [id("c005au")], memwal_namespace: `memforks/${TREE}/feat/auth`, memwal_blob_id: blob("c008"), author: ADDR_A, is_merge: false, ts_ms: ts(35),     tx_digest: txd("c008"), seq: "0" },
  { tree_id: TREE, commit_id: id("c011au"), branch: "feat/auth", parents: [id("c008au")], memwal_namespace: `memforks/${TREE}/feat/auth`, memwal_blob_id: blob("c011"), author: ADDR_A, is_merge: false, ts_ms: ts(32),     tx_digest: txd("c011"), seq: "0" },
  { tree_id: TREE, commit_id: id("c015au"), branch: "feat/auth", parents: [id("c011au")], memwal_namespace: `memforks/${TREE}/feat/auth`, memwal_blob_id: blob("c015"), author: ADDR_A, is_merge: false, ts_ms: ts(19),     tx_digest: txd("c015"), seq: "0" },

  // ── feat/billing ──────────────────────────────────────────────────────────
  { tree_id: TREE, commit_id: id("c007bi"), branch: "feat/billing", parents: [id("c003cc")], memwal_namespace: `memforks/${TREE}/feat/billing`, memwal_blob_id: blob("c007"), author: ADDR_B, is_merge: false, ts_ms: ts(30), tx_digest: txd("c007"), seq: "0" },
  { tree_id: TREE, commit_id: id("c009bi"), branch: "feat/billing", parents: [id("c007bi")], memwal_namespace: `memforks/${TREE}/feat/billing`, memwal_blob_id: blob("c009"), author: ADDR_B, is_merge: false, ts_ms: ts(27), tx_digest: txd("c009"), seq: "0" },
  { tree_id: TREE, commit_id: id("c013bi"), branch: "feat/billing", parents: [id("c009bi")], memwal_namespace: `memforks/${TREE}/feat/billing`, memwal_blob_id: blob("c013"), author: ADDR_B, is_merge: false, ts_ms: ts(24), tx_digest: txd("c013"), seq: "0" },

  // ── feat/payments ─────────────────────────────────────────────────────────
  { tree_id: TREE, commit_id: id("c016pa"), branch: "feat/payments", parents: [id("c010dd")], memwal_namespace: `memforks/${TREE}/feat/payments`, memwal_blob_id: blob("c016"), author: ADDR_B, is_merge: false, ts_ms: ts(20), tx_digest: txd("c016"), seq: "0" },
  { tree_id: TREE, commit_id: id("c018pa"), branch: "feat/payments", parents: [id("c016pa")], memwal_namespace: `memforks/${TREE}/feat/payments`, memwal_blob_id: blob("c018"), author: ADDR_B, is_merge: false, ts_ms: ts(17), tx_digest: txd("c018"), seq: "0" },
  { tree_id: TREE, commit_id: id("c022pa"), branch: "feat/payments", parents: [id("c018pa")], memwal_namespace: `memforks/${TREE}/feat/payments`, memwal_blob_id: blob("c022"), author: ADDR_B, is_merge: false, ts_ms: ts(15), tx_digest: txd("c022"), seq: "0" },

  // ── hotfix/jwt ────────────────────────────────────────────────────────────
  { tree_id: TREE, commit_id: id("c012jw"), branch: "hotfix/jwt", parents: [id("c030ff")], memwal_namespace: `memforks/${TREE}/hotfix/jwt`, memwal_blob_id: blob("c012"), author: ADDR_B, is_merge: false, ts_ms: ts(14), tx_digest: txd("c012"), seq: "0" },

  // ── explore/3ds ───────────────────────────────────────────────────────────
  { tree_id: TREE, commit_id: id("c019ex"), branch: "explore/3ds", parents: [id("c016pa")], memwal_namespace: `memforks/${TREE}/explore/3ds`, memwal_blob_id: blob("c019"), author: ADDR_B, is_merge: false, ts_ms: ts(10), tx_digest: txd("c019"), seq: "0" },
  { tree_id: TREE, commit_id: id("c021ex"), branch: "explore/3ds", parents: [id("c019ex")], memwal_namespace: `memforks/${TREE}/explore/3ds`, memwal_blob_id: blob("c021"), author: ADDR_B, is_merge: false, ts_ms: ts(9),  tx_digest: txd("c021"), seq: "0" },

  // ── dev/redis-first ───────────────────────────────────────────────────────
  { tree_id: TREE, commit_id: id("c042rd"), branch: "dev/redis-first",  parents: [id("c041ii")], memwal_namespace: `memforks/${TREE}/dev/redis-first`,  memwal_blob_id: blob("c042r"), author: ADDR_A, is_merge: false, ts_ms: ts(5, 9, 10), tx_digest: txd("c042r"), seq: "0" },
  { tree_id: TREE, commit_id: id("c043rd"), branch: "dev/redis-first",  parents: [id("c042rd")], memwal_namespace: `memforks/${TREE}/dev/redis-first`,  memwal_blob_id: blob("c043r"), author: ADDR_A, is_merge: false, ts_ms: ts(5, 10),     tx_digest: txd("c043r"), seq: "0" },
  { tree_id: TREE, commit_id: id("c044rd"), branch: "dev/redis-first",  parents: [id("c043rd")], memwal_namespace: `memforks/${TREE}/dev/redis-first`,  memwal_blob_id: blob("c044r"), author: ADDR_A, is_merge: false, ts_ms: ts(5, 11),     tx_digest: txd("c044r"), seq: "0" },

  // ── dev/bcrypt-first ──────────────────────────────────────────────────────
  { tree_id: TREE, commit_id: id("c042bc"), branch: "dev/bcrypt-first", parents: [id("c041ii")], memwal_namespace: `memforks/${TREE}/dev/bcrypt-first`, memwal_blob_id: blob("c042b"), author: ADDR_A, is_merge: false, ts_ms: ts(5, 9, 10), tx_digest: txd("c042b"), seq: "0" },
  { tree_id: TREE, commit_id: id("c043bc"), branch: "dev/bcrypt-first", parents: [id("c042bc")], memwal_namespace: `memforks/${TREE}/dev/bcrypt-first`, memwal_blob_id: blob("c043b"), author: ADDR_A, is_merge: false, ts_ms: ts(5, 10, 20), tx_digest: txd("c043b"), seq: "0" },
  { tree_id: TREE, commit_id: id("c044bc"), branch: "dev/bcrypt-first", parents: [id("c043bc")], memwal_namespace: `memforks/${TREE}/dev/bcrypt-first`, memwal_blob_id: blob("c044b"), author: ADDR_A, is_merge: false, ts_ms: ts(5, 11, 20), tx_digest: txd("c044b"), seq: "0" },
];

// Human-readable messages for display.
export const COMMIT_MESSAGES: Record<string, string> = {
  "c001aa": "init: MemoryTree created · genesis commit",
  "c002bb": "chore: project structure + dependency inventory",
  "c003cc": "feat: baseline API shape agreed",
  "c010dd": "feat: auth service scaffolded",
  "c020ee": "feat: payment module scaffolded",
  "c030ff": "merge feat/auth → main · Jury(2,2) approved",
  "c035gg": "merge hotfix/jwt → main · LWW",
  "c040hh": "chore: dependency updates",
  "c041ii": "feat: bcrypt cost audit started",
  "c045jj": "merge dev/redis-first → main · Jury(2,3) approved · LLM reconciled",
  "c005au": "feat: JWT validation logic",
  "c008au": "feat: refresh token rotation",
  "c011au": "feat: rate limiting on /auth endpoints",
  "c015au": "error handling: always use AppError wrapper, never throw raw",  // ← THE commit
  "c007bi": "feat: invoice generation v1",
  "c009bi": "feat: Stripe webhook handler",
  "c013bi": "fix: idempotency key on charge retry",
  "c016pa": "feat: payment intent creation",
  "c018pa": "feat: 3DS challenge flow stub",
  "c022pa": "fix: currency normalisation",
  "c012jw": "fix: JWT expiry off-by-one on DST boundary",
  "c019ex": "explore: 3DS redirect flow analysis",
  "c021ex": "explore: fingerprint-only fallback risk",
  "c042rd": "init: hypothesis — Redis caching reduces bcrypt pressure",
  "c043rd": "read codebase: bcrypt cost=12, avg auth 340ms, 80% CPU",
  "c044rd": "benchmark sim: Redis hit rate 87% → projected auth 48ms · bench.csv attached",
  "c042bc": "init: hypothesis — bcrypt cost reduction is safer",
  "c043bc": "read codebase: session token TTL 15min, no external dep",
  "c044bc": "analysis: cost=10 drops auth to 190ms, cache invalidation risk: none",
};

// ─── Merge proposal + attestations ───────────────────────────────────────────

export const DEMO_PROPOSAL: MergeProposedEvent = {
  tree_id:     TREE,
  proposal_id: id("prop01"),
  from_branch: "dev/redis-first",
  into_branch: "main",
  resolver_id: RESOLVER,
  ttl_ms:      DAY,
  proposer:    ADDR_A,
  ts_ms:       ts(5, 11, 30),
  tx_digest:   txd("prop01"),
};

export const DEMO_ATTESTATIONS: AttestationSubmittedEvent[] = [
  { tree_id: TREE, proposal_id: id("prop01"), signer: ADDR_JURY_1, kind: 0x01, ts_ms: ts(5, 11, 35), tx_digest: txd("atst01") },
  { tree_id: TREE, proposal_id: id("prop01"), signer: ADDR_JURY_2, kind: 0x01, ts_ms: ts(5, 11, 40), tx_digest: txd("atst02") },
  { tree_id: TREE, proposal_id: id("prop01"), signer: ADDR_JURY_3, kind: 0x04, ts_ms: ts(5, 11, 55), tx_digest: txd("atst03") },
];

export const DEMO_FINALIZED: MergeFinalizedEvent = {
  tree_id:     TREE,
  proposal_id: id("prop01"),
  commit_id:   id("c045jj"),
  verdict:     "APPROVE",
  ts_ms:       ts(5, 12),
  tx_digest:   txd("fin01"),
};

// ─── Demo memory facts ────────────────────────────────────────────────────────

import type { MemoryFact } from "../state/memoryStore.js";

export const DEMO_FACTS: Record<string, MemoryFact[]> = {
  main: [
    { key: "error_handling.pattern",      content: "Always use AppError wrapper. Never throw raw strings or untyped errors in request handlers.", introduced_by: "c015au", introduced_by_id: id("c015au"), branch: "main", ts_ms: ts(19) },
    { key: "error_handling.never_raw",    content: "Raw `throw new Error(...)` is forbidden in handler code. Wrap with AppError({ code, message, cause }).", introduced_by: "c015au", introduced_by_id: id("c015au"), branch: "main", ts_ms: ts(19) },
    { key: "auth.jwt.expiry",             content: "JWT access token TTL is 15 minutes. Refresh token TTL is 7 days. No sliding expiry.", introduced_by: "c008au", introduced_by_id: id("c008au"), branch: "main", ts_ms: ts(35) },
    { key: "auth.jwt.rotation",           content: "Refresh tokens rotate on every use. Old token is invalidated immediately.", introduced_by: "c008au", introduced_by_id: id("c008au"), branch: "main", ts_ms: ts(35) },
    { key: "auth.bcrypt.cost",            content: "bcrypt cost factor is 12. Avg auth latency 340ms at p99 under 10k RPS.", introduced_by: "c043rd", introduced_by_id: id("c043rd"), branch: "main", ts_ms: ts(5, 10) },
    { key: "auth.rate_limit",             content: "Rate limit /auth endpoints at 100 req/min per IP. Return 429 with Retry-After header.", introduced_by: "c011au", introduced_by_id: id("c011au"), branch: "main", ts_ms: ts(32) },
    { key: "caching.decision",            content: "Prefer Redis caching over bcrypt cost reduction. Jury verdict 2/3: dev/redis-first wins. Redis projected 48ms vs 190ms for cost=10.", introduced_by: "c045jj", introduced_by_id: id("c045jj"), branch: "main", ts_ms: ts(5, 14) },
    { key: "caching.redis_hit_rate",      content: "Simulated Redis hit rate: 87%. Projected auth latency: 48ms. See bench.csv attached to c044rd.", introduced_by: "c044rd", introduced_by_id: id("c044rd"), branch: "main", ts_ms: ts(5, 11) },
    { key: "payments.stripe_intent",      content: "Create a PaymentIntent for every charge. Never charge a card directly. Pass idempotency key.", introduced_by: "c016pa", introduced_by_id: id("c016pa"), branch: "main", ts_ms: ts(20) },
    { key: "payments.currency",           content: "Normalise all amounts to ISO 4217 minor units (pence/cents) before passing to Stripe API.", introduced_by: "c022pa", introduced_by_id: id("c022pa"), branch: "main", ts_ms: ts(15) },
    { key: "payments.idempotency",        content: "Use Stripe idempotency key on charge retry. Key = `charge_${userId}_${orderId}_${attemptN}`.", introduced_by: "c013bi", introduced_by_id: id("c013bi"), branch: "main", ts_ms: ts(24) },
    { key: "hotfix.jwt_dst",              content: "JWT expiry has an off-by-one on DST boundary. Fixed in hotfix/jwt: compare epoch seconds not Date objects.", introduced_by: "c012jw", introduced_by_id: id("c012jw"), branch: "main", ts_ms: ts(14) },
  ],
  "feat/auth": [
    { key: "error_handling.pattern",      content: "Always use AppError wrapper. Never throw raw strings or untyped errors in request handlers.", introduced_by: "c015au", introduced_by_id: id("c015au"), branch: "feat/auth", ts_ms: ts(19) },
    { key: "auth.jwt.expiry",             content: "JWT access token TTL is 15 minutes. Refresh token TTL is 7 days.", introduced_by: "c008au", introduced_by_id: id("c008au"), branch: "feat/auth", ts_ms: ts(35) },
    { key: "auth.jwt.rotation",           content: "Refresh tokens rotate on every use.", introduced_by: "c008au", introduced_by_id: id("c008au"), branch: "feat/auth", ts_ms: ts(35) },
    { key: "auth.rate_limit",             content: "Rate limit /auth at 100 req/min per IP with 429 + Retry-After.", introduced_by: "c011au", introduced_by_id: id("c011au"), branch: "feat/auth", ts_ms: ts(32) },
  ],
  "dev/redis-first": [
    { key: "auth.bcrypt.cost",            content: "bcrypt cost=12, avg auth 340ms, 80% CPU under load.", introduced_by: "c043rd", introduced_by_id: id("c043rd"), branch: "dev/redis-first", ts_ms: ts(5, 10) },
    { key: "caching.hypothesis",          content: "Redis caching reduces bcrypt pressure. Cache the session token → skip bcrypt on cache hit.", introduced_by: "c042rd", introduced_by_id: id("c042rd"), branch: "dev/redis-first", ts_ms: ts(5, 9, 10) },
    { key: "caching.redis_hit_rate",      content: "Simulated Redis hit rate 87% → projected auth latency 48ms. bench.csv attached.", introduced_by: "c044rd", introduced_by_id: id("c044rd"), branch: "dev/redis-first", ts_ms: ts(5, 11) },
  ],
  "dev/bcrypt-first": [
    { key: "auth.bcrypt.cost_reduction",  content: "Dropping cost from 12→10 reduces auth to 190ms. No external dependency. Cache invalidation risk: none.", introduced_by: "c044bc", introduced_by_id: id("c044bc"), branch: "dev/bcrypt-first", ts_ms: ts(5, 11, 20) },
    { key: "caching.hypothesis",          content: "bcrypt cost reduction is safer than Redis. No new infrastructure, no cache invalidation risk.", introduced_by: "c042bc", introduced_by_id: id("c042bc"), branch: "dev/bcrypt-first", ts_ms: ts(5, 9, 10) },
    { key: "auth.session_ttl",            content: "Session token TTL is 15min. Low enough that cache invalidation risk is near-zero.", introduced_by: "c043bc", introduced_by_id: id("c043bc"), branch: "dev/bcrypt-first", ts_ms: ts(5, 10, 20) },
  ],
};

// ─── Seed helper ──────────────────────────────────────────────────────────────

import { useDagStore } from "../state/dagStore.js";
import { useMemoryStore } from "../state/memoryStore.js";

export function seedDemoData() {
  const store = useDagStore.getState();
  store.reset();

  // Apply in chronological order.
  const sortedBranches = [...DEMO_BRANCHES].sort((a, b) => a.ts_ms - b.ts_ms);
  const sortedCommits  = [...DEMO_COMMITS].sort((a, b) => a.ts_ms - b.ts_ms);

  for (const b of sortedBranches) store.applyBranch(b);
  for (const c of sortedCommits)  store.applyCommit(c);

  store.applyProposal(DEMO_PROPOSAL);
  for (const a of DEMO_ATTESTATIONS) store.applyAttestation(a);
  store.applyFinalized(DEMO_FINALIZED);

  // Attach human-readable messages after the fact.
  for (const [rawId, msg] of Object.entries(COMMIT_MESSAGES)) {
    const fullId = `0x${rawId}`;
    const commit = useDagStore.getState().commits.get(fullId);
    if (commit) {
      useDagStore.getState().commits.set(fullId, { ...commit, message: msg });
    }
  }
  // Force re-derive orderedCommits after message patching.
  const commits = new Map(useDagStore.getState().commits);
  useDagStore.setState({
    commits,
    orderedCommits: Array.from(commits.values()).sort((a, b) => a.ts_ms - b.ts_ms),
  });

  // Seed memory facts.
  const memStore = useMemoryStore.getState();
  memStore.reset();
  for (const [branch, facts] of Object.entries(DEMO_FACTS)) {
    memStore.setFacts(branch, facts);
  }
}
