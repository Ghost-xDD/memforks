/**
 * Unit tests for @memfork/core resolver BCS encoding and decoding.
 *
 * These tests exercise the full encode → decode roundtrip for every resolver
 * kind, verify byte-level correctness against hand-computed expected values,
 * and cover the address codec helpers and onChainBytesToUint8Array.
 *
 * No network, no MemWal, no Sui — purely synchronous logic.
 *
 * Run: node --test test-resolvers.mjs
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  resolvers,
  decodeJuryConfig,
  decodeLlmConfig,
  decodeChildren,
  onChainBytesToUint8Array,
  addrToBytes,
  bytesToAddr,
  RESOLVER_KIND,
} from "@memfork/core";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ADDR_A = "0x" + "aa".repeat(32);  // 32 bytes of 0xaa
const ADDR_B = "0x" + "bb".repeat(32);  // 32 bytes of 0xbb
const ADDR_C = "0x" + "cc".repeat(32);  // 32 bytes of 0xcc

// ─── Address codec ────────────────────────────────────────────────────────────

describe("addrToBytes", () => {
  test("0x-prefixed 64-char hex decodes to 32 bytes", () => {
    const bytes = addrToBytes(ADDR_A);
    assert.equal(bytes.length, 32);
    assert.ok(bytes.every((b) => b === 0xaa));
  });

  test("raw 64-char hex (no 0x prefix) decodes to 32 bytes", () => {
    const bytes = addrToBytes("aa".repeat(32));
    assert.equal(bytes.length, 32);
    assert.ok(bytes.every((b) => b === 0xaa));
  });

  test("short hex is left-padded with zero bytes", () => {
    const bytes = addrToBytes("0x1");
    assert.equal(bytes.length, 32);
    // First 31 bytes are 0x00, last byte is 0x01
    assert.ok(bytes.slice(0, 31).every((b) => b === 0x00));
    assert.equal(bytes[31], 0x01);
  });

  test("all-zero address produces 32 zero bytes", () => {
    const bytes = addrToBytes("0x" + "0".repeat(64));
    assert.equal(bytes.length, 32);
    assert.ok(bytes.every((b) => b === 0x00));
  });
});

describe("bytesToAddr", () => {
  test("32 bytes of 0xaa → ADDR_A", () => {
    const bytes = new Uint8Array(32).fill(0xaa);
    assert.equal(bytesToAddr(bytes), ADDR_A);
  });

  test("bytesToAddr(addrToBytes(addr)) roundtrips", () => {
    for (const addr of [ADDR_A, ADDR_B, ADDR_C]) {
      assert.equal(bytesToAddr(addrToBytes(addr)), addr);
    }
  });
});

// ─── onChainBytesToUint8Array ─────────────────────────────────────────────────

describe("onChainBytesToUint8Array", () => {
  test("passes through a Uint8Array unchanged", () => {
    const input = new Uint8Array([1, 2, 3]);
    const result = onChainBytesToUint8Array(input);
    assert.deepEqual(result, input);
    assert.ok(result === input, "should be the same reference");
  });

  test("converts a number array to Uint8Array", () => {
    const result = onChainBytesToUint8Array([0xde, 0xad, 0xbe, 0xef]);
    assert.ok(result instanceof Uint8Array);
    assert.deepEqual(result, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test("converts a raw hex string (no 0x) to Uint8Array", () => {
    const result = onChainBytesToUint8Array("deadbeef");
    assert.deepEqual(result, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test("converts a 0x-prefixed hex string to Uint8Array", () => {
    const result = onChainBytesToUint8Array("0xdeadbeef");
    assert.deepEqual(result, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  });

  test("empty hex string produces empty Uint8Array", () => {
    assert.deepEqual(onChainBytesToUint8Array(""), new Uint8Array(0));
    assert.deepEqual(onChainBytesToUint8Array([]), new Uint8Array(0));
  });
});

// ─── resolvers.lastWriteWins ──────────────────────────────────────────────────

describe("resolvers.lastWriteWins", () => {
  test("produces correct kind", () => {
    const def = resolvers.lastWriteWins();
    assert.equal(def.kind, RESOLVER_KIND.LAST_WRITE_WINS);
    assert.equal(def.kind, 0x00);
  });

  test("config is empty", () => {
    const { config } = resolvers.lastWriteWins();
    assert.equal(config.length, 0);
  });
});

// ─── resolvers.union ─────────────────────────────────────────────────────────

describe("resolvers.union", () => {
  test("produces correct kind", () => {
    const def = resolvers.union();
    assert.equal(def.kind, RESOLVER_KIND.UNION);
    assert.equal(def.kind, 0x01);
  });

  test("config is empty", () => {
    const { config } = resolvers.union();
    assert.equal(config.length, 0);
  });
});

// ─── resolvers.llmReconcile ───────────────────────────────────────────────────

describe("resolvers.llmReconcile", () => {
  test("produces correct kind", () => {
    const def = resolvers.llmReconcile();
    assert.equal(def.kind, RESOLVER_KIND.LLM_RECONCILE);
    assert.equal(def.kind, 0x02);
  });

  test("without runner: config is [0x00] (Option::None)", () => {
    const { config } = resolvers.llmReconcile();
    assert.equal(config.length, 1);
    assert.equal(config[0], 0x00);
  });

  test("with runner: config is [0x01] + 32 address bytes (Option::Some)", () => {
    const { config } = resolvers.llmReconcile(ADDR_A);
    assert.equal(config.length, 33);
    assert.equal(config[0], 0x01);
    assert.ok(config.slice(1).every((b) => b === 0xaa));
  });

  test("decodeLlmConfig roundtrip — no runner", () => {
    const { config } = resolvers.llmReconcile();
    const decoded = decodeLlmConfig(config);
    assert.equal(decoded.runner, undefined);
  });

  test("decodeLlmConfig roundtrip — with runner", () => {
    const { config } = resolvers.llmReconcile(ADDR_A);
    const decoded = decodeLlmConfig(config);
    assert.equal(decoded.runner, ADDR_A);
  });
});

// ─── resolvers.jury ──────────────────────────────────────────────────────────

describe("resolvers.jury", () => {
  test("produces correct kind", () => {
    const def = resolvers.jury([ADDR_A], 1);
    assert.equal(def.kind, RESOLVER_KIND.JURY_RECONCILE);
    assert.equal(def.kind, 0x03);
  });

  test("single judge: config = ULEB128(1) + 32 bytes + k + n", () => {
    const { config } = resolvers.jury([ADDR_A], 1, 1);
    // ULEB128(1) = [0x01], 32 bytes of judge, k=1, n=1 → 35 bytes
    assert.equal(config.length, 35);
    assert.equal(config[0], 0x01);           // ULEB128(1 judge)
    assert.ok(config.slice(1, 33).every((b) => b === 0xaa));
    assert.equal(config[33], 0x01);           // k = 1
    assert.equal(config[34], 0x01);           // n = 1
  });

  test("three judges: config = ULEB128(3) + 96 bytes + k + n", () => {
    const { config } = resolvers.jury([ADDR_A, ADDR_B, ADDR_C], 2, 3);
    // ULEB128(3)=1 byte, 3×32=96 bytes, k=1, n=1 → 99 bytes
    assert.equal(config.length, 99);
    assert.equal(config[0], 0x03);           // 3 judges
    assert.equal(config[97], 0x02);          // k = 2
    assert.equal(config[98], 0x03);          // n = 3
  });

  test("n defaults to judges.length when omitted", () => {
    const def2 = resolvers.jury([ADDR_A, ADDR_B], 1);
    const decoded = decodeJuryConfig(def2.config);
    assert.equal(decoded.n, 2);
  });

  test("decodeJuryConfig roundtrip — 1-of-1", () => {
    const { config } = resolvers.jury([ADDR_A], 1, 1);
    const decoded = decodeJuryConfig(config);
    assert.equal(decoded.judges.length, 1);
    assert.equal(decoded.judges[0], ADDR_A);
    assert.equal(decoded.k, 1);
    assert.equal(decoded.n, 1);
  });

  test("decodeJuryConfig roundtrip — 2-of-3", () => {
    const { config } = resolvers.jury([ADDR_A, ADDR_B, ADDR_C], 2, 3);
    const decoded = decodeJuryConfig(config);
    assert.equal(decoded.judges.length, 3);
    assert.equal(decoded.judges[0], ADDR_A);
    assert.equal(decoded.judges[1], ADDR_B);
    assert.equal(decoded.judges[2], ADDR_C);
    assert.equal(decoded.k, 2);
    assert.equal(decoded.n, 3);
  });
});

// ─── resolvers.and ───────────────────────────────────────────────────────────

describe("resolvers.and", () => {
  test("produces correct kind", () => {
    const def = resolvers.and([resolvers.lastWriteWins(), resolvers.union()]);
    assert.equal(def.kind, RESOLVER_KIND.AND);
    assert.equal(def.kind, 0x05);
  });

  test("encodes n=2 children with ULEB128 length prefix", () => {
    const { config } = resolvers.and([resolvers.lastWriteWins(), resolvers.union()]);
    assert.equal(config[0], 0x02);  // 2 children
  });

  test("decodeChildren roundtrip — two zero-config children", () => {
    const children = [resolvers.lastWriteWins(), resolvers.union()];
    const { config } = resolvers.and(children);
    const decoded = decodeChildren(config);
    assert.equal(decoded.length, 2);
    assert.equal(decoded[0].kind, RESOLVER_KIND.LAST_WRITE_WINS);
    assert.equal(decoded[0].config.length, 0);
    assert.equal(decoded[1].kind, RESOLVER_KIND.UNION);
    assert.equal(decoded[1].config.length, 0);
  });

  test("decodeChildren roundtrip — and(jury, llm)", () => {
    const jury = resolvers.jury([ADDR_A, ADDR_B], 2);
    const llm  = resolvers.llmReconcile(ADDR_C);
    const { config } = resolvers.and([jury, llm]);
    const decoded = decodeChildren(config);

    assert.equal(decoded.length, 2);

    assert.equal(decoded[0].kind, RESOLVER_KIND.JURY_RECONCILE);
    const decodedJury = decodeJuryConfig(decoded[0].config);
    assert.equal(decodedJury.k, 2);
    assert.equal(decodedJury.judges.length, 2);

    assert.equal(decoded[1].kind, RESOLVER_KIND.LLM_RECONCILE);
    const decodedLlm = decodeLlmConfig(decoded[1].config);
    assert.equal(decodedLlm.runner, ADDR_C);
  });
});

// ─── resolvers.sequence ──────────────────────────────────────────────────────

describe("resolvers.sequence", () => {
  test("produces correct kind", () => {
    const def = resolvers.sequence([resolvers.lastWriteWins()]);
    assert.equal(def.kind, RESOLVER_KIND.SEQUENCE);
    assert.equal(def.kind, 0x06);
  });

  test("single child: ULEB128(1) + child encoding", () => {
    const { config } = resolvers.sequence([resolvers.lastWriteWins()]);
    assert.equal(config[0], 0x01);   // 1 child
    assert.equal(config[1], RESOLVER_KIND.LAST_WRITE_WINS);
    assert.equal(config[2], 0x00);   // ULEB128(0) — empty config
  });

  test("decodeChildren roundtrip — sequence(jury, llm) — canonical pattern", () => {
    const jury = resolvers.jury([ADDR_A, ADDR_B, ADDR_C], 2, 3);
    const llm  = resolvers.llmReconcile();
    const { config } = resolvers.sequence([jury, llm]);
    const decoded = decodeChildren(config);

    assert.equal(decoded.length, 2);

    // First child: jury 2-of-3
    assert.equal(decoded[0].kind, RESOLVER_KIND.JURY_RECONCILE);
    const j = decodeJuryConfig(decoded[0].config);
    assert.equal(j.k, 2);
    assert.equal(j.n, 3);
    assert.equal(j.judges.length, 3);

    // Second child: llm, no runner
    assert.equal(decoded[1].kind, RESOLVER_KIND.LLM_RECONCILE);
    const l = decodeLlmConfig(decoded[1].config);
    assert.equal(l.runner, undefined);
  });

  test("deeply nested: sequence([and([jury, lw]), llm]) roundtrips", () => {
    const jury  = resolvers.jury([ADDR_A], 1);
    const inner = resolvers.and([jury, resolvers.lastWriteWins()]);
    const outer = resolvers.sequence([inner, resolvers.llmReconcile(ADDR_B)]);

    const top = decodeChildren(outer.config);
    assert.equal(top.length, 2);
    assert.equal(top[0].kind, RESOLVER_KIND.AND);

    const innerChildren = decodeChildren(top[0].config);
    assert.equal(innerChildren.length, 2);
    assert.equal(innerChildren[0].kind, RESOLVER_KIND.JURY_RECONCILE);
    assert.equal(innerChildren[1].kind, RESOLVER_KIND.LAST_WRITE_WINS);
  });
});

// ─── Kind uniqueness sanity check ────────────────────────────────────────────

describe("RESOLVER_KIND uniqueness", () => {
  test("all resolver kind values are distinct", () => {
    const values = Object.values(RESOLVER_KIND);
    const unique = new Set(values);
    assert.equal(unique.size, values.length, "duplicate kind values detected");
  });

  test("kind values are in the range 0x00–0x06", () => {
    for (const v of Object.values(RESOLVER_KIND)) {
      assert.ok(v >= 0x00 && v <= 0x06, `kind ${v} out of range`);
    }
  });
});
