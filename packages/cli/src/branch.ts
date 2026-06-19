/**
 * Branch resolution for CLI commands.
 *
 * Memory in MemForks is namespaced per branch. Every CLI command needs to
 * answer the same question — "which branch am I operating on?" — and they must
 * all answer it the same way. This module is the single source of that answer.
 *
 * Precedence (highest wins):
 *   1. explicit  — the `--branch` / `--from` flag passed on the command line
 *   2. env       — MEMFORK_BRANCH (CI / headless override)
 *   3. git       — the current git branch (the dynamic default for humans)
 *   4. config    — `defaultBranch` from .memfork/config.json (non-git fallback)
 *   5. "main"    — last resort
 *
 * IMPORTANT: this lives in the CLI layer ONLY. The core MemForksClient and the
 * framework adapters (@memfork/langgraph, @memfork/vercel-ai) take an explicit
 * `branch` argument and have no git awareness. Keeping git resolution out of
 * the core guarantees those integrations are unaffected by this logic.
 */

import { execSync } from "node:child_process";
import chalk from "chalk";

/**
 * Read the current git branch, or undefined when there is no usable answer.
 *
 * Returns undefined when:
 *   - not inside a git repo (command fails)
 *   - detached HEAD / mid-rebase / mid-bisect (returns the literal "HEAD")
 *
 * In those cases the caller falls through to the next precedence source rather
 * than writing memory into a bogus namespace literally named "HEAD".
 */
export function gitBranch(cwd: string = process.cwd()): string | undefined {
  try {
    const out = execSync("git rev-parse --abbrev-ref HEAD", {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out || out === "HEAD") return undefined;
    return out;
  } catch {
    return undefined;
  }
}

export interface BranchSources {
  /** --branch / --from flag (highest priority). */
  explicit?: string;
  /** MEMFORK_BRANCH env var. */
  env?: string;
  /** Current git branch (already guarded against detached HEAD). */
  git?: string;
  /** defaultBranch from project config (non-git fallback). */
  configDefault?: string;
}

/**
 * Pure precedence resolver — no I/O. Exposed separately so the precedence
 * rules can be unit-tested exhaustively without a git repo or env mutation.
 *
 * A whitespace-only source is treated as absent.
 */
export function pickBranch(sources: BranchSources): string {
  const clean = (s: string | undefined): string | undefined => {
    const t = s?.trim();
    return t ? t : undefined;
  };
  return (
    clean(sources.explicit) ??
    clean(sources.env) ??
    clean(sources.git) ??
    clean(sources.configDefault) ??
    "main"
  );
}

/**
 * Resolve the branch a command should operate on, applying the full
 * precedence chain (reads MEMFORK_BRANCH and the current git branch).
 *
 * Prints a warning when no git branch is detected and no fallback is
 * configured — the caller will operate on "main" which may be unintended.
 */
export function resolveBranch(opts: {
  explicit?: string;
  configDefault?: string;
  cwd?: string;
  silent?: boolean;
} = {}): string {
  const git = gitBranch(opts.cwd);
  const branch = pickBranch({
    explicit: opts.explicit,
    env: process.env["MEMFORK_BRANCH"],
    git,
    configDefault: opts.configDefault,
  });

  // Warn when we fell all the way through to "main" because there is no git
  // repo and no other source — this is almost always unintended.
  if (
    !opts.silent &&
    branch === "main" &&
    !opts.explicit &&
    !process.env["MEMFORK_BRANCH"] &&
    !git &&
    !opts.configDefault
  ) {
    process.stderr.write(
      chalk.yellow("⚠") +
      " No git branch detected — committing to " +
      chalk.bold("main") +
      ". Run " +
      chalk.dim("git init && git checkout -b <branch>") +
      " to use branch-scoped memory.\n",
    );
  }

  return branch;
}
