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

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mf-cursor-test-"));
    // Create a fake .git so it's treated as a project root
    fs.mkdirSync(path.join(tmpDir, ".git"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("installs rule and hooks into .cursor/", () => {
    execSync(`node "${CLI_BIN}" install cursor`, {
      cwd: tmpDir,
      encoding: "utf8",
      timeout: 10_000,
    });

    assert.ok(fs.existsSync(path.join(tmpDir, ".cursor", "rules", "memforks.mdc")));
    assert.ok(fs.existsSync(path.join(tmpDir, ".cursor", "hooks.json")));
    assert.ok(fs.existsSync(path.join(tmpDir, ".cursor", "hooks", "memforks-session-start.sh")));
    assert.ok(fs.existsSync(path.join(tmpDir, ".cursor", "hooks", "memforks-stop.sh")));
  });

  test("hooks.json is valid JSON", () => {
    execSync(`node "${CLI_BIN}" install cursor`, { cwd: tmpDir, encoding: "utf8" });
    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".cursor", "hooks.json"), "utf8"),
    );
    assert.equal(hooksJson.version, 1);
    assert.ok(hooksJson.hooks.sessionStart);
    assert.ok(hooksJson.hooks.stop);
  });

  test("install is idempotent — no duplicate hook entries", () => {
    execSync(`node "${CLI_BIN}" install cursor`, { cwd: tmpDir, encoding: "utf8" });
    execSync(`node "${CLI_BIN}" install cursor`, { cwd: tmpDir, encoding: "utf8" });
    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(tmpDir, ".cursor", "hooks.json"), "utf8"),
    );
    // Each event should have exactly one entry after two installs
    assert.equal(hooksJson.hooks.sessionStart.length, 1);
    assert.equal(hooksJson.hooks.stop.length, 1);
  });

  test("hook scripts are executable", () => {
    execSync(`node "${CLI_BIN}" install cursor`, { cwd: tmpDir, encoding: "utf8" });
    for (const script of ["memforks-session-start.sh", "memforks-stop.sh"]) {
      const p = path.join(tmpDir, ".cursor", "hooks", script);
      const mode = fs.statSync(p).mode & 0o111;
      assert.ok(mode !== 0, `${script} should be executable`);
    }
  });
});
