/**
 * Demo seed — pre-populates the DAG store with a realistic 6-week history
 * so the visualizer is usable without a live Sui connection.
 *
 * Model A: regular commits are off-chain Walrus blobs (no CommitCreated events).
 * The demo seeds branches and merge anchors. Off-chain commit history is represented
 * by human-readable labels on merge anchors (the resolved blob content).
 *
 * Mirrors the showpiece setup described in DEMO.md:
 *   - 8 branches, 5 merge settlements
 *   - Jury(2,3) merge of dev/redis-first vs dev/bcrypt-first into main
 *   - All branch heads advanced to resolved blob IDs
 */

import type {
  BranchCreatedEvent,
  MergeProposedEvent,
  AttestationSubmittedEvent,
  MergeFinalizedEvent,
} from "../sui/types.js";

const TREE    = "0x099bb03595562bd4fdcb84dc60a330563ee55ca6d7b0808f048e1741795bc5be";
const PACKAGE = "0x080722f5b7025679aa17792a3b07ef9b875b4ad3cee7640ecf9b8b7abd5b5347";

const ADDR_A     = "0x4a2b8e3f1c9d57a08b16ec43f2d90e7c3b854a12";
const ADDR_B     = "0x7f1c3a9e5d28b04f62e87a1c3d9b45e7f2c810a3";
const ADDR_JURY_1 = "0x9e4d2c8a1b57f3e06d29c84b7f1e53a2d08c6b95";
const ADDR_JURY_2 = "0x3b16e8f2c94a07d53e1b62f49c8a27b5e31d0e84";
const ADDR_JURY_3 = "0x6c83a4e1b92d75f08e34b17c6a50e2d49b8c3f21";

const RESOLVER = "0xd5a3b7e9c2f10864a83c5d2e7b94f1c63a07e582";

// Base timestamps — spread across ~6 weeks
const NOW = Date.now();
const DAY = 86_400_000;
const W6  = NOW - 42 * DAY;

function ts(daysAgo: number, h = 10, m = 0): number {
  return W6 + (42 - daysAgo) * DAY + (h * 60 + m) * 60_000;
}

function id(hex: string): string { return `0x${hex}`; }
function txd(suffix: string): string { return `${PACKAGE.slice(0, 10)}tx${suffix}`; }
// Fake Walrus blob IDs (SHA-256-sized hex stubs for demo)
function blob(suffix: string): string {
  return `${suffix.padEnd(56, "0")}blob`;
}

// ─── Branch events ────────────────────────────────────────────────────────────

export const DEMO_BRANCHES: BranchCreatedEvent[] = [
  { tree_id: TREE, branch: "main",              from_branch: "",              memwal_namespace: `memforks/${TREE}/main`,              tx_digest: txd("b00"), ts_ms: ts(42) },
  { tree_id: TREE, branch: "feat/auth",         from_branch: "main",          memwal_namespace: `memforks/${TREE}/feat/auth`,         tx_digest: txd("b01"), ts_ms: ts(38) },
  { tree_id: TREE, branch: "feat/billing",      from_branch: "main",          memwal_namespace: `memforks/${TREE}/feat/billing`,      tx_digest: txd("b02"), ts_ms: ts(30) },
  { tree_id: TREE, branch: "feat/payments",     from_branch: "main",          memwal_namespace: `memforks/${TREE}/feat/payments`,     tx_digest: txd("b03"), ts_ms: ts(20) },
  { tree_id: TREE, branch: "hotfix/jwt",        from_branch: "main",          memwal_namespace: `memforks/${TREE}/hotfix/jwt`,        tx_digest: txd("b04"), ts_ms: ts(14) },
  { tree_id: TREE, branch: "dev/redis-first",   from_branch: "main",          memwal_namespace: `memforks/${TREE}/dev/redis-first`,   tx_digest: txd("b05"), ts_ms: ts(5, 9) },
  { tree_id: TREE, branch: "dev/bcrypt-first",  from_branch: "main",          memwal_namespace: `memforks/${TREE}/dev/bcrypt-first`,  tx_digest: txd("b06"), ts_ms: ts(5, 9, 5) },
  { tree_id: TREE, branch: "explore/3ds",       from_branch: "feat/payments", memwal_namespace: `memforks/${TREE}/explore/3ds`,       tx_digest: txd("b07"), ts_ms: ts(10) },
];

// ─── Merge proposals, attestations, and finalizations ────────────────────────

