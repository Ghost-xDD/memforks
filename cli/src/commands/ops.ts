/**
 * Operational commands: status, log, recall, commit, merge, proposals.
 * All resolve config via the layered config system — no env vars needed.
 */

import chalk from "chalk";
import { resolveConfig, toClientConfig } from "../config.js";
import { MemForksClient } from "@memfork/core";

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function getClient(): Promise<{ client: MemForksClient; cfg: ReturnType<typeof resolveConfig> }> {
  const cfg = resolveConfig();
  const client = await MemForksClient.connect(toClientConfig(cfg));
  return { client, cfg };
}

function currentGitBranch(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    return execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "main";
  }
}

// ─── status ───────────────────────────────────────────────────────────────────

export async function cmdStatus(): Promise<void> {
  const { client, cfg } = await getClient();
  const tree = await client.getTree() as unknown as Record<string, unknown>;

  console.log("");
  console.log(chalk.bold("MemForks status"));
  console.log("");
  console.log(`  Tree      ${chalk.cyan(cfg.treeId)}`);
  console.log(`  Network   ${cfg.network}`);
  console.log(`  Branch    ${chalk.green(String(tree["default_branch"] ?? cfg.defaultBranch))}`);
  console.log(`  Signer    ${client.keypair.toSuiAddress()}`);
  console.log("");
}

// ─── log ──────────────────────────────────────────────────────────────────────

export async function cmdLog(opts: { branch?: string; limit?: number }): Promise<void> {
  const { client, cfg } = await getClient();
  const branch = opts.branch ?? currentGitBranch();

  console.log("");
  console.log(`${chalk.bold("memfork log")} ${chalk.dim("branch:")} ${chalk.green(branch)}`);
  console.log("");

  try {
    const head = await client.getBranchHead(branch);
    let commitId: string | null = head;
    let count = 0;
    const limit = opts.limit ?? 20;

    while (commitId && count < limit) {
      const commit = await client.getCommit(commitId) as unknown as Record<string, unknown>;
      const ts = new Date(Number(commit["timestamp_ms"]) ?? 0).toISOString();
      const msg = String(commit["message"] ?? "");
      const author = String(commit["author"] ?? "").slice(0, 10) + "…";
      const blob = String(commit["memwal_blob_id"] ?? "").slice(0, 8) + "…";

      console.log(
        `  ${chalk.yellow(commitId.slice(0, 10) + "…")}  ` +
        chalk.dim(ts.slice(0, 16).replace("T", " ")) + "  " +
        chalk.green(author) + "  " +
        chalk.white(msg.slice(0, 60)) +
        chalk.dim("  blob:" + blob),
      );

      const parents = (commit["parent_ids"] as string[] | undefined) ?? [];
      commitId = parents[0] ?? null;
      count++;
    }
  } catch (e) {
    console.log(chalk.dim(`  No commits yet on branch "${branch}"`));
  }
  console.log("");
}

// ─── recall ───────────────────────────────────────────────────────────────────

export async function cmdRecall(
  query: string,
  opts: { branch?: string; limit?: number; json?: boolean },
): Promise<void> {
  const { client, cfg } = await getClient();
  const branch = opts.branch ?? currentGitBranch();

  const results = await client.recall(query, { branch, limit: opts.limit ?? 5 });

  if (opts.json) {
    console.log(JSON.stringify(results));
    return;
  }

  console.log("");
  if (results.length === 0) {
    console.log(chalk.dim(`  No results for "${query}" on branch ${branch}`));
  } else {
    console.log(`${chalk.bold("recall")} ${chalk.dim('"' + query + '"')}  ${chalk.dim("branch:")} ${chalk.green(branch)}`);
    console.log("");
    for (const r of results) {
      const bar = r.distance < 0.2 ? chalk.green("███") :
                  r.distance < 0.35 ? chalk.yellow("██░") : chalk.dim("█░░");
      console.log(`  ${bar}  ${chalk.dim(r.distance.toFixed(3))}  ${r.text}`);
    }
  }
  console.log("");
}

// ─── commit ───────────────────────────────────────────────────────────────────

