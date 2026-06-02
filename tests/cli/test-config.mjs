/**
 * Unit tests for the config layer — no network, no secrets needed.
 * Uses Node's built-in test runner: `node --test test-config.mjs`
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ─── Import from built dist ────────────────────────────────────────────────────
// The workspace links @memfork/cli → cli/dist, which is now built.

const {
  readProjectConfig,
  writeProjectConfig,
  readCredentials,
  writeCredentials,
  upsertCredential,
  setDefaultTree,
  resolveConfig,
  projectConfigPath,
  credentialsPath,
} = await import("@memfork/cli");

// ─── Helpers ──────────────────────────────────────────────────────────────────

let tmpProject;
let origHome;
let tmpHome;

function setup() {
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "mf-test-project-"));
  tmpHome    = fs.mkdtempSync(path.join(os.tmpdir(), "mf-test-home-"));
  origHome   = process.env["HOME"];
  process.env["HOME"] = tmpHome;
  // Also override cwd for project-scoped calls
  process.chdir(tmpProject);
}

function teardown() {
  process.env["HOME"] = origHome;
  fs.rmSync(tmpProject, { recursive: true, force: true });
  fs.rmSync(tmpHome,    { recursive: true, force: true });
}

const FAKE_TREE_ID  = "0x" + "a".repeat(64);
const FAKE_KEY      = "suiprivkey1qpsj4lrnfnzvle5n7lsulskdxphax092p8rk0yw5xp7kzylvz069669eanq";
const FAKE_MEMWAL   = "0x" + "b".repeat(64);
const FAKE_MW_KEY   = "f".repeat(64);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("project config", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("readProjectConfig returns null when no file exists", () => {
    const cfg = readProjectConfig();
    assert.equal(cfg, null);
  });

  test("writeProjectConfig creates .memfork/config.json", () => {
    writeProjectConfig({ treeId: FAKE_TREE_ID, network: "testnet" });
    const cfg = readProjectConfig();
    assert.ok(cfg);
    assert.equal(cfg.treeId, FAKE_TREE_ID);
    assert.equal(cfg.network, "testnet");
  });

  test("writeProjectConfig is idempotent", () => {
    writeProjectConfig({ treeId: FAKE_TREE_ID });
    writeProjectConfig({ treeId: FAKE_TREE_ID, defaultBranch: "dev" });
    const cfg = readProjectConfig();
    assert.equal(cfg?.defaultBranch, "dev");
  });
});

describe("credentials", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("readCredentials returns empty trees when no file", () => {
    const creds = readCredentials();
    assert.deepEqual(creds, { trees: {} });
  });

  test("upsertCredential writes + sets default", () => {
    upsertCredential(FAKE_TREE_ID, {
      privateKey:      FAKE_KEY,
      memwalAccountId: FAKE_MEMWAL,
      memwalKey:       FAKE_MW_KEY,
    });
    const creds = readCredentials();
    assert.equal(creds.default, FAKE_TREE_ID);
    assert.equal(creds.trees[FAKE_TREE_ID]?.privateKey, FAKE_KEY);
  });

  test("credentials file is chmod 600", () => {
    upsertCredential(FAKE_TREE_ID, {
      privateKey: FAKE_KEY, memwalAccountId: FAKE_MEMWAL, memwalKey: FAKE_MW_KEY,
    });
    const p = credentialsPath();
    const mode = fs.statSync(p).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0o600, got 0o${mode.toString(8)}`);
  });

  test("setDefaultTree updates default", () => {
    const A = "0x" + "a".repeat(64);
    const B = "0x" + "b".repeat(64);
    upsertCredential(A, { privateKey: FAKE_KEY, memwalAccountId: FAKE_MEMWAL, memwalKey: FAKE_MW_KEY });
    upsertCredential(B, { privateKey: FAKE_KEY, memwalAccountId: FAKE_MEMWAL, memwalKey: FAKE_MW_KEY });
    setDefaultTree(B);
    assert.equal(readCredentials().default, B);
  });
});

describe("resolveConfig — layering", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("throws ConfigError when nothing is configured", () => {
    delete process.env["MEMFORK_TREE_ID"];
    delete process.env["MEMFORK_PRIVATE_KEY"];
    assert.throws(
      () => resolveConfig(),
      (e) => e.name === "ConfigError",
    );
  });

  test("resolves from project config + credentials", () => {
    writeProjectConfig({ treeId: FAKE_TREE_ID, network: "testnet" });
    upsertCredential(FAKE_TREE_ID, {
      privateKey: FAKE_KEY, memwalAccountId: FAKE_MEMWAL, memwalKey: FAKE_MW_KEY,
    });
    const cfg = resolveConfig();
    assert.equal(cfg.treeId,         FAKE_TREE_ID);
    assert.equal(cfg.network,        "testnet");
    assert.equal(cfg.privateKey,     FAKE_KEY);
    assert.equal(cfg.memwalAccountId, FAKE_MEMWAL);
  });

  test("env vars take priority over stored config", () => {
    writeProjectConfig({ treeId: FAKE_TREE_ID, network: "testnet" });
    upsertCredential(FAKE_TREE_ID, {
      privateKey: FAKE_KEY, memwalAccountId: FAKE_MEMWAL, memwalKey: FAKE_MW_KEY,
    });

    const overrideTree = "0x" + "c".repeat(64);
    process.env["MEMFORK_TREE_ID"]      = overrideTree;
    process.env["MEMFORK_PRIVATE_KEY"]  = FAKE_KEY;
    process.env["MEMFORK_MEMWAL_ACCOUNT"] = FAKE_MEMWAL;
    process.env["MEMFORK_MEMWAL_KEY"]   = FAKE_MW_KEY;

    const cfg = resolveConfig();
    assert.equal(cfg.treeId, overrideTree);

    delete process.env["MEMFORK_TREE_ID"];
    delete process.env["MEMFORK_PRIVATE_KEY"];
    delete process.env["MEMFORK_MEMWAL_ACCOUNT"];
    delete process.env["MEMFORK_MEMWAL_KEY"];
  });
});
