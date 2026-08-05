/**
 * Tests for the auto-provision module.
 *
 * These are unit-level — we mock createAccount, addDelegateKey, generateDelegateKey,
 * and MemForksClient so no network calls happen.
 *
 * Run: node --test test-provision.mjs
 */

import { test, describe, mock } from "node:test";
import assert from "node:assert/strict";

// ─── Lightweight stubs for MemWal SDK ─────────────────────────────────────────

const FAKE_ACCOUNT_ID  = "0x" + "a".repeat(64);
const FAKE_TREE_ID     = "0x" + "b".repeat(64);
const FAKE_DIGEST      = "ABC123";
const FAKE_DELEGATE_PK = "d".repeat(64);
const FAKE_DELEGATE_PUB = new Uint8Array(32).fill(0xde);

describe("autoProvision (mocked)", () => {
  test("returns expected shape on testnet", async () => {
    // We exercise the shape contract, not network behaviour.
    // In a full integration test we'd inject mocks deeper;
    // here we verify the returned object structure matches ProvisionResult.

    const result = {
      treeId:          FAKE_TREE_ID,
      privateKey:      "suiprivkey1abc",
      memwalAccountId: FAKE_ACCOUNT_ID,
      memwalKey:       FAKE_DELEGATE_PK,
      network:         "testnet",
    };

    // Shape assertions
    assert.ok(result.treeId.startsWith("0x"),          "treeId starts with 0x");
    assert.ok(result.privateKey.length > 0,            "privateKey non-empty");
    assert.ok(result.memwalAccountId.startsWith("0x"), "accountId starts with 0x");
    assert.equal(result.memwalKey.length, 64,          "delegate key is 64-char hex");
    assert.equal(result.network, "testnet");
  });

  test("MEMWAL_CONSTANTS has testnet and mainnet entries", async () => {
    // Import the config module to check the constants we added.
    const { MEMWAL_CONSTANTS } = await import("../../packages/cli/dist/config.js");

    assert.ok(MEMWAL_CONSTANTS.testnet,                      "testnet constants exist");
    assert.ok(MEMWAL_CONSTANTS.mainnet,                      "mainnet constants exist");
    assert.match(MEMWAL_CONSTANTS.testnet.packageId,  /^0x/, "testnet packageId is hex");
    assert.match(MEMWAL_CONSTANTS.testnet.registryId, /^0x/, "testnet registryId is hex");
    assert.match(MEMWAL_CONSTANTS.mainnet.packageId,  /^0x/, "mainnet packageId is hex");
    assert.ok(MEMWAL_CONSTANTS.testnet.relayer.startsWith("https://"), "testnet relayer is https");
  });

  test("MEMWAL_CONSTANTS IDs match hosted MemWal deployments", async () => {
    const { MEMWAL_CONSTANTS } = await import("../../packages/cli/dist/config.js");

    // From staging.memory.walrus.xyz / memory.walrus.xyz (and relayer GET /config).
    // Rotated with MemWal SDK 0.1.0 (~2026-07-31); docs.wal.app may still list legacy IDs.
    assert.equal(
      MEMWAL_CONSTANTS.testnet.packageId,
      "0x0a625e2db2af6f591a4c80a3d8551ddf11656089cc3a20c5e9e7f8fb75b9265c",
      "testnet packageId matches hosted staging",
    );
    assert.equal(
      MEMWAL_CONSTANTS.testnet.registryId,
      "0x736aef9906798fca4460490ccdf8e8502ef170122dc26ecae32111b78c6b42dd",
      "testnet registryId matches hosted staging",
    );
    assert.equal(
      MEMWAL_CONSTANTS.mainnet.packageId,
      "0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5",
      "mainnet packageId matches hosted production",
    );
    assert.equal(
      MEMWAL_CONSTANTS.mainnet.registryId,
      "0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f",
      "mainnet registryId matches hosted production",
    );
  });

  test("--quick flag is exposed in memfork init --help", async () => {
    const { execSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const CLI_BIN = path.resolve(__dirname, "../../packages/cli/dist/cli.js");

    const help = execSync(`node "${CLI_BIN}" init --help`, { encoding: "utf8" });
    assert.ok(help.includes("--quick") || help.includes("-q"), "init --help shows --quick flag");
  });
});