export async function cmdCommit(opts: {
  branch?: string;
  message: string;
  facts?: string[];
  fromResponse?: string;
  autoExtract?: boolean;
}): Promise<void> {
  const { client, cfg } = await getClient();
  const branch = opts.branch ?? currentGitBranch();

  let facts = opts.facts ?? [];

  // --from-response + --auto-extract: stub for LLM extraction
  // In production this calls the configured LLM to distil durable facts.
  if (opts.fromResponse && opts.autoExtract) {
    facts = extractFacts(opts.fromResponse);
  } else if (opts.fromResponse) {
    facts = [opts.fromResponse];
  }

  if (facts.length === 0) {
    console.error(chalk.red("No facts to commit. Pass --facts or --from-response."));
    process.exit(1);
  }

  const { digest, blobId } = await client.commit(branch, { facts, message: opts.message });

  const out = { digest, blobId, branch };
  if (process.stdout.isTTY) {
    console.log("");
    console.log(chalk.green("✓") + " Committed to " + chalk.bold(branch));
    console.log(chalk.dim(`  tx:   ${digest}`));
    console.log(chalk.dim(`  blob: ${blobId}`));
    console.log("");
  } else {
    console.log(JSON.stringify(out));
  }
}

// ─── merge ────────────────────────────────────────────────────────────────────

export async function cmdMerge(
  from: string,
  into: string,
  opts: { resolver: string; ttl?: number },
): Promise<void> {
  const { client } = await getClient();

  process.stdout.write(
    chalk.dim(`Proposing merge ${chalk.green(from)} → ${chalk.green(into)} …  `),
  );
  const digest = await client.proposeMerge({
    fromBranch: from,
    intoBranch:  into,
    resolverId:  opts.resolver,
    ttlMs:       opts.ttl ?? 86_400_000,
  });
  console.log(chalk.green("done"));
  console.log("");
  console.log(chalk.dim(`  tx: ${digest}`));
  console.log("");
  console.log(chalk.dim("The resolver runtime will handle attestation and finalization automatically."));
  console.log(chalk.dim("Use `memfork proposals` to monitor progress."));
  console.log("");
}

// ─── proposals ────────────────────────────────────────────────────────────────

export async function cmdProposals(): Promise<void> {
  const { client, cfg } = await getClient();

  // Fetch open MergeProposed events from the indexer.
  // For now this polls recent events (the indexer / app/ maintains the live view).
  console.log("");
  console.log(chalk.bold("Open merge proposals"));
  console.log(chalk.dim("  (live status in the visualizer: memfork ui)"));
  console.log("");
  console.log(chalk.dim("  Tree: " + cfg.treeId));
  console.log("");
  console.log(chalk.dim("  Polling Sui events…"));
  // TODO: drive through MemForksIndexer once it's wired into the CLI.
  // For the hackathon: redirect to the visualizer.
  console.log("");
  console.log(chalk.cyan("  →") + " Run " + chalk.bold("memfork ui") + " for the full live proposal view.");
  console.log("");
}

// ─── ui ───────────────────────────────────────────────────────────────────────

export async function cmdUi(): Promise<void> {
  const { execSync } = await import("node:child_process") as typeof import("node:child_process");
  const { readProjectConfig } = await import("../config.js");
  const project = readProjectConfig();
  const appDir = findAppDir();

  if (!appDir) {
    console.log(chalk.yellow("Could not find the MemForks app directory."));
    console.log("Start it manually: cd app && npm run dev");
    return;
  }

  console.log(chalk.dim("Starting MemForks visualizer at http://localhost:4242 …"));
  try {
    execSync("npm run dev", { cwd: appDir, stdio: "inherit" });
  } catch {
    console.log("App exited.");
  }
}

// ─── Fact extraction stub ─────────────────────────────────────────────────────
// Production implementation: calls the configured LLM with a system prompt that
// extracts durable facts from the turn response. Stub version pulls sentences.

function extractFacts(response: string): string[] {
  return response
    .split(/[.!?\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 30 && s.length < 500);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findAppDir(): string | null {
  const candidates = [
    new URL("../../../app", import.meta.url).pathname,
    new URL("../../../../app", import.meta.url).pathname,
  ];
  for (const c of candidates) {
    try {
      if ((await import("node:fs")).default.existsSync(c + "/package.json")) return c;
    } catch { continue; }
  }
  return null;
}
