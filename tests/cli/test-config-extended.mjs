/**
 * Extended config tests — covers the scenarios missing from test-config.mjs:
 *
 *   - ConfigError when individual credentials are missing (private key,
 *     memwalAccountId, memwalKey) — each has a distinct error message
 *   - network defaults to "mainnet" (not testnet)
 *   - relayer URL is derived from the resolved network
 *   - MEMFORK_RELAYER_URL / MEMFORK_NETWORK / MEMFORK_PACKAGE_ID env overrides
 *   - toClientConfig maps every field to the SDK shape correctly
 *   - findProjectConfig walks up the directory tree (not just the cwd)
 *   - writeProjectConfig anchors at the git root (not the cwd subdirectory)
 *   - upsertCredential does NOT overwrite an existing default pointer
 *   - credentials file with multiple trees, manual default switch
 *
 * No network, no MemWal, no Sui.
 *
 * Run: node --test test-config-extended.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const {
  readProjectConfig,
  writeProjectConfig,
  readCredentials,
  writeCredentials,
  upsertCredential,
  setDefaultTree,
  resolveConfig,
  toClientConfig,
  projectConfigPath,
  credentialsPath,
} = await import("@memfork/cli");

// MEMWAL_CONSTANTS is not part of the public @memfork/cli export surface;
// import directly from the built dist (same approach as test-provision.mjs).
import { fileURLToPath } from "node:url";
const __dirname_ext = path.dirname(fileURLToPath(import.meta.url));
const { MEMWAL_CONSTANTS } = await import(
  path.resolve(__dirname_ext, "../../packages/cli/dist/config.js")
);

// ─── Shared setup / teardown ─────────────────────────────────────────────────

let tmpProject;
let tmpHome;
let origHome;
let origCwd;

// A complete set of valid fake credentials.
const TREE_A = "0x" + "a".repeat(64);
const TREE_B = "0x" + "b".repeat(64);
const KEY    = "suiprivkey1qpsj4lrnfnzvle5n7lsulskdxphax092p8rk0yw5xp7kzylvz069669eanq";
const MW_ACC = "0x" + "c".repeat(64);
const MW_KEY = "d".repeat(64);

function setup() {
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "mf-cfg-ext-project-"));
  tmpHome    = fs.mkdtempSync(path.join(os.tmpdir(), "mf-cfg-ext-home-"));
  origHome   = process.env["HOME"];
  origCwd    = process.cwd();
  process.env["HOME"] = tmpHome;

  // Create a .git directory so writeProjectConfig anchors here.
  fs.mkdirSync(path.join(tmpProject, ".git"));
  process.chdir(tmpProject);

  // Clear any inherited env overrides so tests start from a clean slate.
  for (const k of [
    "MEMFORK_TREE_ID", "MEMFORK_PRIVATE_KEY",
    "MEMFORK_MEMWAL_ACCOUNT", "MEMFORK_MEMWAL_KEY",
    "MEMFORK_NETWORK", "MEMFORK_RELAYER_URL", "MEMFORK_PACKAGE_ID",
    "MEMFORK_RPC_URL", "MEMFORK_SPONSOR_URL",
  ]) delete process.env[k];
}

function teardown() {
  process.env["HOME"] = origHome;
  process.chdir(origCwd);
  fs.rmSync(tmpProject, { recursive: true, force: true });
  fs.rmSync(tmpHome,    { recursive: true, force: true });

  for (const k of [
    "MEMFORK_TREE_ID", "MEMFORK_PRIVATE_KEY",
    "MEMFORK_MEMWAL_ACCOUNT", "MEMFORK_MEMWAL_KEY",
    "MEMFORK_NETWORK", "MEMFORK_RELAYER_URL", "MEMFORK_PACKAGE_ID",
    "MEMFORK_RPC_URL", "MEMFORK_SPONSOR_URL",
  ]) delete process.env[k];
}

function seedFullConfig(treeId = TREE_A) {
  writeProjectConfig({ treeId, network: "testnet" });
  upsertCredential(treeId, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });
}

// ─── ConfigError — individual missing fields ──────────────────────────────────

describe("resolveConfig — ConfigError for missing individual fields", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("missing privateKey throws ConfigError with MEMFORK_PRIVATE_KEY hint", () => {
    writeProjectConfig({ treeId: TREE_A, network: "testnet" });
    // Credential exists but privateKey is omitted
    writeCredentials({
      default: TREE_A,
      trees: { [TREE_A]: { privateKey: "", memwalAccountId: MW_ACC, memwalKey: MW_KEY } },
    });

    // Override key but leave private key empty
    process.env["MEMFORK_TREE_ID"] = TREE_A;
    assert.throws(
      () => resolveConfig(),
      (e) => {
        assert.equal(e.name, "ConfigError");
        assert.ok(
          e.message.includes("MEMFORK_PRIVATE_KEY") || e.message.includes("private key"),
          `unexpected message: ${e.message}`,
        );
        return true;
      },
    );
  });

  test("missing memwalAccountId throws ConfigError with MEMFORK_MEMWAL_ACCOUNT hint", () => {
    writeProjectConfig({ treeId: TREE_A, network: "testnet" });
    writeCredentials({
      default: TREE_A,
      trees: { [TREE_A]: { privateKey: KEY, memwalAccountId: "", memwalKey: MW_KEY } },
    });

    assert.throws(
      () => resolveConfig(),
      (e) => {
        assert.equal(e.name, "ConfigError");
        assert.ok(
          e.message.includes("MEMFORK_MEMWAL_ACCOUNT") || e.message.includes("MemWal account"),
          `unexpected message: ${e.message}`,
        );
        return true;
      },
    );
  });

  test("missing memwalKey throws ConfigError with MEMFORK_MEMWAL_KEY hint", () => {
    writeProjectConfig({ treeId: TREE_A, network: "testnet" });
    writeCredentials({
      default: TREE_A,
      trees: { [TREE_A]: { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: "" } },
    });

    assert.throws(
      () => resolveConfig(),
      (e) => {
        assert.equal(e.name, "ConfigError");
        assert.ok(
          e.message.includes("MEMFORK_MEMWAL_KEY") || e.message.includes("delegate key"),
          `unexpected message: ${e.message}`,
        );
        return true;
      },
    );
  });
});

// ─── Network defaults ─────────────────────────────────────────────────────────

describe("resolveConfig — network defaults", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("network defaults to mainnet when not specified in project config", () => {
    writeProjectConfig({ treeId: TREE_A });  // no network key
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });

    const cfg = resolveConfig();
    assert.equal(cfg.network, "mainnet");
  });

  test("relayer URL is mainnet relayer when network=mainnet", () => {
    writeProjectConfig({ treeId: TREE_A, network: "mainnet" });
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });

    const cfg = resolveConfig();
    assert.equal(cfg.memwalRelayer, MEMWAL_CONSTANTS.mainnet.relayer);
  });

  test("relayer URL is testnet relayer when network=testnet", () => {
    writeProjectConfig({ treeId: TREE_A, network: "testnet" });
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });

    const cfg = resolveConfig();
    assert.equal(cfg.memwalRelayer, MEMWAL_CONSTANTS.testnet.relayer);
  });
});

// ─── Env var overrides ────────────────────────────────────────────────────────

describe("resolveConfig — env var overrides", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("MEMFORK_NETWORK overrides project config network", () => {
    seedFullConfig();  // writes testnet into project config
    process.env["MEMFORK_NETWORK"] = "mainnet";

    const cfg = resolveConfig();
    assert.equal(cfg.network, "mainnet");
  });

  test("MEMFORK_RELAYER_URL overrides the derived relayer", () => {
    seedFullConfig();
    process.env["MEMFORK_RELAYER_URL"] = "https://custom-relayer.example.com";

    const cfg = resolveConfig();
    assert.equal(cfg.memwalRelayer, "https://custom-relayer.example.com");
  });

  test("MEMFORK_PACKAGE_ID overrides packageId", () => {
    seedFullConfig();
    const customPkg = "0x" + "ff".repeat(32);
    process.env["MEMFORK_PACKAGE_ID"] = customPkg;

    const cfg = resolveConfig();
    assert.equal(cfg.packageId, customPkg);
  });

  test("MEMFORK_SPONSOR_URL is surfaced in resolved config", () => {
    seedFullConfig();
    process.env["MEMFORK_SPONSOR_URL"] = "https://sponsor.example.com";

    const cfg = resolveConfig();
    assert.equal(cfg.sponsorUrl, "https://sponsor.example.com");
  });

  test("stored per-tree memwalRelayer override is used when no env var", () => {
    const customRelayer = "https://my-relayer.example.com";
    writeProjectConfig({ treeId: TREE_A, network: "testnet" });
    writeCredentials({
      default: TREE_A,
      trees: {
        [TREE_A]: {
          privateKey: KEY,
          memwalAccountId: MW_ACC,
          memwalKey: MW_KEY,
          memwalRelayer: customRelayer,
        },
      },
    });

    const cfg = resolveConfig();
    assert.equal(cfg.memwalRelayer, customRelayer);
  });
});

// ─── defaultBranch ────────────────────────────────────────────────────────────

describe("resolveConfig — defaultBranch", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("defaults to 'main' when not in project config", () => {
    writeProjectConfig({ treeId: TREE_A });
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });

    const cfg = resolveConfig();
    assert.equal(cfg.defaultBranch, "main");
  });

  test("uses value from project config", () => {
    writeProjectConfig({ treeId: TREE_A, defaultBranch: "develop" });
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });

    const cfg = resolveConfig();
    assert.equal(cfg.defaultBranch, "develop");
  });
});

// ─── toClientConfig ───────────────────────────────────────────────────────────

describe("toClientConfig", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("maps all fields to the SDK MemForksClientConfig shape", () => {
    seedFullConfig();
    const resolved = resolveConfig();
    const clientCfg = toClientConfig(resolved);

    assert.equal(clientCfg.treeId,               resolved.treeId);
    assert.equal(clientCfg.signer,               resolved.privateKey);
    assert.equal(clientCfg.network,              resolved.network);
    assert.equal(clientCfg.memwal.accountId,     resolved.memwalAccountId);
    assert.equal(clientCfg.memwal.delegateKey,   resolved.memwalKey);
    assert.equal(clientCfg.memwal.serverUrl,     resolved.memwalRelayer);
  });

  test("optional fields (rpcUrl, packageId, sponsorUrl) are passed through", () => {
    seedFullConfig();
    process.env["MEMFORK_SPONSOR_URL"] = "https://sponsor.test";

    const clientCfg = toClientConfig(resolveConfig());
    assert.equal(clientCfg.sponsorUrl, "https://sponsor.test");
  });

  test("optional fields are undefined when not configured", () => {
    seedFullConfig();

    const clientCfg = toClientConfig(resolveConfig());
    assert.equal(clientCfg.rpcUrl,     undefined);
    assert.equal(clientCfg.packageId,  undefined);
    assert.equal(clientCfg.sponsorUrl, undefined);
  });
});

// ─── findProjectConfig — directory walk ───────────────────────────────────────

describe("resolveConfig — findProjectConfig directory walk", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("finds .memfork/config.json two levels up from cwd", () => {
    // Seed config at the project root
    writeProjectConfig({ treeId: TREE_A, network: "testnet" });
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });

    // Change into a nested subdirectory
    const nested = path.join(tmpProject, "src", "components");
    fs.mkdirSync(nested, { recursive: true });
    process.chdir(nested);

    // resolveConfig should walk up and find the config
    const cfg = resolveConfig();
    assert.equal(cfg.treeId, TREE_A);
  });

  test("returns ConfigError when there is no .memfork anywhere in the tree", () => {
    const isolated = fs.mkdtempSync(path.join(os.tmpdir(), "mf-isolated-"));
    process.chdir(isolated);

    assert.throws(
      () => resolveConfig(),
      (e) => e.name === "ConfigError",
    );

    fs.rmSync(isolated, { recursive: true, force: true });
  });
});

// ─── writeProjectConfig — git root anchoring ─────────────────────────────────

describe("writeProjectConfig — git root anchoring", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("writes config.json to git root even when cwd is a subdirectory", () => {
    const subdir = path.join(tmpProject, "packages", "core");
    fs.mkdirSync(subdir, { recursive: true });
    process.chdir(subdir);

    writeProjectConfig({ treeId: TREE_A, network: "testnet" });

    // Config should be at the git root, not inside packages/core
    const atRoot = path.join(tmpProject, ".memfork", "config.json");
    assert.ok(fs.existsSync(atRoot), ".memfork/config.json should be at git root");

    const wrongPath = path.join(subdir, ".memfork", "config.json");
    assert.ok(!fs.existsSync(wrongPath), "config.json should NOT be in the subdir");
  });
});

// ─── upsertCredential — default pointer logic ─────────────────────────────────

describe("upsertCredential — default pointer", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("sets default to treeId on first upsert", () => {
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });
    assert.equal(readCredentials().default, TREE_A);
  });

  test("does NOT overwrite an existing default when a second tree is added", () => {
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });
    upsertCredential(TREE_B, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });

    // TREE_A was set as default first; TREE_B should NOT displace it.
    assert.equal(readCredentials().default, TREE_A);
  });

  test("setDefaultTree can explicitly change the default", () => {
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });
    upsertCredential(TREE_B, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });
    setDefaultTree(TREE_B);

    assert.equal(readCredentials().default, TREE_B);
  });

  test("resolveConfig picks up credentials for the default tree", () => {
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: MW_ACC, memwalKey: MW_KEY });
    upsertCredential(TREE_B, { privateKey: KEY, memwalAccountId: "0x" + "e".repeat(64), memwalKey: MW_KEY });

    // No project config — falls back to default tree (TREE_A)
    const cfg = resolveConfig();
    assert.equal(cfg.treeId, TREE_A);
    assert.equal(cfg.memwalAccountId, MW_ACC);
  });
});

// ─── Multiple trees in credentials ───────────────────────────────────────────

describe("credentials — multiple trees", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("both trees are stored independently", () => {
    const mwA = "0x" + "c".repeat(64);
    const mwB = "0x" + "d".repeat(64);

    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: mwA, memwalKey: MW_KEY });
    upsertCredential(TREE_B, { privateKey: KEY, memwalAccountId: mwB, memwalKey: MW_KEY });

    const creds = readCredentials();
    assert.equal(creds.trees[TREE_A].memwalAccountId, mwA);
    assert.equal(creds.trees[TREE_B].memwalAccountId, mwB);
  });

  test("resolveConfig uses the tree matching MEMFORK_TREE_ID over default", () => {
    upsertCredential(TREE_A, { privateKey: KEY, memwalAccountId: "0x" + "aa".repeat(32), memwalKey: MW_KEY });
    upsertCredential(TREE_B, { privateKey: KEY, memwalAccountId: "0x" + "bb".repeat(32), memwalKey: MW_KEY });

    process.env["MEMFORK_TREE_ID"] = TREE_B;

    const cfg = resolveConfig();
    assert.equal(cfg.treeId, TREE_B);
    assert.equal(cfg.memwalAccountId, "0x" + "bb".repeat(32));
  });
});
