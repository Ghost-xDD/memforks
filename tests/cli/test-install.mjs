/**
 * Tests for `memfork install cursor` and `memfork install codex`.
 *
 * Covers the scenarios not tested in test-commands.mjs:
 *
 * Cursor:
 *   - mcp.json merges with an existing file — unrelated servers are preserved
 *   - mcp.json created when ~/.cursor/ does not yet exist
 *   - install works in a non-git directory (no crash, rule still written)
 *   - install without credentials skips mcp.json and prints a warning
 *   - mcp.json memwal entry is updated (not duplicated) on a second install
 *
 * Codex:
 *   - .codex-plugin/ directory is created
 *   - .codex-plugin/plugin.json exists and contains valid JSON
 *   - install is idempotent (running twice is safe)
 *   - ~/.codex/config.toml is written with [mcp_servers.memwal] when credentials exist
 *   - a second install REPLACES the existing [mcp_servers.memwal] block in config.toml
 *     (no duplication)
 *   - install without credentials skips config.toml and still installs the plugin
 *
 * No network, no MemWal, no Sui.
 *
 * Run: node --test test-install.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_BIN   = path.resolve(__dirname, "../../packages/cli/dist/cli.js");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function run(args, env = {}, cwd = undefined) {
  try {
    const stdout = execSync(`node "${CLI_BIN}" ${args}`, {
      encoding: "utf8",
      timeout:  15_000,
      cwd,
      env: { ...process.env, ...env },
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e) {
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.status ?? 1 };
  }
}

/** Seed a .memfork/ project config + credentials so resolveMcpCreds() returns data. */
function seedCredentials(projectDir, fakeHome) {
  const TREE_ID = "0x" + "a".repeat(64);

  // Project config
  fs.mkdirSync(path.join(projectDir, ".memfork"), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".memfork", "config.json"),
    JSON.stringify({ treeId: TREE_ID, network: "testnet" }),
    "utf8",
  );

  // Credentials
  fs.mkdirSync(path.join(fakeHome, ".memfork"), { recursive: true });
  const credsPath = path.join(fakeHome, ".memfork", "credentials.json");
  fs.writeFileSync(
    credsPath,
    JSON.stringify({
      default: TREE_ID,
      trees: {
        [TREE_ID]: {
          privateKey:      "suiprivkey1test",
          memwalAccountId: "0x" + "b".repeat(64),
          memwalKey:       "c".repeat(64),
        },
      },
    }),
    "utf8",
  );
  fs.chmodSync(credsPath, 0o600);

  return TREE_ID;
}

// ─── Setup / teardown ─────────────────────────────────────────────────────────

let tmpProject;
let tmpHome;

beforeEach(() => {
  tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "mf-install-test-"));
  tmpHome    = fs.mkdtempSync(path.join(os.tmpdir(), "mf-install-home-"));
  fs.mkdirSync(path.join(tmpProject, ".git"));
});