// Merge 1: feat/auth → main (LWW)
export const DEMO_PROPOSAL_AUTH: MergeProposedEvent = {
  tree_id: TREE, proposal_id: id("prop01"),
  from_branch: "feat/auth", into_branch: "main",
  from_head_blob_id: blob("auth-tip"),
  into_head_blob_id: blob("main-before-auth"),
  resolver_id: RESOLVER,
  expires_at_ms: ts(18) + DAY,
  ts_ms: ts(18, 9), tx_digest: txd("prop01"),
};
export const DEMO_FINALIZED_AUTH: MergeFinalizedEvent = {
  tree_id: TREE, proposal_id: id("prop01"),
  merge_commit_id: id("anc001auth"),
  resolved_blob_id: blob("main-after-auth"),
  ts_ms: ts(18, 10), tx_digest: txd("fin01"),
};

// Merge 2: hotfix/jwt → main (LWW)
export const DEMO_PROPOSAL_JWT: MergeProposedEvent = {
  tree_id: TREE, proposal_id: id("prop02"),
  from_branch: "hotfix/jwt", into_branch: "main",
  from_head_blob_id: blob("jwt-tip"),
  into_head_blob_id: blob("main-after-auth"),
  resolver_id: RESOLVER,
  expires_at_ms: ts(12) + DAY,
  ts_ms: ts(12, 9), tx_digest: txd("prop02"),
};
export const DEMO_FINALIZED_JWT: MergeFinalizedEvent = {
  tree_id: TREE, proposal_id: id("prop02"),
  merge_commit_id: id("anc002jwt"),
  resolved_blob_id: blob("main-after-jwt"),
  ts_ms: ts(12, 10), tx_digest: txd("fin02"),
};

// Merge 3: Jury(2,3) — dev/redis-first wins over dev/bcrypt-first
export const DEMO_PROPOSAL_JURY: MergeProposedEvent = {
  tree_id: TREE, proposal_id: id("prop03"),
  from_branch: "dev/redis-first", into_branch: "main",
  from_head_blob_id: blob("redis-tip"),
  into_head_blob_id: blob("main-after-jwt"),
  resolver_id: RESOLVER,
  expires_at_ms: ts(5, 11) + DAY,
  ts_ms: ts(5, 11, 30), tx_digest: txd("prop03"),
};
export const DEMO_ATTESTATIONS: AttestationSubmittedEvent[] = [
  { tree_id: TREE, proposal_id: id("prop03"), signer: ADDR_JURY_1, kind: 0x01, ts_ms: ts(5, 11, 35), tx_digest: txd("atst01") },
  { tree_id: TREE, proposal_id: id("prop03"), signer: ADDR_JURY_2, kind: 0x01, ts_ms: ts(5, 11, 40), tx_digest: txd("atst02") },
  { tree_id: TREE, proposal_id: id("prop03"), signer: ADDR_JURY_3, kind: 0x04, ts_ms: ts(5, 11, 55), tx_digest: txd("atst03") },
];
export const DEMO_FINALIZED_JURY: MergeFinalizedEvent = {
  tree_id: TREE, proposal_id: id("prop03"),
  merge_commit_id: id("anc003jury"),
  resolved_blob_id: blob("main-after-redis"),
  ts_ms: ts(5, 14), tx_digest: txd("fin03"),
};

// ─── Human-readable anchor labels (attached after seeding) ───────────────────

export const ANCHOR_LABELS: Record<string, string> = {
  "0xanc001auth": "merge feat/auth → main · LWW approved",
  "0xanc002jwt":  "merge hotfix/jwt → main · LWW · fix DST off-by-one",
  "0xanc003jury": "merge dev/redis-first → main · Jury(2,3) approved · LLM reconciled",
};

// ─── Demo memory facts ────────────────────────────────────────────────────────

import type { MemoryFact } from "../state/memoryStore.js";

