/**
 * Operational commands: status, log, recall, commit, merge, proposals.
 * All resolve config via the layered config system — no env vars needed.
 */

import { execSync, exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
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

  // Model A: commits are off-chain Walrus blobs. Use recall() with empty
  // query to list the most recent memories as a commit log approximation.
  try {
    const results = await client.recall("", { branch, limit: opts.limit ?? 20 });
    if (results.length === 0) {
      console.log(chalk.dim(`  No commits yet on branch "${branch}"`));
    } else {
      for (const r of results) {
        const blobShort = r.blobId.slice(0, 10) + "…";
        let preview = r.text;
        try {
          const p = JSON.parse(r.text) as Record<string, unknown>;
          const delta = p["delta"] as Record<string, unknown> | undefined;
          const facts = (delta?.["facts"] as string[] | undefined) ?? [];
          preview = facts[0] ?? r.text;
        } catch { /* not JSON */ }
        console.log(
          `  ${chalk.yellow(blobShort)}  ` +
          chalk.dim(`dist:${r.distance.toFixed(3)}`) + "  " +
          chalk.white(preview.slice(0, 80)),
        );
      }
    }
  } catch {
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

  const { blobId } = await client.commit(branch, { facts, message: opts.message });

  const out = { blobId, branch };
  if (process.stdout.isTTY) {
    console.log("");
    console.log(chalk.green("✓") + " Committed to " + chalk.bold(branch));
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

export async function cmdUi(opts: { share?: boolean; port?: number } = {}): Promise<void> {
  const appDir = findAppDir();
  if (!appDir) {
    console.log(chalk.yellow("Could not find the MemForks app directory."));
    console.log(chalk.dim("Build the app manually: cd app && npm run build"));
    return;
  }

  const distDir  = path.join(appDir, "dist");
  const indexHtml = path.join(distDir, "index.html");

  // ── Share mode: build → publish to Walrus Site ──────────────────────────
  if (opts.share) {
    console.log("");
    console.log(chalk.bold("memfork ui --share") + chalk.dim("  →  Walrus Site"));
    console.log("");
    console.log(chalk.dim("Building app for Walrus Site…"));
    execSync("npm run build", {
      cwd: appDir,
      stdio: "inherit",
      env: { ...process.env, VITE_WALRUS_MODE: "true" },
    });

    console.log("");
    console.log(chalk.dim("Publishing to Walrus…"));
    try {
      execSync(`site-builder deploy --epochs 10 ${distDir}`, { stdio: "inherit" });
    } catch {
      console.log("");
      console.log(chalk.yellow("site-builder not found."));
      console.log("");
      console.log("Install it with suiup, then run the deploy manually:");
      console.log(chalk.dim("  curl -sSfL https://raw.githubusercontent.com/Mystenlabs/suiup/main/install.sh | sh"));
      console.log(chalk.dim("  suiup install site-builder@mainnet"));
      console.log(chalk.dim(`  site-builder deploy --epochs 10 ${distDir}`));
      console.log("");
      console.log(chalk.dim("The build is ready in: " + distDir));
    }
    return;
  }

  // ── Local mode: serve pre-built bundle + /api/* routes ──────────────────
  if (!fs.existsSync(indexHtml)) {
    console.log(chalk.dim("Building app (first run — takes ~10s)…"));
    execSync("npm run build", { cwd: appDir, stdio: "inherit" });
  }

  const port = opts.port ?? 4242;

  console.log("");
  console.log(chalk.bold("MemForks") + chalk.dim("  →  starting local server…"));
  console.log("");

  const { startUiServer } = await import("./ui-server.js");
  const server = startUiServer(distDir, port);

  // Open browser after a short delay.
  setTimeout(() => {
    const url = `http://localhost:${port}`;
    const cmd =
      process.platform === "darwin" ? `open ${url}` :
      process.platform === "win32"  ? `start ${url}` :
                                      `xdg-open ${url}`;
    exec(cmd);
    console.log(chalk.dim("  Press Ctrl+C to stop."));
    console.log("");
  }, 400);

  // Block until the user presses Ctrl+C.
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      server.close(() => resolve());
      console.log(chalk.dim("\n  Server stopped."));
    });
  });
}

// ─── show ─────────────────────────────────────────────────────────────────────

/**
 * `memfork show <anchorId>` — show details of an on-chain merge anchor.
 * For off-chain commit blobs, use `memfork recall` or the UI history view.
 */
export async function cmdShow(anchorId: string): Promise<void> {
  const { client } = await getClient();

  const anchor = await client.getMergeAnchor(anchorId);
  const parents = (anchor.parents as string[] | undefined) ?? [];

  console.log("");
  console.log(chalk.bold("merge anchor ") + chalk.yellow(anchorId));
  console.log(chalk.dim("tree:           ") + chalk.dim(String(anchor.tree_id ?? "")));
  if (parents.length > 0) {
    console.log(chalk.dim("parent blobs:   ") + parents.map((p) => chalk.cyan(p.slice(0, 20) + "…")).join("  "));
  }
  console.log(chalk.dim("resolved_blob:  ") + chalk.cyan(String(anchor.resolved_blob_id ?? "")));
  console.log(chalk.dim("proposal:       ") + chalk.dim(String(anchor.proposal_id ?? "")));
  console.log("");
}

