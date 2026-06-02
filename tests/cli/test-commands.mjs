/**
 * Integration tests for CLI commands — mocks MemForksClient so no network needed.
 * Uses Node's built-in test runner: `node --test test-commands.mjs`
 */

import { test, describe, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN   = path.resolve(__dirname, "../../cli/dist/cli.js");

// Run the CLI binary as a subprocess and return { stdout, stderr, code }.
function runCli(args, env = {}) {
  try {
    const stdout = execSync(`node "${CLI_BIN}" ${args}`, {
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 10_000,
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code:   e.status ?? 1,
    };
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("memfork --version", () => {
  test("prints version", () => {
    const { stdout, code } = runCli("--version");
    assert.equal(code, 0);
    assert.match(stdout, /0\.1\.0/);
  });
});

describe("memfork --help", () => {
  test("lists all commands", () => {
    const { stdout, code } = runCli("--help");
    assert.equal(code, 0);
    for (const cmd of ["init", "doctor", "install", "status", "log", "recall", "commit", "merge", "proposals", "ui"]) {
      assert.ok(stdout.includes(cmd), `missing command: ${cmd}`);
    }
  });
});

describe("memfork status (no config)", () => {
  test("exits with ConfigError message", () => {
    const { code, stderr, stdout } = runCli("status", {
      HOME: os.tmpdir(),                 // no credentials in temp home
      MEMFORK_TREE_ID: "",               // clear any inherited env
      MEMFORK_PRIVATE_KEY: "",
    });
    assert.notEqual(code, 0);
    const combined = stdout + stderr;
    assert.ok(
      combined.includes("memfork init") || combined.includes("No MemoryTree"),
      `expected init hint, got: ${combined.slice(0, 200)}`,
    );
  });
});

describe("memfork install cursor", () => {
  let tmpDir;
  let fakeMcpJson;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-cursor-test-"));
    fs.mkdirSync(path.join(tmpDir, ".git"));

    // Provide a fake ~/.cursor/mcp.json location via env so we don't
    // touch the real user config. We intercept by pointing HOME at tmpDir.
    fakeMcpJson = path.join(tmpDir, "home", ".cursor", "mcp.json");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("installs the Cursor rule (.cursor/rules/memforks.mdc)", () => {
    execSync(`node "${CLI_BIN}" install cursor`, {
      cwd:      tmpDir,
      encoding: "utf8",
      timeout:  10_000,
      env: { ...process.env, HOME: path.join(tmpDir, "home") },
    });

    assert.ok(
      fs.existsSync(path.join(tmpDir, ".cursor", "rules", "memforks.mdc")),
      "rule file should be installed",
    );
  });

  test("install is idempotent — running twice is safe", () => {
    const env = { ...process.env, HOME: path.join(tmpDir, "home") };
    execSync(`node "${CLI_BIN}" install cursor`, { cwd: tmpDir, encoding: "utf8", env });
    execSync(`node "${CLI_BIN}" install cursor`, { cwd: tmpDir, encoding: "utf8", env });

    // Rule should still be present and valid after two runs.
    const rule = fs.readFileSync(
      path.join(tmpDir, ".cursor", "rules", "memforks.mdc"),
      "utf8",
    );
    assert.ok(rule.includes("memwal_recall"), "rule should reference memwal_recall");
    assert.ok(rule.includes("memfork commit"), "rule should reference memfork commit");
  });

  test("mcp.json is written with memwal entry when credentials exist", () => {
    // Seed a fake project config + credentials so resolveMcpCreds() returns data.
    const memforkDir = path.join(tmpDir, ".memfork");
    fs.mkdirSync(memforkDir, { recursive: true });
    const treeId = "0x" + "a".repeat(64);
    fs.writeFileSync(
      path.join(memforkDir, "config.json"),
      JSON.stringify({ treeId, network: "testnet" }),
      "utf8",
    );

    const credsDir = path.join(tmpDir, "home", ".memfork");
    fs.mkdirSync(credsDir, { recursive: true });
    const credsFile = path.join(credsDir, "credentials.json");
    fs.writeFileSync(
      credsFile,
      JSON.stringify({
        default: treeId,
        trees: {
          [treeId]: {
            privateKey:      "suiprivkey1test",
            memwalAccountId: "0x" + "b".repeat(64),
            memwalKey:       "c".repeat(64),
          },
        },
      }),
      "utf8",
    );
    fs.chmodSync(credsFile, 0o600);

    execSync(`node "${CLI_BIN}" install cursor`, {
      cwd:     tmpDir,
      encoding: "utf8",
      timeout:  10_000,
      env: { ...process.env, HOME: path.join(tmpDir, "home") },
    });

    const mcpJsonPath = path.join(tmpDir, "home", ".cursor", "mcp.json");
    assert.ok(fs.existsSync(mcpJsonPath), "mcp.json should be created");

    const mcpJson = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"));
    assert.ok(mcpJson.mcpServers?.memwal, "mcpServers.memwal entry should exist");
    assert.ok(mcpJson.mcpServers.memwal.url?.includes("/api/mcp"), "url should include /api/mcp");
    assert.ok(
      mcpJson.mcpServers.memwal.headers?.["Authorization"]?.startsWith("Bearer "),
      "Authorization header should be Bearer token",
    );
    assert.ok(
      mcpJson.mcpServers.memwal.headers?.["x-memwal-account-id"],
      "x-memwal-account-id header should be set",
    );
  });
});
