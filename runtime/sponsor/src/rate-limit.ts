/**
 * Rate limiter — two layers:
 *
 *   1. Per-IP:     coarse gate, stops Sybil attacks (fresh addresses from same host).
 *   2. Per-sender: fine-grained per Sui address, stops a single identity from
 *                  hammering the service across multiple IPs.
 *
 * Both use a fixed sliding window. For production, swap the Map for Redis.
 *
 * Memory safety: expired buckets are pruned on every write so the maps never
 * grow unboundedly even under sustained unique-address attacks.
 */

interface Bucket {
  count:     number;
  windowEnd: number;
}

// Per-IP limits — coarser, higher ceiling (covers legitimate proxies/NAT).
const IP_WINDOW_MS   = Number(process.env.RATE_IP_WINDOW_MS   ?? 60_000); // 1 min
const IP_MAX_PER_WIN = Number(process.env.RATE_IP_MAX_PER_WIN ?? 40);     // 40 tx/min per IP

// Per-sender (Sui address) limits.
const ADDR_WINDOW_MS   = Number(process.env.RATE_WINDOW_MS   ?? 60_000); // 1 min
const ADDR_MAX_PER_WIN = Number(process.env.RATE_MAX_PER_WIN ?? 10);     // 10 tx/min per address

// Global daily spend cap — absolute ceiling regardless of address/IP count.
const DAILY_MAX_TX = Number(process.env.RATE_DAILY_MAX_TX ?? 5_000);

const ipBuckets:        Map<string, Bucket> = new Map();
const addrBuckets:      Map<string, Bucket> = new Map();
const strictIpBuckets:  Map<string, Bucket> = new Map(); // for init_tree and other strict fns

let dailyCount   = 0;
let dailyResetAt = Date.now() + 86_400_000; // 24 hours from startup

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
}

function pruneExpired(map: Map<string, Bucket>): void {
  const now = Date.now();
  for (const [key, bucket] of map) {
    if (now > bucket.windowEnd) map.delete(key);
  }
}

function check(
  map: Map<string, Bucket>,
  key: string,
  windowMs: number,
  max: number,
  label: string,
): RateLimitResult {
  pruneExpired(map);
  const now    = Date.now();
  const bucket = map.get(key);

  if (!bucket || now > bucket.windowEnd) {
    map.set(key, { count: 1, windowEnd: now + windowMs });
    return { allowed: true };
  }
  if (bucket.count >= max) {
    return {
      allowed: false,
      reason:  `Rate limit exceeded (${label}): ${max} tx per ${windowMs / 1000}s`,
    };
  }
  bucket.count++;
  return { allowed: true };
}

/**
 * Stricter check for sensitive functions (e.g. init_tree).
 * 1 per IP per day — enough for a real developer, expensive for Sybil attacks.
 */
export function checkStrictRateLimit(
  clientIp: string,
  maxPerDay: number,
): RateLimitResult {
  return check(strictIpBuckets, clientIp, 86_400_000, maxPerDay, "init_tree/IP/day");
}

export function checkRateLimit(senderAddress: string, clientIp: string): RateLimitResult {
  // Reset daily counter if the window has rolled over.
  if (Date.now() > dailyResetAt) {
    dailyCount   = 0;
    dailyResetAt = Date.now() + 86_400_000;
  }

  // 1. Global daily cap — checked first, cheapest gate.
  if (dailyCount >= DAILY_MAX_TX) {
    return { allowed: false, reason: "Daily sponsorship limit reached. Try again tomorrow." };
  }

  // 2. Per-IP gate — stops Sybil attacks from a single host.
  const ipResult = check(ipBuckets, clientIp, IP_WINDOW_MS, IP_MAX_PER_WIN, "IP");
  if (!ipResult.allowed) return ipResult;

  // 3. Per-address gate — per-identity ceiling.
  const addrResult = check(addrBuckets, senderAddress, ADDR_WINDOW_MS, ADDR_MAX_PER_WIN, "address");
  if (!addrResult.allowed) return addrResult;

  // All gates passed — count against the daily budget.
  dailyCount++;
  return { allowed: true };
}
