/**
 * Resolver config builders and BCS codec.
 *
 * `ResolverRef.config` is BCS-encoded (SPEC §4.6, §B.1).
 * These helpers produce the exact byte layout Move expects and decode
 * what `suiClient.getObject` returns for on-chain `ResolverRef` objects.
 *
 * Usage:
 *   const def = resolvers.sequence([
 *     resolvers.jury(judgeAddrs, 2, 3),
 *     resolvers.llmReconcile(runnerAddr),
 *   ]);
 *   const { resolverId } = await mem.createResolver(def);
 */

import { RESOLVER_KIND } from "./types.js";

// ─── Public types ─────────────────────────────────────────────────────────────

/** A resolver kind + its BCS-encoded config, ready for createResolver(). */
export interface ResolverDef {
  kind: number;
  config: Uint8Array;
}

export interface DecodedJuryConfig {
  judges: string[];
  k: number;
  n: number;
}

export interface DecodedLlmConfig {
  runner?: string;
}

export interface DecodedChildConfig {
  kind: number;
  config: Uint8Array;
}

// ─── BCS encoding primitives ─────────────────────────────────────────────────

function uleb128(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f; n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

function concat(...parts: (number[] | Uint8Array)[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p instanceof Uint8Array ? p : new Uint8Array(p), off); off += p.length; }
  return out;
}

/** 0x-prefixed or raw hex string → 32-byte address Uint8Array */
export function addrToBytes(addr: string): Uint8Array {
  const h = addr.startsWith("0x") ? addr.slice(2) : addr;
  return Uint8Array.from(Buffer.from(h.padStart(64, "0"), "hex"));
}

/** 32-byte Uint8Array → 0x-prefixed hex address string */
export function bytesToAddr(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

/** BCS: vector<u8> — ULEB128(len) + bytes */
function encVecU8(data: Uint8Array): Uint8Array {
  return concat(uleb128(data.length), data);
}

/** BCS: vector<address> — ULEB128(n) + n×32 bytes */
function encVecAddr(addrs: string[]): Uint8Array {
  return concat(uleb128(addrs.length), ...addrs.map(addrToBytes));
}

/** BCS: Option<address> — 0x00 | 0x01 + 32 bytes */
function encOptAddr(addr?: string): Uint8Array {
  return addr ? concat([0x01], addrToBytes(addr)) : new Uint8Array([0x00]);
}

/** BCS: vector<{kind:u8, config:vec<u8>}> (used by SEQUENCE / AND) */
function encodeChildren(children: ResolverDef[]): Uint8Array {
  return concat(
    uleb128(children.length),
    ...children.map(c => concat([c.kind], encVecU8(c.config))),
  );
}

// ─── Resolver builders ────────────────────────────────────────────────────────

/**
 * Builder functions for each resolver kind.
 * Returns { kind, config } — pass directly to `mem.createResolver(def)`.
 */
export const resolvers = {
  /** Always APPROVE, no attestations needed.  Good default for simple pipelines. */
  lastWriteWins(): ResolverDef {
    return { kind: RESOLVER_KIND.LAST_WRITE_WINS, config: new Uint8Array(0) };
  },

  /** Always APPROVE; resolved payload = union of both heads. */
  union(): ResolverDef {
    return { kind: RESOLVER_KIND.UNION, config: new Uint8Array(0) };
  },

  /**
   * Requires one LLM_RESOLVE attestation from `runner`.
   * If `runner` is omitted, any address may submit.
   */
  llmReconcile(runner?: string): ResolverDef {
    return { kind: RESOLVER_KIND.LLM_RECONCILE, config: encOptAddr(runner) };
  },

  /**
   * k-of-n jury vote.  All addresses in `judges` are eligible voters.
   * `n` defaults to `judges.length`.
   *
   * @example resolvers.jury(["0xabc…", "0xdef…", "0x123…"], 2, 3)
   */
  jury(judges: string[], k: number, n?: number): ResolverDef {
    const actualN = n ?? judges.length;
    return {
      kind: RESOLVER_KIND.JURY_RECONCILE,
      config: concat(encVecAddr(judges), [k, actualN]),
    };
  },

  /**
   * ALL children must approve (parallel evaluation).
   * Children are embedded by value — no separate on-chain objects needed.
   */
  and(children: ResolverDef[]): ResolverDef {
    return { kind: RESOLVER_KIND.AND, config: encodeChildren(children) };
  },

  /**
   * Children evaluated in order — child i+1 starts only after child i approves.
   * Classic pattern: `sequence([jury(judges, 2, 3), llmReconcile(runner)])`
   */
  sequence(children: ResolverDef[]): ResolverDef {
    return { kind: RESOLVER_KIND.SEQUENCE, config: encodeChildren(children) };
  },
} as const;

// ─── BCS decoding (for the off-chain runtime) ─────────────────────────────────

class BcsReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  u8(): number {
    return this.buf[this.pos++];
  }

  uleb128(): number {
    let result = 0, shift = 0, byte: number;
    do {
      byte = this.buf[this.pos++];
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }

  bytes(n: number): Uint8Array {
    const slice = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Uint8Array.from(slice);
  }

  address(): string { return bytesToAddr(this.bytes(32)); }

  vecAddr(): string[] {
    const n = this.uleb128();
    return Array.from({ length: n }, () => this.address());
  }

  vecU8(): Uint8Array {
    const n = this.uleb128();
    return this.bytes(n);
  }

  optionAddr(): string | undefined {
    return this.u8() ? this.address() : undefined;
  }
}

/** Decode a JURY_RECONCILE config from raw BCS bytes. */
export function decodeJuryConfig(config: Uint8Array): DecodedJuryConfig {
  const r = new BcsReader(config);
  const judges = r.vecAddr();
  const k = r.u8();
  const n = r.u8();
  return { judges, k, n };
}

/** Decode an LLM_RECONCILE config from raw BCS bytes. */
export function decodeLlmConfig(config: Uint8Array): DecodedLlmConfig {
  const r = new BcsReader(config);
  return { runner: r.optionAddr() };
}

/** Decode a SEQUENCE or AND config — returns the list of embedded children. */
export function decodeChildren(config: Uint8Array): DecodedChildConfig[] {
  const r = new BcsReader(config);
  const n = r.uleb128();
  const children: DecodedChildConfig[] = [];
  for (let i = 0; i < n; i++) {
    const kind = r.u8();
    const cfg  = r.vecU8();
    children.push({ kind, config: cfg });
  }
  return children;
}

/**
 * Convert hex or base64 bytes returned by Sui RPC into a Uint8Array.
 * Sui returns vector<u8> fields as arrays-of-numbers in JSON.
 */
export function onChainBytesToUint8Array(
  raw: string | number[] | Uint8Array,
): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return new Uint8Array(raw);
  // hex string
  const h = (raw as string).startsWith("0x") ? (raw as string).slice(2) : raw as string;
  return Uint8Array.from(Buffer.from(h, "hex"));
}