afterEach(() => {
  fs.rmSync(tmpProject, { recursive: true, force: true });
  fs.rmSync(tmpHome,    { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CURSOR
// ═══════════════════════════════════════════════════════════════════════════════

describe("memfork install cursor — rule file", () => {
  test("installs .cursor/rules/memforks.mdc", () => {
    run("install cursor", { HOME: tmpHome }, tmpProject);
    assert.ok(
      fs.existsSync(path.join(tmpProject, ".cursor", "rules", "memforks.mdc")),
    );
  });

  test("rule contains expected recall and commit instructions", () => {
    run("install cursor", { HOME: tmpHome }, tmpProject);
    const rule = fs.readFileSync(
      path.join(tmpProject, ".cursor", "rules", "memforks.mdc"),
      "utf8",
    );
    assert.ok(rule.includes("memwal_recall"),  "rule should reference memwal_recall");
    assert.ok(rule.includes("memfork commit"), "rule should reference memfork commit");
  });

  test("install without .git does not crash — rule is still written", () => {
    const noGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-nogit-"));
    try {
      execSync(`node "${CLI_BIN}" install cursor`, {
        cwd: noGitDir,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, HOME: tmpHome },
      });
      assert.ok(
        fs.existsSync(path.join(noGitDir, ".cursor", "rules", "memforks.mdc")),
        "rule should still be installed in non-git dir",
      );
    } finally {
      fs.rmSync(noGitDir, { recursive: true, force: true });
    }
  });

  test("install is idempotent — running twice does not corrupt the rule", () => {
    const env = { ...process.env, HOME: tmpHome };
    execSync(`node "${CLI_BIN}" install cursor`, { cwd: tmpProject, encoding: "utf8", env });
    execSync(`node "${CLI_BIN}" install cursor`, { cwd: tmpProject, encoding: "utf8", env });

    const rule = fs.readFileSync(
      path.join(tmpProject, ".cursor", "rules", "memforks.mdc"),
      "utf8",
    );
    assert.ok(rule.includes("memwal_recall"));
    assert.ok(rule.includes("memfork commit"));
  });
});

describe("memfork install cursor — mcp.json", () => {
  test("creates mcp.json when ~/.cursor/ does not exist yet", () => {
    seedCredentials(tmpProject, tmpHome);
    // tmpHome starts empty — no ~/.cursor/ directory

    execSync(`node "${CLI_BIN}" install cursor`, {
      cwd: tmpProject,
      encoding: "utf8",
      env: { ...process.env, HOME: tmpHome },
    });

    assert.ok(
      fs.existsSync(path.join(tmpHome, ".cursor", "mcp.json")),
      "mcp.json should be created",
    );
  });

  test("mcp.json memwal entry has correct shape", () => {
    seedCredentials(tmpProject, tmpHome);

    execSync(`node "${CLI_BIN}" install cursor`, {
      cwd: tmpProject,
      encoding: "utf8",
      env: { ...process.env, HOME: tmpHome },
    });

    const mcp = JSON.parse(fs.readFileSync(path.join(tmpHome, ".cursor", "mcp.json"), "utf8"));
    const entry = mcp.mcpServers?.memwal;

    assert.ok(entry,                                          "mcpServers.memwal must exist");
    assert.ok(entry.url?.includes("/api/mcp"),               "url must include /api/mcp");
    assert.ok(entry.headers?.Authorization?.startsWith("Bearer "), "Authorization must be Bearer");
    assert.ok(entry.headers?.["x-memwal-account-id"],        "x-memwal-account-id must be set");
  });

  test("mcp.json merges — pre-existing unrelated servers are preserved", () => {
    seedCredentials(tmpProject, tmpHome);

    // Pre-seed an existing mcp.json with an unrelated server
    const cursorDir = path.join(tmpHome, ".cursor");
    fs.mkdirSync(cursorDir, { recursive: true });
    fs.writeFileSync(
      path.join(cursorDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          "github-copilot": { url: "https://copilot.example.com" },
        },
      }, null, 2),
      "utf8",
    );

    execSync(`node "${CLI_BIN}" install cursor`, {
      cwd: tmpProject,
      encoding: "utf8",
      env: { ...process.env, HOME: tmpHome },
    });

    const mcp = JSON.parse(fs.readFileSync(path.join(cursorDir, "mcp.json"), "utf8"));
    assert.ok(mcp.mcpServers?.["github-copilot"],  "pre-existing server should be preserved");
    assert.ok(mcp.mcpServers?.memwal,              "memwal server should be added");
  });

  test("running install twice does NOT duplicate the memwal entry", () => {
    seedCredentials(tmpProject, tmpHome);
    const env = { ...process.env, HOME: tmpHome };

    execSync(`node "${CLI_BIN}" install cursor`, { cwd: tmpProject, encoding: "utf8", env });
    execSync(`node "${CLI_BIN}" install cursor`, { cwd: tmpProject, encoding: "utf8", env });

    const raw = fs.readFileSync(path.join(tmpHome, ".cursor", "mcp.json"), "utf8");
    // "memwal" should appear exactly once as a key
    const count = (raw.match(/"memwal"/g) ?? []).length;
    assert.equal(count, 1, `"memwal" key appeared ${count} times — expected exactly 1`);
  });

  test("install without credentials skips mcp.json and exits 0", () => {
    // No project config, no credentials → resolveMcpCreds() returns null
    const { code, stdout } = run("install cursor", { HOME: tmpHome }, tmpProject);
    assert.equal(code, 0, "should exit 0 even without credentials");
    assert.ok(
      stdout.includes("memfork init") || stdout.includes("skipped"),
      "should print a hint about memfork init",
    );
    assert.ok(
      !fs.existsSync(path.join(tmpHome, ".cursor", "mcp.json")),
      "mcp.json should NOT be created when credentials are missing",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CODEX
// ═══════════════════════════════════════════════════════════════════════════════

describe("memfork install codex — plugin files", () => {
  test("creates .codex-plugin/ directory", () => {
    run("install codex", { HOME: tmpHome }, tmpProject);
    assert.ok(
      fs.existsSync(path.join(tmpProject, ".codex-plugin")),
      ".codex-plugin directory should be created",
    );
  });

  test(".codex-plugin/ contains at least a plugin.json", () => {
    run("install codex", { HOME: tmpHome }, tmpProject);

    // The source structure is plugins/codex/.codex-plugin/plugin.json,
    // so copyDir mirrors it into .codex-plugin/.codex-plugin/plugin.json.
    const pluginJson = path.join(tmpProject, ".codex-plugin", ".codex-plugin", "plugin.json");
    assert.ok(fs.existsSync(pluginJson), "plugin.json should exist");

    // plugin.json must be valid JSON
    const parsed = JSON.parse(fs.readFileSync(pluginJson, "utf8"));
    assert.ok(typeof parsed === "object" && parsed !== null, "plugin.json must be a JSON object");
  });

  test("install is idempotent — running twice is safe", () => {
    run("install codex", { HOME: tmpHome }, tmpProject);
    run("install codex", { HOME: tmpHome }, tmpProject);

    const pluginJson = path.join(tmpProject, ".codex-plugin", ".codex-plugin", "plugin.json");
    assert.ok(fs.existsSync(pluginJson), "plugin.json should still exist after two runs");
    JSON.parse(fs.readFileSync(pluginJson, "utf8")); // must still be valid JSON
  });
});

describe("memfork install codex — config.toml MCP entry", () => {
  test("writes [mcp_servers.memwal] block when credentials exist", () => {
    seedCredentials(tmpProject, tmpHome);

    execSync(`node "${CLI_BIN}" install codex`, {
      cwd: tmpProject,
      encoding: "utf8",
      env: { ...process.env, HOME: tmpHome },
    });

    const tomlPath = path.join(tmpHome, ".codex", "config.toml");
    assert.ok(fs.existsSync(tomlPath), "config.toml should be created");

    const toml = fs.readFileSync(tomlPath, "utf8");
    assert.ok(toml.includes("[mcp_servers.memwal]"), "should contain [mcp_servers.memwal] block");
    assert.ok(toml.includes("Bearer "),              "should include Bearer auth");
    assert.ok(toml.includes("/api/mcp"),             "should include relayer /api/mcp path");
  });

  test("running install twice REPLACES the existing block — no duplication", () => {
    seedCredentials(tmpProject, tmpHome);
    const env = { ...process.env, HOME: tmpHome };

    execSync(`node "${CLI_BIN}" install codex`, { cwd: tmpProject, encoding: "utf8", env });
    execSync(`node "${CLI_BIN}" install codex`, { cwd: tmpProject, encoding: "utf8", env });

    const toml = fs.readFileSync(path.join(tmpHome, ".codex", "config.toml"), "utf8");
    const count = (toml.match(/\[mcp_servers\.memwal\]/g) ?? []).length;
    assert.equal(count, 1, `[mcp_servers.memwal] appeared ${count} times — expected exactly 1`);
  });

  test("pre-existing config.toml content is preserved when adding memwal block", () => {
    seedCredentials(tmpProject, tmpHome);

    // Seed a config.toml with some other content
    const codexDir = path.join(tmpHome, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      `[model]\nname = "gpt-4o"\n`,
      "utf8",
    );

    execSync(`node "${CLI_BIN}" install codex`, {
      cwd: tmpProject,
      encoding: "utf8",
      env: { ...process.env, HOME: tmpHome },
    });

    const toml = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
    assert.ok(toml.includes('[model]'),               "pre-existing [model] section preserved");
    assert.ok(toml.includes("gpt-4o"),                "pre-existing model name preserved");
    assert.ok(toml.includes("[mcp_servers.memwal]"), "memwal section added");
  });

  test("install without credentials skips config.toml but still installs plugin", () => {
    // No project config, no credentials
    run("install codex", { HOME: tmpHome }, tmpProject);

    assert.ok(
      !fs.existsSync(path.join(tmpHome, ".codex", "config.toml")),
      "config.toml should NOT be created when credentials are missing",
    );
    assert.ok(
      fs.existsSync(path.join(tmpProject, ".codex-plugin", ".codex-plugin", "plugin.json")),
      "plugin.json should still be installed",
    );
  });
});

describe("memfork install — unknown target", () => {
  test("exits non-zero with error message for unknown target", () => {
    const { code, stderr, stdout } = run("install foobar", { HOME: tmpHome }, tmpProject);
    assert.notEqual(code, 0);
    assert.ok(
      (stdout + stderr).toLowerCase().includes("unknown") ||
      (stdout + stderr).toLowerCase().includes("foobar"),
    );
  });
});