export const DEMO_FACTS: Record<string, MemoryFact[]> = {
  main: [
    { key: "error_handling.pattern",   content: "Always use AppError wrapper. Never throw raw strings or untyped errors in request handlers.", introduced_by: blob("auth-tip").slice(0, 7), introduced_by_id: blob("auth-tip"), branch: "main", ts_ms: ts(19) },
    { key: "auth.jwt.expiry",          content: "JWT access token TTL is 15 minutes. Refresh token TTL is 7 days. No sliding expiry.", introduced_by: blob("auth-tip").slice(0, 7), introduced_by_id: blob("auth-tip"), branch: "main", ts_ms: ts(35) },
    { key: "auth.jwt.rotation",        content: "Refresh tokens rotate on every use. Old token is invalidated immediately.", introduced_by: blob("auth-tip").slice(0, 7), introduced_by_id: blob("auth-tip"), branch: "main", ts_ms: ts(35) },
    { key: "auth.bcrypt.cost",         content: "bcrypt cost factor is 12. Avg auth latency 340ms at p99 under 10k RPS.", introduced_by: blob("redis-tip").slice(0, 7), introduced_by_id: blob("redis-tip"), branch: "main", ts_ms: ts(5, 10) },
    { key: "auth.rate_limit",          content: "Rate limit /auth endpoints at 100 req/min per IP. Return 429 with Retry-After header.", introduced_by: blob("auth-tip").slice(0, 7), introduced_by_id: blob("auth-tip"), branch: "main", ts_ms: ts(32) },
    { key: "caching.decision",         content: "Prefer Redis caching over bcrypt cost reduction. Jury verdict 2/3: dev/redis-first wins. Redis projected 48ms vs 190ms for cost=10.", introduced_by: blob("main-after-redis").slice(0, 7), introduced_by_id: blob("main-after-redis"), branch: "main", ts_ms: ts(5, 14) },
    { key: "payments.stripe_intent",   content: "Create a PaymentIntent for every charge. Never charge a card directly. Pass idempotency key.", introduced_by: blob("main-before-auth").slice(0, 7), introduced_by_id: blob("main-before-auth"), branch: "main", ts_ms: ts(20) },
    { key: "hotfix.jwt_dst",           content: "JWT expiry has an off-by-one on DST boundary. Fixed in hotfix/jwt: compare epoch seconds not Date objects.", introduced_by: blob("jwt-tip").slice(0, 7), introduced_by_id: blob("jwt-tip"), branch: "main", ts_ms: ts(14) },
  ],
  "feat/auth": [
    { key: "error_handling.pattern",  content: "Always use AppError wrapper.", introduced_by: blob("auth-tip").slice(0, 7), introduced_by_id: blob("auth-tip"), branch: "feat/auth", ts_ms: ts(19) },
    { key: "auth.jwt.expiry",         content: "JWT access token TTL is 15 minutes.", introduced_by: blob("auth-tip").slice(0, 7), introduced_by_id: blob("auth-tip"), branch: "feat/auth", ts_ms: ts(35) },
  ],
  "dev/redis-first": [
    { key: "caching.hypothesis",      content: "Redis caching reduces bcrypt pressure. Cache the session token → skip bcrypt on cache hit.", introduced_by: blob("redis-tip").slice(0, 7), introduced_by_id: blob("redis-tip"), branch: "dev/redis-first", ts_ms: ts(5, 9, 10) },
    { key: "caching.redis_hit_rate",  content: "Simulated Redis hit rate 87% → projected auth latency 48ms.", introduced_by: blob("redis-tip").slice(0, 7), introduced_by_id: blob("redis-tip"), branch: "dev/redis-first", ts_ms: ts(5, 11) },
  ],
  "dev/bcrypt-first": [
    { key: "caching.hypothesis",      content: "bcrypt cost reduction is safer than Redis. No new infrastructure, no cache invalidation risk.", introduced_by: blob("bcrypt-tip").slice(0, 7), introduced_by_id: blob("bcrypt-tip"), branch: "dev/bcrypt-first", ts_ms: ts(5, 9, 10) },
  ],
};

// ─── Seed helper ──────────────────────────────────────────────────────────────

import { useDagStore } from "../state/dagStore.js";
import { useMemoryStore } from "../state/memoryStore.js";

export function seedDemoData() {
  const store = useDagStore.getState();
  store.reset();

  // Apply branches in chronological order.
  [...DEMO_BRANCHES].sort((a, b) => a.ts_ms - b.ts_ms).forEach(b => store.applyBranch(b));

  // Apply merge ceremonies in order.
  store.applyProposal(DEMO_PROPOSAL_AUTH);
  store.applyFinalized(DEMO_FINALIZED_AUTH);

  store.applyProposal(DEMO_PROPOSAL_JWT);
  store.applyFinalized(DEMO_FINALIZED_JWT);

  store.applyProposal(DEMO_PROPOSAL_JURY);
  for (const a of DEMO_ATTESTATIONS) store.applyAttestation(a);
  store.applyFinalized(DEMO_FINALIZED_JURY);

  // Seed memory facts.
  const memStore = useMemoryStore.getState();
  memStore.reset();
  for (const [branch, facts] of Object.entries(DEMO_FACTS)) {
    memStore.setFacts(branch, facts);
  }
}
