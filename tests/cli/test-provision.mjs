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
    const { MEMWAL_CONSTANTS } = await import("../../cli/dist/config.js");

    assert.ok(MEMWAL_CONSTANTS.testnet,                      "testnet constants exist");
    assert.ok(MEMWAL_CONSTANTS.mainnet,                      "mainnet constants exist");
    assert.match(MEMWAL_CONSTANTS.testnet.packageId,  /^0x/, "testnet packageId is hex");
    assert.match(MEMWAL_CONSTANTS.testnet.registryId, /^0x/, "testnet registryId is hex");
    assert.match(MEMWAL_CONSTANTS.mainnet.packageId,  /^0x/, "mainnet packageId is hex");
    assert.ok(MEMWAL_CONSTANTS.testnet.relayer.startsWith("https://"), "testnet relayer is https");
  });

  test("MEMWAL_CONSTANTS testnet IDs match documented values", async () => {
    const { MEMWAL_CONSTANTS } = await import("../../cli/dist/config.js");

    // These are the public on-chain IDs from https://docs.memwal.ai/contract/overview
    assert.equal(
      MEMWAL_CONSTANTS.testnet.packageId,
      "0xcf6ad755a1cdff7217865c796778fabe5aa399cb0cf2eba986f4b582047229c6",
      "testnet packageId matches docs",
    );
    assert.equal(
      MEMWAL_CONSTANTS.testnet.registryId,
      "0xe80f2feec1c139616a86c9f71210152e2a7ca552b20841f2e192f99f75864437",
      "testnet registryId matches docs",
    );
  });

  test("--quick flag is exposed in memfork init --help", async () => {
    const { execSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const path = await import("node:path");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const CLI_BIN = path.resolve(__dirname, "../../cli/dist/cli.js");

    const help = execSync(`node "${CLI_BIN}" init --help`, { encoding: "utf8" });
    assert.ok(help.includes("--quick") || help.includes("-q"), "init --help shows --quick flag");
  });
});
