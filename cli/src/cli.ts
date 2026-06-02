#!/usr/bin/env node
/**
 * @memfork/cli — entry point
 *
 * Usage:
 *   memfork init                          — first-run interactive setup
 *   memfork doctor                        — verify the full setup
 *   memfork install cursor|codex          — install IDE plugin
 *
 *   memfork status                        — tree status
 *   memfork log [--branch <b>] [-n <n>]   — commit log
 *   memfork recall <query> [--branch <b>] — semantic recall
 *   memfork commit -m <msg> --facts <...> — write facts on-chain
 *   memfork merge <from> <into> --resolver <id>  — propose merge
 *   memfork proposals                     — list open proposals
 *   memfork ui                            — open DAG visualizer
 *
 * Config API re-exported for use by other packages:
 *   import { resolveConfig, toClientConfig } from "@memfork/cli"
 */

import { Command } from "commander";
import chalk from "chalk";
import { cmdInit }     from "./commands/init.js";
import { cmdDoctor }   from "./commands/doctor.js";
import { cmdInstall }  from "./commands/install.js";
import {
  cmdStatus,
  cmdLog,
  cmdRecall,
  cmdCommit,
  cmdMerge,
  cmdProposals,
  cmdUi,
  cmdShow,
  cmdDiff,
  cmdDelegates,
  cmdGrant,
  cmdRevoke,
} from "./commands/ops.js";

const program = new Command();

program
  .name("memfork")
  .description("MemForks CLI — on-chain, branch-aware agent memory")
  .version("0.1.0");

// ─── Setup ────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("interactive first-run setup — create or link a memory tree")
  .option("-q, --quick", "auto-provision: keygen → faucet → MemWal account → tree (no copy-paste needed)")
  .action(wrap((opts: { quick?: boolean }) => cmdInit({ quick: opts.quick })));

program
  .command("doctor")
  .description("verify config, credentials, Sui connection, and MemWal")
  .action(wrap(cmdDoctor));

program
  .command("install <target>")
  .description("install an IDE plugin: cursor | codex")
  .action((target: string) => cmdInstall(target));

// ─── Operations ───────────────────────────────────────────────────────────────

program
  .command("status")
  .description("show current tree, network, branch, and signer")
  .action(wrap(cmdStatus));

program
  .command("log")
  .description("show recent commits on a branch")
  .option("-b, --branch <name>", "branch name (default: current git branch)")
  .option("-n, --limit <n>",     "number of commits", parseInt, 20)
  .action(wrap((opts: { branch?: string; limit?: number }) => cmdLog(opts)));

program
  .command("recall [query]")
  .description("semantic recall from branch memory")
  .option("-b, --branch <name>",  "branch to recall from")
  .option("-n, --limit <n>",      "max results", parseInt, 5)
  .option("--json",               "output as JSON (used by plugin hooks)")
  .action(wrap((query: string | undefined, opts: { branch?: string; limit?: number; json?: boolean }) =>
    cmdRecall(query ?? "", opts),
  ));

program
  .command("commit")
  .description("commit facts to the current branch")
  .requiredOption("-m, --message <msg>",   "commit message")
  .option("-b, --branch <name>",           "branch (default: current git branch)")
  .option("-f, --facts <facts...>",        "one or more fact strings")
  .option("--from-response <text>",        "extract facts from a full response text")
  .option("--auto-extract",                "use LLM to extract durable facts (requires --from-response)")
  .action(wrap((opts: { message: string; branch?: string; facts?: string[]; fromResponse?: string; autoExtract?: boolean }) =>
    cmdCommit(opts),
  ));

program
  .command("merge <from> <into>")
  .description("propose a merge from one branch into another")
  .requiredOption("-r, --resolver <id>", "ResolverRef object ID")
  .option("--ttl <ms>",                  "TTL in milliseconds", parseInt, 86_400_000)
  .action(wrap((from: string, into: string, opts: { resolver: string; ttl?: number }) =>
    cmdMerge(from, into, opts),
  ));

program
  .command("proposals")
  .description("list open merge proposals")
  .action(wrap(cmdProposals));

program
  .command("ui")
  .description("open the MemForks DAG visualizer")
  .option("--share",       "build and publish to a Walrus Site (shareable URL)")
  .option("-p, --port <n>","local server port", parseInt, 4242)
  .action(wrap((opts: { share?: boolean; port?: number }) => cmdUi(opts)));

program
  .command("show <commitId>")
  .description("show details of a single commit")
  .action(wrap((commitId: string) => cmdShow(commitId)));

program
  .command("diff <from> <to>")
  .description("show fact differences between two branches or commits")
  .action(wrap((from: string, to: string) => cmdDiff(from, to)));

// ─── ACL ─────────────────────────────────────────────────────────────────────

program
  .command("delegates")
  .description("list all delegates for the current tree")
  .action(wrap(cmdDelegates));

program
  .command("grant <address>")
  .description("grant a delegate key write access to the tree")
  .option("-p, --permissions <hex>", "permission bitmask in hex (default: 0xFF = all)", "0xFF")
  .option("--expiry <ms>",           "expiry timestamp in epoch ms (default: never)", parseInt)
  .option("-b, --branches <names...>", "restrict to specific branches")
  .action(wrap((address: string, opts: { permissions?: string; expiry?: number; branches?: string[] }) =>
    cmdGrant({ address, ...opts }),
  ));

program
  .command("revoke <address>")
  .description("revoke a delegate key")
  .action(wrap((address: string) => cmdRevoke(address)));

// ─── Error handling ───────────────────────────────────────────────────────────

program.configureOutput({
  writeErr: (str) => process.stderr.write(chalk.red(str)),
});

program.parseAsync(process.argv).catch((e) => {
  console.error(chalk.red("Error: " + String(e)));
  process.exit(1);
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function wrap<T extends unknown[]>(fn: (...args: T) => Promise<void>) {
  return (...args: T) => {
    fn(...args).catch((e: unknown) => {
      if ((e as { name?: string }).name === "ConfigError") {
        console.error(chalk.red("\n  " + String((e as Error).message)));
        console.error(chalk.cyan("  → Run `memfork init` to configure.\n"));
      } else {
        console.error(chalk.red("\nError: " + String(e)));
      }
      process.exit(1);
    });
  };
}