// ─── diff ─────────────────────────────────────────────────────────────────────

export async function cmdDiff(
  fromRef: string,
  toRef:   string,
): Promise<void> {
  const { client } = await getClient();

  console.log("");
  console.log(
    chalk.bold("diff") + "  " +
    chalk.green(fromRef) + chalk.dim("..") + chalk.green(toRef),
  );
  console.log("");

  // Model A: diff is based on recalled facts from each branch namespace.
  const fromBranch = fromRef;
  const toBranch   = toRef;

  if (fromBranch !== toBranch) {
    const [fromFacts, toFacts] = await Promise.all([
      client.recall("", { branch: fromBranch, limit: 50 }),
      client.recall("", { branch: toBranch,   limit: 50 }),
    ]);

    const fromKeys = new Set(fromFacts.map((f) => f.text));
    const toKeys   = new Set(toFacts.map((f) => f.text));

    const added   = toFacts.filter((f) => !fromKeys.has(f.text));
    const removed = fromFacts.filter((f) => !toKeys.has(f.text));

    if (added.length > 0) {
      console.log(chalk.green("  + Facts added in " + toBranch + ":"));
      for (const f of added) {
        console.log(chalk.green("  + ") + f.text.slice(0, 100));
      }
      console.log("");
    }
    if (removed.length > 0) {
      console.log(chalk.red("  - Facts only in " + fromBranch + ":"));
      for (const f of removed) {
        console.log(chalk.red("  - ") + f.text.slice(0, 100));
      }
      console.log("");
    }
    if (added.length === 0 && removed.length === 0) {
      console.log(chalk.dim("  No fact differences between the two branches."));
      console.log("");
    }
  } else {
    console.log(chalk.dim("  Same branch — commit-level diff not yet supported."));
    console.log(chalk.dim("  Use memfork log --branch " + fromBranch + " to see history."));
    console.log("");
  }
}

// ─── delegates ────────────────────────────────────────────────────────────────

export async function cmdDelegates(): Promise<void> {
  const { client, cfg } = await getClient();
  const tree = await client.getTree() as unknown as Record<string, unknown>;

  const delegates = (tree["delegates"] as Array<Record<string, unknown>> | undefined) ?? [];

  console.log("");
  console.log(chalk.bold("Delegates") + chalk.dim("  tree: " + cfg.treeId.slice(0, 12) + "…"));
  console.log("");

  if (delegates.length === 0) {
    console.log(chalk.dim("  No delegates (only the owner can commit)."));
  } else {
    for (const d of delegates) {
      const addr  = String(d["address"] ?? d["sui_address"] ?? "");
      const perms = String(d["permissions"] ?? "0xFF");
      const expiry = d["expiry_ms"]
        ? new Date(Number(d["expiry_ms"])).toISOString().slice(0, 10)
        : "never";
      console.log(
        `  ${chalk.cyan(addr.slice(0, 14) + "…")}` +
        chalk.dim(`  perms: ${perms}  expiry: ${expiry}`),
      );
    }
  }
  console.log("");
}

// ─── grant ────────────────────────────────────────────────────────────────────

export async function cmdGrant(opts: {
  address: string;
  permissions?: string;
  expiry?: number;
  branches?: string[];
}): Promise<void> {
  const { client } = await getClient();

  const permissions = opts.permissions ? parseInt(opts.permissions, 16) : 0xFF;
  const expiryMs    = opts.expiry ?? Number.MAX_SAFE_INTEGER;

  process.stdout.write(
    chalk.dim(`Granting delegate to ${chalk.cyan(opts.address)} …  `),
  );

  const digest = await client.grantDelegate(opts.address, {
    perms:         permissions,
    expiresEpoch:  BigInt(expiryMs),
    branches:      opts.branches,
  });

  console.log(chalk.green("done"));
  console.log(chalk.dim(`  tx: ${digest}`));
  console.log("");
}

// ─── revoke ───────────────────────────────────────────────────────────────────

export async function cmdRevoke(address: string): Promise<void> {
  const { client } = await getClient();

  process.stdout.write(
    chalk.dim(`Revoking delegate ${chalk.cyan(address)} …  `),
  );

  const digest = await client.revokeDelegate(address);

  console.log(chalk.green("done"));
  console.log(chalk.dim(`  tx: ${digest}`));
  console.log("");
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
      if (fs.existsSync(c + "/package.json")) return c;
    } catch { continue; }
  }
  return null;
}
