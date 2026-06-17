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
import { createRequire } from "node:module";
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
import { cmdInit }     from "./commands/init.js";
import { cmdDoctor, cmdDoctorEnv } from "./commands/doctor.js";
import { cmdInstall }  from "./commands/install.js";
import {
  cmdStatus,
  cmdLog,
  cmdRecall,
  cmdCommit,
  cmdMerge,
  cmdProposals,
  cmdResolverCreate,
  cmdPrComment,
  cmdUi,
  cmdShow,
  cmdDiff,
  cmdDelegates,
  cmdGrant,
  cmdGrantMemwal,
  cmdRevoke,
  cmdBranch,
  cmdCheckout,
} from "./commands/ops.js";
import { cmdJoin } from "./commands/join.js";

const program = new Command();

program
  .name("memfork")
  .description("MemForks CLI — on-chain, branch-aware agent memory")
  .version(version);

// ─── Setup ────────────────────────────────────────────────────────────────────

program
  .command("init")
  .description("interactive first-run setup — create or link a memory tree")
  .option("-q, --quick", "auto-provision: keygen → faucet → MemWal account → tree (no copy-paste needed)")
  .action(wrap((opts: { quick?: boolean }) => cmdInit({ quick: opts.quick })));

program
  .command("doctor")
  .description("verify config, credentials, Sui connection, and MemWal")
  .option("--env", "print MEMFORK_* env vars ready to paste into .env.local")
  .action(wrap((opts: { env?: boolean }) => opts.env ? cmdDoctorEnv() : cmdDoctor()));

program
  .command("join")
  .description("onboard to an existing tree (team member setup)")
  .action(wrap(cmdJoin));

program
  .command("install <target>")
  .description("install an IDE plugin: cursor | codex")
  .action((target: string) => cmdInstall(target));

// ─── Operations ───────────────────────────────────────────────────────────────

program
  .command("branch <name>")
  .description("create a new branch from the current (or specified) branch")
  .option("-f, --from <branch>", "source branch (default: current branch)")
  .action(wrap((name: string, opts: { from?: string }) => cmdBranch(name, opts)));

program
  .command("checkout <name>")
  .description("switch the active branch")
  .action(wrap((name: string) => cmdCheckout(name)));

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
  .description("merge memory from one branch into another")
  .option("-r, --resolver <id>", "ResolverRef object ID — enables governed jury merge (or set MEMFORK_RESOLVER_ID)")
  .option("--lww",               "force LastWriteWins even when MEMFORK_RESOLVER_ID is set")
  .option("--ttl <ms>",          "proposal TTL in milliseconds", parseInt, 86_400_000)
  .action(wrap((from: string, into: string, opts: { resolver?: string; lww?: boolean; ttl?: number }) =>
    cmdMerge(from, into, opts),
  ));

program
  .command("proposals")
  .description("list open merge proposals")
  .action(wrap(cmdProposals));

const resolverCmd = new Command("resolver").description("manage resolver objects");
resolverCmd
  .command("create")
  .description("create a jury resolver (k-of-n)")
  .requiredOption("--jury <addresses>", "comma-separated judge Sui addresses")
  .option("-k, --k <n>",                "approval threshold (default: majority)", parseInt)
  .action(wrap((opts: { jury: string; k?: number }) => cmdResolverCreate({ jury: opts.jury, k: opts.k ?? 2 })));
program.addCommand(resolverCmd);

program
  .command("pr-comment")
  .description("post a MemForks decision summary to a GitHub PR")
  .requiredOption("--pr <number>", "PR number", parseInt)
  .option("--repo <owner/repo>",  "GitHub repo (default: inferred from git remote)")
  .option("--branch <name>",      "branch to recall decided fact from (default: into_branch of last merge)")
  .action(wrap((opts: { pr: number; repo?: string; branch?: string }) => cmdPrComment(opts)));

program
  .command("ui")
  .description("open the MemForks DAG visualizer")
  .option("--share",       "build and publish to a Walrus Site (shareable URL)")
  .option("-p, --port <n>","local server port", (v) => parseInt(v, 10), 4242)
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
  .command("grant-memwal <address>")
  .description("register a team member's MemWal key (run by the owner after `memfork join`)")
  .requiredOption("--pubkey <hex>", "MemWal delegate public key (hex) — printed by `memfork join`")
  .action(wrap((address: string, opts: { pubkey: string }) =>
    cmdGrantMemwal({ agent: address, pubkey: opts.pubkey }),
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
