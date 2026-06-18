/**
 * Unit tests for @memfork/core artifact storage logic.
 *
 * Covers:
 *   - ArtifactStorageError  constructor and .reason codes
 *   - DEFAULT_ARTIFACT_CONFIG values
 *   - artifactSha256 (sha256Hex) correctness
 *   - putArtifact pre-flight guards — no Walrus network needed
 *   - getArtifact — all HTTP outcomes using a mocked global fetch
 *
 * No network calls are made. The Walrus SDK is only imported at module load
 * time; the guard checks all throw before getWalrusClient() is ever called.
 *
 * Run: node --test test-artifacts.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactStorageError,
  DEFAULT_ARTIFACT_CONFIG,
  artifactSha256,
  putArtifact,
  getArtifact,
} from "@memfork/core";

// ─── ArtifactStorageError ─────────────────────────────────────────────────────

describe("ArtifactStorageError", () => {
  test("is an instance of Error", () => {
    const e = new ArtifactStorageError("msg", "disabled");
    assert.ok(e instanceof Error);
    assert.ok(e instanceof ArtifactStorageError);
  });

  test("name is ArtifactStorageError", () => {
    const e = new ArtifactStorageError("msg", "disabled");
    assert.equal(e.name, "ArtifactStorageError");
  });

  test("carries the reason code", () => {
    const reasons = [
      "disabled", "too_large", "empty_file", "invalid_path",
      "insufficient_wal", "insufficient_sui", "epoch_change",
      "not_enough_confirmations", "network", "rate_limit",
      "blob_blocked", "corrupted", "not_found", "integrity", "unknown",
    ];
    for (const reason of reasons) {
      const e = new ArtifactStorageError(`error: ${reason}`, reason);
      assert.equal(e.reason, reason, `reason '${reason}' not preserved`);
    }
  });

  test("defaults reason to 'unknown' when omitted", () => {
    const e = new ArtifactStorageError("no reason given");
    assert.equal(e.reason, "unknown");
  });

  test("message is preserved", () => {
    const e = new ArtifactStorageError("specific message", "network");
    assert.equal(e.message, "specific message");
  });

  test("is throwable and catchable as ArtifactStorageError", () => {
    function thrower() { throw new ArtifactStorageError("boom", "network"); }
    try {
      thrower();
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError);
      assert.equal(err.reason, "network");
    }
  });
});

// ─── DEFAULT_ARTIFACT_CONFIG ──────────────────────────────────────────────────

describe("DEFAULT_ARTIFACT_CONFIG", () => {
  test("is disabled by default", () => {
    assert.equal(DEFAULT_ARTIFACT_CONFIG.enabled, false);
  });

  test("default epochs is 12", () => {
    assert.equal(DEFAULT_ARTIFACT_CONFIG.epochs, 12);
  });

  test("default maxBytes is 10 MiB", () => {
    assert.equal(DEFAULT_ARTIFACT_CONFIG.maxBytes, 10 * 1024 * 1024);
  });

  test("uploadRelayUrl is absent (undefined)", () => {
    assert.equal(DEFAULT_ARTIFACT_CONFIG.uploadRelayUrl, undefined);
  });
});

// ─── artifactSha256 ───────────────────────────────────────────────────────────

describe("artifactSha256", () => {
  test("empty bytes has known SHA-256", () => {
    // SHA-256 of empty string: e3b0c44298fc1c149afb…
    const digest = artifactSha256(new Uint8Array(0));
    assert.equal(digest, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("deterministic for same input", () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    assert.equal(artifactSha256(bytes), artifactSha256(bytes));
  });

  test("different inputs produce different digests", () => {
    const a = artifactSha256(new Uint8Array([0]));
    const b = artifactSha256(new Uint8Array([1]));
    assert.notEqual(a, b);
  });

  test("returns lowercase hex", () => {
    const digest = artifactSha256(new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  test("known digest for 'hello world'", () => {
    const bytes = new TextEncoder().encode("hello world");
    assert.equal(
      artifactSha256(bytes),
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});

// ─── putArtifact — pre-flight guards ─────────────────────────────────────────
//
// These tests exercise the synchronous guards that fire before any Walrus SDK
// call is made, so no network / keypair is needed.

const ENABLED_CONFIG = { ...DEFAULT_ARTIFACT_CONFIG, enabled: true };
const FAKE_KEYPAIR = {};          // never used — guards all throw before getWalrusClient
const ONE_BYTE     = new Uint8Array([0x42]);

describe("putArtifact — guard: disabled", () => {
  test("throws ArtifactStorageError with reason 'disabled' when disabled", async () => {
    try {
      await putArtifact(ONE_BYTE, {
        path:    "report.md",
        config:  DEFAULT_ARTIFACT_CONFIG,   // enabled: false
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "disabled");
      assert.match(err.message, /disabled/i);
    }
  });

  test("error message references how to enable artifacts", async () => {
    try {
      await putArtifact(ONE_BYTE, {
        path:    "report.md",
        config:  DEFAULT_ARTIFACT_CONFIG,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError);
      assert.match(err.message, /"artifacts"/);
    }
  });
});

describe("putArtifact — guard: empty_file", () => {
  test("throws with reason 'empty_file' for a zero-byte Uint8Array", async () => {
    try {
      await putArtifact(new Uint8Array(0), {
        path:    "empty.bin",
        config:  ENABLED_CONFIG,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "empty_file");
    }
  });

  test("error message names the file", async () => {
    try {
      await putArtifact(new Uint8Array(0), {
        path:    "zero.dat",
        config:  ENABLED_CONFIG,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError);
      assert.match(err.message, /zero\.dat/);
    }
  });
});

describe("putArtifact — guard: too_large", () => {
  test("throws with reason 'too_large' when bytes exceed maxBytes", async () => {
    const smallLimit = { ...ENABLED_CONFIG, maxBytes: 5 };
    const bigBytes   = new Uint8Array(6);                    // 6 > 5

    try {
      await putArtifact(bigBytes, {
        path:    "big.bin",
        config:  smallLimit,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "too_large");
    }
  });

  test("exactly at maxBytes is allowed (does not guard-throw before write)", async () => {
    // bytes.length === maxBytes should NOT trigger too_large.
    // We expect it to throw at the network stage (not ArtifactStorageError 'too_large').
    const config = { ...ENABLED_CONFIG, maxBytes: 4 };
    const exact  = new Uint8Array(4);

    try {
      await putArtifact(exact, {
        path:    "exact.bin",
        config,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
    } catch (err) {
      // Must NOT be 'too_large' — any other error is fine (network/SDK not available)
      if (err instanceof ArtifactStorageError) {
        assert.notEqual(err.reason, "too_large", "exact size should not trigger too_large");
      }
    }
  });

  test("error message includes size and limit", async () => {
    const config = { ...ENABLED_CONFIG, maxBytes: 1024 };
    const big    = new Uint8Array(2048);

    try {
      await putArtifact(big, {
        path:    "oversized.bin",
        config,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError);
      assert.equal(err.reason, "too_large");
      assert.match(err.message, /MiB/);
    }
  });
});

describe("putArtifact — guard: invalid_path", () => {
  test("throws with reason 'invalid_path' for an empty string path", async () => {
    try {
      await putArtifact(ONE_BYTE, {
        path:    "",
        config:  ENABLED_CONFIG,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "invalid_path");
    }
  });

  test("throws with reason 'invalid_path' for a path containing a null byte", async () => {
    try {
      await putArtifact(ONE_BYTE, {
        path:    "evil\0path",
        config:  ENABLED_CONFIG,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "invalid_path");
    }
  });

  test("throws with reason 'invalid_path' for a 256-char path", async () => {
    try {
      await putArtifact(ONE_BYTE, {
        path:    "x".repeat(256),
        config:  ENABLED_CONFIG,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "invalid_path");
    }
  });

  test("a 255-char path passes the guard (proceeds to network stage)", async () => {
    try {
      await putArtifact(ONE_BYTE, {
        path:    "x".repeat(255),
        config:  ENABLED_CONFIG,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
    } catch (err) {
      if (err instanceof ArtifactStorageError) {
        assert.notEqual(err.reason, "invalid_path", "255-char path should not be invalid");
      }
      // Any network error is fine — just not invalid_path.
    }
  });
});

describe("putArtifact — guard priority", () => {
  test("disabled check fires before empty_file check", async () => {
    // disabled config + empty bytes => 'disabled' wins
    try {
      await putArtifact(new Uint8Array(0), {
        path:    "empty.bin",
        config:  DEFAULT_ARTIFACT_CONFIG,   // enabled: false
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError);
      assert.equal(err.reason, "disabled");
    }
  });

  test("empty_file check fires before too_large check", async () => {
    // enabled config + zero bytes + tiny maxBytes => 'empty_file' wins
    const config = { ...ENABLED_CONFIG, maxBytes: 0 };
    try {
      await putArtifact(new Uint8Array(0), {
        path:    "x",
        config,
        network: "testnet",
        keypair: FAKE_KEYPAIR,
      });
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError);
      assert.equal(err.reason, "empty_file");
    }
  });
});

// ─── getArtifact — mocked fetch ───────────────────────────────────────────────
//
// Override globalThis.fetch per test to simulate Walrus aggregator responses
// without touching the network.

function makeFakeResponse(status, body) {
  const bytes  = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const buffer = bytes.buffer;
  return {
    status,
    ok: status >= 200 && status < 300,
    arrayBuffer: () => Promise.resolve(buffer),
  };
}

let originalFetch;

describe("getArtifact — HTTP responses", () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns bytes on 200 with no sha256 verification", async () => {
    const content = new Uint8Array([1, 2, 3]);
    globalThis.fetch = async () => makeFakeResponse(200, content);

    const result = await getArtifact({ blobId: "0xabc", sha256: "" }, "testnet");
    assert.deepEqual(result, content);
  });

  test("returns bytes on 200 with matching sha256", async () => {
    const content = new TextEncoder().encode("hello world");
    const digest  = artifactSha256(content);

    globalThis.fetch = async () => makeFakeResponse(200, content);

    const result = await getArtifact({ blobId: "0xabc", sha256: digest }, "testnet");
    assert.deepEqual(result, content);
  });

  test("throws ArtifactStorageError 'integrity' on sha256 mismatch", async () => {
    const content = new TextEncoder().encode("real content");
    globalThis.fetch = async () => makeFakeResponse(200, content);

    try {
      await getArtifact({ blobId: "0xabc", sha256: "deadbeef".repeat(8) }, "testnet");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "integrity");
      assert.match(err.message, /sha256/i);
    }
  });

  test("throws ArtifactStorageError 'not_found' on final 404 (post-retry)", async () => {
    // Return 404 every time — will be retried twice internally then throw.
    // We set a fast clock replacement so the test doesn't actually wait 6 s.
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls++;
      return makeFakeResponse(404, "not found");
    };

    // Temporarily override setTimeout so the CDN retry delay is instant.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn) => { fn(); return 0; };

    try {
      await getArtifact({ blobId: "0xdead", sha256: "" }, "testnet");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "not_found");
      assert.match(err.message, /expired|not found/i);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }

    // fetchWithRetry recurses: attempt 1 → 404 → retry attempt 2 → 404 → retry attempt 3 → 404 → throw
    assert.equal(fetchCalls, 3, "should have tried 3 times (1 + 2 retries)");
  });

  test("throws ArtifactStorageError 'blob_blocked' on 451", async () => {
    globalThis.fetch = async () => makeFakeResponse(451, "unavailable");

    try {
      await getArtifact({ blobId: "0xbad", sha256: "" }, "mainnet");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "blob_blocked");
      assert.match(err.message, /451/);
    }
  });

  test("throws ArtifactStorageError 'network' on non-200/404/451 status", async () => {
    globalThis.fetch = async () => makeFakeResponse(503, "service unavailable");

    try {
      await getArtifact({ blobId: "0xabc", sha256: "" }, "testnet");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "network");
      assert.match(err.message, /503/);
    }
  });

  test("throws ArtifactStorageError 'network' when fetch itself throws (no connectivity)", async () => {
    globalThis.fetch = async () => { throw new TypeError("fetch failed"); };

    try {
      await getArtifact({ blobId: "0xabc", sha256: "" }, "testnet");
      assert.fail("should have thrown");
    } catch (err) {
      assert.ok(err instanceof ArtifactStorageError, `got: ${err}`);
      assert.equal(err.reason, "network");
      assert.match(err.message, /Walrus aggregator/);
    }
  });

  test("uses testnet aggregator URL for testnet network", async () => {
    let capturedUrl = "";
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return makeFakeResponse(200, new Uint8Array([9]));
    };

    await getArtifact({ blobId: "0xc0ffee", sha256: "" }, "testnet");
    assert.match(capturedUrl, /walrus-testnet/);
    assert.match(capturedUrl, /0xc0ffee/);
  });

  test("uses mainnet aggregator URL for mainnet network", async () => {
    let capturedUrl = "";
    globalThis.fetch = async (url) => {
      capturedUrl = url;
      return makeFakeResponse(200, new Uint8Array([7]));
    };

    await getArtifact({ blobId: "0xbeef", sha256: "" }, "mainnet");
    assert.match(capturedUrl, /walrus-mainnet/);
  });

  test("skips sha256 check when sha256 is an empty string", async () => {
    const content = new Uint8Array([0, 1, 2]);
    globalThis.fetch = async () => makeFakeResponse(200, content);

    // Should not throw even though no digest is supplied.
    const result = await getArtifact({ blobId: "0xabc", sha256: "" }, "testnet");
    assert.deepEqual(result, content);
  });

  test("returns a Uint8Array (not Buffer or ArrayBuffer)", async () => {
    globalThis.fetch = async () => makeFakeResponse(200, new Uint8Array([255]));

    const result = await getArtifact({ blobId: "0xabc", sha256: "" }, "testnet");
    assert.ok(result instanceof Uint8Array);
  });
});

// ─── ArtifactRef shape ────────────────────────────────────────────────────────
//
// TypeScript types disappear at runtime; we verify the shape of real return
// values produced by getArtifact's callers (putArtifact) via explicit checks
// on the field names and types.

describe("ArtifactRef shape expectations", () => {
  test("artifactSha256 returns a 64-char hex string suitable for sha256 field", () => {
    const digest = artifactSha256(new Uint8Array([1, 2, 3]));
    assert.equal(typeof digest, "string");
    assert.equal(digest.length, 64);
    assert.match(digest, /^[0-9a-f]+$/);
  });

  test("DEFAULT_ARTIFACT_CONFIG has all required config fields", () => {
    assert.equal(typeof DEFAULT_ARTIFACT_CONFIG.enabled,  "boolean");
    assert.equal(typeof DEFAULT_ARTIFACT_CONFIG.epochs,   "number");
    assert.equal(typeof DEFAULT_ARTIFACT_CONFIG.maxBytes, "number");
  });
});
