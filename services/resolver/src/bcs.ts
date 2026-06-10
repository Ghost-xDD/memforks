/**
 * Minimal BCS decoder for resolver configs.
 * Mirrors packages/core/src/resolvers.ts — kept in sync manually.
 */

export const RESOLVER_KIND = {
  LAST_WRITE_WINS: 0x00,
  UNION:           0x01,
  LLM_RECONCILE:  0x02,
  JURY_RECONCILE: 0x03,
  EVALUATOR_PICK: 0x04,
  AND:            0x05,
  SEQUENCE:       0x06,
} as const;

export const PROPOSAL_STATUS = {
  PENDING:   0,
  FINALIZED: 1,
  ABORTED:   2,
  EXPIRED:   3,
} as const;

export function branchNamespace(treeId: string, branch: string): string {
  const hex = treeId.startsWith("0x") ? treeId.slice(2) : treeId;
  return `memforks/${hex}/${branch}`;
}

function bytesToAddr(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

class BcsReader {
  private pos = 0;
  constructor(private readonly buf: Uint8Array) {}

  u8(): number {
    const b = this.buf[this.pos++];
    if (b === undefined) throw new Error("BcsReader: unexpected end");
    return b;
  }

  uleb128(): number {
    let result = 0, shift = 0;
    let byte: number;
    do {
      byte = this.u8();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }

  bytes(n: number): Uint8Array {
    const s = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Uint8Array.from(s);
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

export interface DecodedJuryConfig  { judges: string[]; k: number; n: number; }
export interface DecodedLlmConfig   { runner?: string; }
export interface DecodedChildConfig { kind: number; config: Uint8Array; }

export function decodeJuryConfig(config: Uint8Array): DecodedJuryConfig {
  const r = new BcsReader(config);
  const judges = r.vecAddr();
  const k = r.u8();
  const n = r.u8();
  return { judges, k, n };
}

export function decodeLlmConfig(config: Uint8Array): DecodedLlmConfig {
  const r = new BcsReader(config);
  const runner = r.optionAddr();
  return runner !== undefined ? { runner } : {};
}

export function decodeChildren(config: Uint8Array): DecodedChildConfig[] {
  const r = new BcsReader(config);
  const n = r.uleb128();
  const out: DecodedChildConfig[] = [];
  for (let i = 0; i < n; i++) {
    const kind = r.u8();
    const cfg  = r.vecU8();
    out.push({ kind, config: cfg });
  }
  return out;
}

export function onChainBytesToUint8Array(raw: string | number[] | Uint8Array): Uint8Array {
  if (raw instanceof Uint8Array) return raw;
  if (Array.isArray(raw)) return new Uint8Array(raw);
  const h = (raw as string).startsWith("0x") ? (raw as string).slice(2) : (raw as string);
  return Uint8Array.from(Buffer.from(h, "hex"));
}
