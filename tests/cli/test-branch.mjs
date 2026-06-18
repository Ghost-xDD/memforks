/**
 * Tests for the unified branch resolver (packages/cli/src/branch.ts).
 *
 * Two layers:
 *   1. pickBranch()    — pure precedence logic, exhaustively tested, no I/O
 *   2. gitBranch()     — real `git rev-parse` against temp repos (incl. detached HEAD)
 *   3. resolveBranch() — the full chain, exercising MEMFORK_BRANCH + git + config
 *
 * Precedence (highest wins): explicit → MEMFORK_BRANCH → git → configDefault → "main"
 *
 * Run: node --test test-branch.mjs
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { pickBranch, gitBranch, resolveBranch } = await import("@memfork/cli");

// ─── pickBranch — pure precedence ─────────────────────────────────────────────

describe("pickBranch — precedence", () => {
  test("explicit wins over everything", () => {
    assert.equal(
      pickBranch({ explicit: "feat/a", env: "env-b", git: "git-c", configDefault: "cfg-d" }),
      "feat/a",
    );
  });

  test("env wins when no explicit", () => {
    assert.equal(
      pickBranch({ env: "env-b", git: "git-c", configDefault: "cfg-d" }),
      "env-b",
    );
  });

  test("git wins when no explicit or env", () => {
    assert.equal(
      pickBranch({ git: "git-c", configDefault: "cfg-d" }),
      "git-c",
    );
  });

  test("configDefault wins when only it and nothing higher", () => {
    assert.equal(pickBranch({ configDefault: "cfg-d" }), "cfg-d");
  });

  test("falls back to 'main' when all sources absent", () => {
    assert.equal(pickBranch({}), "main");
  });

  test("falls back to 'main' when all sources are undefined", () => {
    assert.equal(
      pickBranch({ explicit: undefined, env: undefined, git: undefined, configDefault: undefined }),
      "main",
    );
  });
});

describe("pickBranch — blank handling", () => {
  test("empty-string explicit is treated as absent, falls to env", () => {
    assert.equal(pickBranch({ explicit: "", env: "env-b" }), "env-b");
  });

  test("whitespace-only explicit is treated as absent", () => {
    assert.equal(pickBranch({ explicit: "   ", git: "git-c" }), "git-c");
  });

  test("whitespace-only git falls through to configDefault", () => {
    assert.equal(pickBranch({ git: "  ", configDefault: "cfg-d" }), "cfg-d");
  });

  test("all-blank sources fall back to 'main'", () => {
    assert.equal(pickBranch({ explicit: "", env: "  ", git: "", configDefault: "   " }), "main");
  });

  test("trims surrounding whitespace on the winning value", () => {
    assert.equal(pickBranch({ explicit: "  feat/a  " }), "feat/a");
  });
});

describe("pickBranch — branch names with slashes", () => {
  test("preserves slashes in topology names", () => {
    assert.equal(pickBranch({ explicit: "strategy/momentum" }), "strategy/momentum");
    assert.equal(pickBranch({ git: "dev/redis-first" }), "dev/redis-first");
  });
});

// ─── gitBranch — real repos ───────────────────────────────────────────────────

describe("gitBranch — real git repositories", () => {
  let tmp;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mf-gitbranch-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function git(args) {
    execSync(`git ${args}`, {
      cwd: tmp,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.t",
      },
    });
  }

  function seedRepo() {
    git("init -q");
    git("checkout -b main");
    fs.writeFileSync(path.join(tmp, "f.txt"), "x");
    git("add -A");
    git("commit -q -m init");
  }

  test("returns the checked-out branch name", () => {
    seedRepo();
    assert.equal(gitBranch(tmp), "main");
  });

  test("reflects a branch switch", () => {
    seedRepo();
    git("checkout -q -b feat/auth");
    assert.equal(gitBranch(tmp), "feat/auth");
  });

  test("returns undefined when not in a git repo", () => {
    // tmp has no .git
    assert.equal(gitBranch(tmp), undefined);
  });

  test("returns undefined on detached HEAD (guards against literal 'HEAD')", () => {
    seedRepo();
    fs.writeFileSync(path.join(tmp, "f.txt"), "y");
    git("commit -q -am second");
    // Detach onto the current commit SHA
    const sha = execSync("git rev-parse HEAD", { cwd: tmp, encoding: "utf8" }).trim();
    git(`checkout -q ${sha}`);
    assert.equal(gitBranch(tmp), undefined, "detached HEAD must not resolve to 'HEAD'");
  });
});

// ─── resolveBranch — full chain ───────────────────────────────────────────────

describe("resolveBranch — full chain", () => {
  let tmp;
  let origCwd;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mf-resolve-"));
    origCwd = process.cwd();
    delete process.env["MEMFORK_BRANCH"];
  });

  afterEach(() => {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env["MEMFORK_BRANCH"];
  });

  function git(args) {
    execSync(`git ${args}`, {
      cwd: tmp,
      stdio: ["ignore", "ignore", "ignore"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t.t",
        GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t.t",
      },
    });
  }

  function seedRepo(branch) {
    git("init -q");
    git(`checkout -b ${branch}`);
    fs.writeFileSync(path.join(tmp, "f.txt"), "x");
    git("add -A");
    git("commit -q -m init");
  }

  test("explicit flag beats git branch", () => {
    seedRepo("feat/from-git");
    const out = resolveBranch({ explicit: "feat/explicit", configDefault: "main", cwd: tmp });
    assert.equal(out, "feat/explicit");
  });

  test("MEMFORK_BRANCH beats git branch when no explicit flag", () => {
    seedRepo("feat/from-git");
    process.env["MEMFORK_BRANCH"] = "feat/from-env";
    const out = resolveBranch({ configDefault: "main", cwd: tmp });
    assert.equal(out, "feat/from-env");
  });

  test("git branch is used when no explicit and no env", () => {
    seedRepo("feat/from-git");
    const out = resolveBranch({ configDefault: "main", cwd: tmp });
    assert.equal(out, "feat/from-git");
  });

  test("configDefault is used when not in a git repo", () => {
    // tmp has no .git, no env, no explicit
    const out = resolveBranch({ configDefault: "develop", cwd: tmp });
    assert.equal(out, "develop");
  });

  test("falls back to 'main' with no git, no env, no config", () => {
    const out = resolveBranch({ cwd: tmp });
    assert.equal(out, "main");
  });

  test("explicit flag still wins outside a git repo", () => {
    const out = resolveBranch({ explicit: "feat/x", configDefault: "develop", cwd: tmp });
    assert.equal(out, "feat/x");
  });

  test("detached HEAD falls through to configDefault", () => {
    seedRepo("main");
    fs.writeFileSync(path.join(tmp, "f.txt"), "y");
    git("commit -q -am second");
    const sha = execSync("git rev-parse HEAD", { cwd: tmp, encoding: "utf8" }).trim();
    git(`checkout -q ${sha}`);
    const out = resolveBranch({ configDefault: "develop", cwd: tmp });
    assert.equal(out, "develop");
  });
});
