/**
 * Operational commands: status, log, recall, commit, merge, proposals.
 * All resolve config via the layered config system — no env vars needed.
 */

import { execSync, exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import chalk from "chalk";
import {
  resolveConfig,
  toClientConfig,
  readProjectConfig,
  writeProjectConfig,
  MEMWAL_CONSTANTS,
} from "../config.js";
import { resolveBranch, resolveAuthor } from "../branch.js";
import { MemForksClient } from "@memfork/core";

// ─── Shared helpers ───────────────────────────────────────────────────────────

async function getClient(): Promise<{ client: MemForksClient; cfg: ReturnType<typeof resolveConfig> }> {
  const cfg = resolveConfig();
  const client = await MemForksClient.connect(toClientConfig(cfg));
  return { client, cfg };
}

// ─── status ───────────────────────────────────────────────────────────────────

export async function cmdStatus(): Promise<void> {
  const { client, cfg } = await getClient();
  const tree = await client.getTree() as unknown as Record<string, unknown>;

  console.log("");
  console.log(chalk.bold("MemForks status"));
  console.log("");
  const currentBranch = resolveBranch({ configDefault: cfg.defaultBranch });
  console.log(`  Tree      ${chalk.cyan(cfg.treeId)}`);
  console.log(`  Network   ${cfg.network}`);
  console.log(`  Branch    ${chalk.green(currentBranch)}`);
  console.log(`  Tree dflt ${chalk.dim(String(tree["default_branch"] ?? cfg.defaultBranch))}`);
  console.log(`  Signer    ${client.keypair.toSuiAddress()}`);
  console.log("");
}

// ─── log ──────────────────────────────────────────────────────────────────────

export async function cmdLog(opts: { branch?: string; limit?: number }): Promise<void> {
  const { client, cfg } = await getClient();
  const branch = resolveBranch({ explicit: opts.branch, configDefault: cfg.defaultBranch });

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

/**
 * MemWal stores the full CommitPayload JSON as the blob text.
 * Extract human-readable facts from `delta.facts[]` when present,
 * falling through to `message`, and finally the raw text as a last resort.
 */
function unwrapRecallText(text: string): string {
  try {
    const p = JSON.parse(text) as Record<string, unknown>;
    if (p["type"] === "commit") {
      const delta = p["delta"] as Record<string, unknown> | undefined;
      const facts = delta?.["facts"] as string[] | undefined;
      if (facts?.length) return facts.join("  ·  ");
      const msg = p["message"] as string | undefined;
      if (msg) return msg;
    }
  } catch { /* not JSON — fall through */ }
  return text;
}

export async function cmdRecall(
  query: string,
  opts: { branch?: string; limit?: number; json?: boolean },
): Promise<void> {
  const { client, cfg } = await getClient();
  const branch = resolveBranch({ explicit: opts.branch, configDefault: cfg.defaultBranch });

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
      const display = unwrapRecallText(r.text);
      console.log(`  ${bar}  ${chalk.dim(r.distance.toFixed(3))}  ${display}`);
    }
  }
  console.log("");
}

// ─── commit ───────────────────────────────────────────────────────────────────

export async function cmdCommit(opts: {
  branch?: string;
  message: string;
  facts?: string[];
  tool?: string;
  author?: string;
  fromResponse?: string;
  autoExtract?: boolean;
  /**
   * Files to persist as Walrus artifacts attached to this commit.
   * Each entry is { filePath: local FS path, mime?: MIME type, epochs?: override }.
   * Requires artifacts.enabled = true in config and a WAL-funded keypair.
   */
  files?: Array<{ filePath: string; mime?: string; epochs?: number }>;
}): Promise<void> {
  const { client, cfg } = await getClient();
  const branch = resolveBranch({ explicit: opts.branch, configDefault: cfg.defaultBranch });
  const authorName = resolveAuthor({ explicit: opts.author, configAuthor: cfg.author });

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

  // Build artifact descriptors from --file flags.
  const artifacts: Array<{ path: string; bytes: Uint8Array; mime?: string; epochs?: number }> = [];
  if (opts.files && opts.files.length > 0) {
    if (!cfg.artifacts.enabled) {
      console.error(
        chalk.red("Artifact storage is disabled.") +
        chalk.dim(
          "\n  Set artifacts.enabled = true in .memfork/config.json and fund your signer with WAL.\n" +
          "  See docs/architecture/artifacts.md for setup instructions.",
        ),
      );
      process.exit(1);
    }
    for (const f of opts.files) {
      if (!fs.existsSync(f.filePath)) {
        console.error(chalk.red(`File not found: ${f.filePath}`));
        process.exit(1);
      }
      const bytes = new Uint8Array(fs.readFileSync(f.filePath));
      artifacts.push({
        path: path.basename(f.filePath),
        bytes,
        mime: f.mime,
        epochs: f.epochs,
      });
    }
  }

  const { blobId, artifacts: refs = [] } = await client.commit(branch, {
    facts,
    message: opts.message,
    ...(opts.tool ? { tool: opts.tool } : {}),
    ...(authorName ? { authorName } : {}),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  });

  const out = { blobId, branch, artifacts: refs };
  // Always print the human-readable confirmation so agents and CI can recognise
  // success without parsing JSON. In non-TTY contexts (subprocesses, pipes) we
  // additionally emit the JSON on the following line for machine consumption.
  console.log("");
  console.log(chalk.green("✓") + " Committed to " + chalk.bold(branch));
  console.log(chalk.dim(`  blob: ${blobId}`));
  if (refs.length > 0) {
    console.log("");
    console.log(chalk.bold("  Artifacts:"));
    for (const ref of refs) {
      console.log(
        `    ${chalk.cyan(ref.path)}  ` +
        chalk.dim(`${(ref.size / 1024).toFixed(1)} KiB  `) +
        chalk.dim(`blob: ${ref.blobId.slice(0, 16)}…  `) +
        chalk.dim(`sha256: ${ref.sha256.slice(0, 16)}…`),
      );
      console.log(
        chalk.dim(`    Retrieve with: `) +
        chalk.white(`memfork cat ${ref.blobId} --output ${ref.path} --sha256 ${ref.sha256}`),
      );
    }
  }
  console.log("");
  if (!process.stdout.isTTY) {
    console.log(JSON.stringify(out));
  }
}

// ─── cat ──────────────────────────────────────────────────────────────────────

/**
 * `memfork cat <blobId>` — retrieve an artifact blob from Walrus.
 *
 * Writes bytes to `--output <path>` or, when no output is specified, prints
 * the blob as UTF-8 text. Pass `--sha256 <hex>` to verify integrity.
 */
export async function cmdCat(
  blobId: string,
  opts: { output?: string; sha256?: string; network?: string } = {},
): Promise<void> {
  // Basic blobId sanity: Walrus blob IDs are base64url (~43 chars) or integer strings.
  if (!blobId || blobId.length < 8 || /\s/.test(blobId)) {
    console.error(chalk.red(`Invalid blob ID: "${blobId}". Expected a Walrus blob ID (base64url).`));
    process.exit(1);
  }

  const { getArtifact, ArtifactStorageError } = await import("@memfork/core");
  const network = (opts.network ?? resolveConfig().network ?? "mainnet") as "mainnet" | "testnet";

  process.stdout.write(chalk.dim(`Fetching blob ${blobId.slice(0, 16)}… from Walrus (${network})  `));

  // sha256 is optional: when omitted, getArtifact skips the integrity check.
  let bytes: Uint8Array;
  try {
    bytes = await getArtifact({ blobId, sha256: opts.sha256 ?? "" }, network);
  } catch (err: unknown) {
    console.log(chalk.red("failed"));

    if (err instanceof ArtifactStorageError) {
      // Structured errors: print the reason-specific message cleanly.
      console.error("\n" + chalk.red(err.message) + "\n");
      if (err.reason === "not_found") {
        console.error(
          chalk.dim(
            "  Tip: re-run with --sha256 to verify integrity once found,\n" +
            "       or check the original commit with: memfork log",
          ),
        );
      } else if (err.reason === "integrity") {
        console.error(chalk.yellow("  Warning: the blob exists but its contents may be corrupted or tampered with."));
      }
    } else {
      console.error(chalk.red(String(err)));
    }
    process.exit(1);
  }

  console.log(chalk.green("done") + chalk.dim(` (${bytes.length} bytes)`));

  if (opts.output) {
    fs.writeFileSync(opts.output, bytes);
    console.log(chalk.green("✓") + " Saved to " + chalk.bold(opts.output));
  } else {
    // Print as UTF-8.
    process.stdout.write(new TextDecoder().decode(bytes));
    if (!bytes[bytes.length - 1] || bytes[bytes.length - 1] !== 10) {
      process.stdout.write("\n");
    }
  }
}

// ─── merge ────────────────────────────────────────────────────────────────────

export async function cmdMerge(
  from: string,
  into: string,
  opts: { resolver?: string; ttl?: number; lww?: boolean },
): Promise<void> {
  const cfg = resolveConfig();
  const clientCfg = {
    ...toClientConfig(cfg),
    // --resolver flag overrides MEMFORK_RESOLVER_ID env var for this call.
    // --lww forces the LWW path even when MEMFORK_RESOLVER_ID is set.
    ...(opts.lww ? { defaultResolverId: undefined } : opts.resolver ? { defaultResolverId: opts.resolver } : {}),
  };
  const client = await MemForksClient.connect(clientCfg);

  const governed = !opts.lww && !!(opts.resolver ?? process.env["MEMFORK_RESOLVER_ID"]);

  process.stdout.write(
    chalk.dim(`Merging ${chalk.green(from)} → ${chalk.green(into)}`) +
    chalk.dim(governed ? "  (governed — awaiting resolver…)" : "  (LWW — self-finalizing…)") +
    "  ",
  );

  const { digest, mergedCount, blobId, proposalId } = await client.merge(from, into);

  console.log(chalk.green("done"));
  console.log("");
  console.log(chalk.dim(`  facts merged: ${mergedCount}`));
  if (blobId)     console.log(chalk.dim(`  blob:         ${blobId}`));
  if (digest)     console.log(chalk.dim(`  tx:           ${digest}`));
  if (proposalId) console.log(chalk.dim(`  proposal:     ${proposalId}`));
  console.log("");

  if (governed) {
    console.log(chalk.dim("Resolver finalized. Use `memfork log --branch " + into + "` to verify."));
  } else {
    console.log(chalk.dim("Merge anchor written on-chain. Use `memfork log --branch " + into + "` to verify."));
  }
  console.log("");
}

// ─── proposals ────────────────────────────────────────────────────────────────

export async function cmdProposals(): Promise<void> {
  const { cfg } = await getClient();

  const { SuiJsonRpcClient, JsonRpcHTTPTransport, getJsonRpcFullnodeUrl } =
    await import("@mysten/sui/jsonRpc");
  const network = cfg.network ?? "mainnet";
  const rpcUrl = cfg.rpcUrl ?? getJsonRpcFullnodeUrl(network);
  const consts = MEMWAL_CONSTANTS[network as keyof typeof MEMWAL_CONSTANTS] ?? MEMWAL_CONSTANTS.mainnet;
  const memforksPackageId = cfg.packageId ?? consts.memforksPackageId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sui = new SuiJsonRpcClient({ transport: new JsonRpcHTTPTransport({ url: rpcUrl }), network } as any);

  console.log("");
  console.log(chalk.bold("Merge proposals") + chalk.dim("  tree: " + cfg.treeId.slice(0, 12) + "…"));
  console.log("");

  const PROPOSAL_STATUS = { PENDING: 0, FINALIZED: 1, ABORTED: 2 };

  let events: Array<{ parsedJson: Record<string, unknown> }>;
  try {
    const result = await sui.queryEvents({
      query: { MoveEventType: `${memforksPackageId}::resolver::MergeProposed` },
      limit: 20,
      order: "descending",
    });
    events = (result.data as typeof events).filter(
      (e) => e.parsedJson["tree_id"] === cfg.treeId,
    );
  } catch {
    console.log(chalk.dim("  Could not query Sui events."));
    console.log(chalk.cyan("  →") + " Run " + chalk.bold("memfork ui") + " for the live view.");
    console.log("");
    return;
  }

  if (events.length === 0) {
    console.log(chalk.dim("  No proposals found for this tree."));
    console.log("");
    return;
  }

  for (const ev of events.slice(0, 10)) {
    const p = ev.parsedJson as Record<string, string>;
    const id = String(p["proposal_id"] ?? "");

    // Fetch live status from the proposal object.
    let statusLabel = chalk.yellow("pending");
    try {
      const obj = await sui.getObject({ id, options: { showContent: true } });
      if (obj.data?.content && obj.data.content.dataType === "moveObject") {
        const status = Number((obj.data.content.fields as Record<string, unknown>)["status"]);
        if (status === PROPOSAL_STATUS.FINALIZED) statusLabel = chalk.green("finalized");
        else if (status === PROPOSAL_STATUS.ABORTED) statusLabel = chalk.red("aborted");
      }
    } catch { /* proposal may be consumed */ }

    console.log(
      `  ${statusLabel}  ` +
      chalk.green(String(p["from_branch"]) + " → " + String(p["into_branch"])) + "  " +
      chalk.dim(id.slice(0, 12) + "…"),
    );
  }
  console.log("");
  console.log(chalk.dim("  Full detail: memfork ui → Merges view"));
  console.log("");
}

// ─── resolver create ──────────────────────────────────────────────────────────

export async function cmdResolverCreate(opts: {
  jury: string;
  k: number;
}): Promise<void> {
  const { client } = await getClient();
  const { resolvers } = await import("@memfork/core");

  const juryAddrs = opts.jury.split(",").map((a) => a.trim()).filter(Boolean);
  if (juryAddrs.length === 0) {
    console.error(chalk.red("Pass at least one judge address via --jury <addr1,addr2,...>"));
    process.exit(1);
  }
  const k = opts.k ?? Math.ceil(juryAddrs.length / 2 + 0.5);

  process.stdout.write(
    chalk.dim(`Creating jury resolver  (${k}-of-${juryAddrs.length}) …  `),
  );

  const def = resolvers.jury(juryAddrs, k, juryAddrs.length);
  const { digest, resolverId } = await client.createResolver(def);

  console.log(chalk.green("done"));
  console.log("");
  console.log(chalk.dim("  ResolverRef: ") + chalk.cyan(resolverId));
  console.log(chalk.dim("  tx:          ") + chalk.dim(digest));
  console.log("");
  console.log(chalk.bold("  Save this to your environment:"));
  console.log("  " + chalk.cyan(`export MEMFORK_RESOLVER_ID=${resolverId}`));
  console.log("");
  console.log(chalk.dim("  Or add resolverId to .memfork/config.json for project-wide use."));
  console.log("");
}

// ─── pr-comment ───────────────────────────────────────────────────────────────

export async function cmdPrComment(opts: {
  pr: number;
  repo?: string;
  branch?: string;
}): Promise<void> {
  const { client, cfg } = await getClient();

  const { SuiJsonRpcClient, JsonRpcHTTPTransport, getJsonRpcFullnodeUrl } =
    await import("@mysten/sui/jsonRpc");
  const network = cfg.network ?? "mainnet";
  const rpcUrl = cfg.rpcUrl ?? getJsonRpcFullnodeUrl(network);
  const consts = MEMWAL_CONSTANTS[network as keyof typeof MEMWAL_CONSTANTS] ?? MEMWAL_CONSTANTS.mainnet;
  const memforksPackageId = cfg.packageId ?? consts.memforksPackageId;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sui = new SuiJsonRpcClient({ transport: new JsonRpcHTTPTransport({ url: rpcUrl }), network } as any);

  console.log("");
  console.log(chalk.dim("Fetching latest merge anchor…"));

  // Find the most recent MergeFinalized event for this tree.
  let anchorId = "";
  let proposalId = "";
  let suiTx = "";
  let walrusBlob = "";
  let fromBranch = "";
  let intoBranch = "";

  try {
    const result = await sui.queryEvents({
      query: { MoveEventType: `${memforksPackageId}::resolver::MergeFinalized` },
      limit: 10,
      order: "descending",
    });
    const ev = (result.data as Array<{ parsedJson: Record<string, unknown>; id: { txDigest: string } }>)
      .find((e) => e.parsedJson["tree_id"] === cfg.treeId);

    if (!ev) {
      console.error(chalk.red("No finalized merges found for this tree. Run `memfork merge` first."));
      process.exit(1);
    }

    anchorId   = String(ev.parsedJson["merge_commit_id"] ?? "");
    // resolved_blob_id is emitted as a byte array (vector<u8>) — decode to string.
    const blobRaw = ev.parsedJson["resolved_blob_id"];
    walrusBlob = Array.isArray(blobRaw)
      ? String.fromCharCode(...(blobRaw as number[]))
      : String(blobRaw ?? "");
    suiTx      = ev.id.txDigest;
    proposalId = String(ev.parsedJson["proposal_id"] ?? "");
  } catch (e) {
    console.error(chalk.red("Failed to query Sui: " + String(e)));
    process.exit(1);
  }

  // Fetch proposal for branch names, vote count, and threshold.
  let voteCount = "?";
  let threshold = "?";
  try {
    const obj = await sui.getObject({ id: proposalId, options: { showContent: true } });
    if (obj.data?.content && obj.data.content.dataType === "moveObject") {
      const fields = obj.data.content.fields as Record<string, unknown>;
      fromBranch = String(fields["from_branch"] ?? "");
      intoBranch = String(fields["into_branch"] ?? "");
      const attests = fields["attestations"] as unknown[] | undefined;
      voteCount = String(attests?.length ?? "?");
      // Pull required-approvals threshold from the resolver config field if present.
      const resolverCfg = fields["resolver_config"] as Record<string, unknown> | undefined;
      const required = resolverCfg?.["required"] ?? resolverCfg?.["k"];
      if (required != null) {
        threshold = String(required);
      } else if (attests?.length) {
        // Fallback: threshold = voteCount (unanimous approval observed).
        threshold = voteCount;
      }
    }
  } catch { /* non-critical */ }

  // Get the decided fact from the into_branch via recall.
  // The proposal's into_branch is the most specific target, so it is treated
  // as an explicit selection (ranking above the current git branch).
  const targetBranch = resolveBranch({
    explicit: opts.branch ?? intoBranch,
    configDefault: cfg.defaultBranch,
  });
  let decision = `Use ${fromBranch || "winning branch"} approach.`;
  try {
    const results = await client.recall("decided", { branch: targetBranch, limit: 1 });
    if (results.length > 0) {
      decision = results[0].text.replace(/^decided:\s*/i, "").split(".")[0] + ".";
    }
  } catch { /* fallback to default */ }

  // Find rejected paths via recall on the into_branch.
  let rejectedPath = "";
  try {
    const rejected = await client.recall("rejected-path", { branch: targetBranch, limit: 1 });
    if (rejected.length > 0) {
      const match = rejected[0].text.match(/(\S+)\s+was not merged/);
      if (match) rejectedPath = match[1];
    }
  } catch { /* non-critical */ }

  const shortAnchor = anchorId.replace(/^0x/, "").slice(0, 8);
  const suiscanBase = network === "mainnet"
    ? "https://suiscan.xyz/mainnet"
    : `https://suiscan.xyz/${network}`;
  const txUrl      = `${suiscanBase}/tx/${suiTx}`;
  const anchorUrl  = `${suiscanBase}/object/${anchorId}`;

  const lines: string[] = [
    `### 🔗 MemForks decision`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| **Decision** | ${decision} |`,
    `| **Jury** | ${voteCount} of ${threshold} approvals — threshold enforced on Sui |`,
    `| **Merge anchor** | \`${shortAnchor}\` |`,
    `| **Sui tx** | [${suiTx.slice(0, 12)}…](${txUrl}) |`,
    `| **Walrus blob** | \`${walrusBlob}\` |`,
  ];

  if (rejectedPath) {
    lines.push(`| **Preserved path** | \`${rejectedPath}@latest\` — rejected by jury, still queryable |`);
  }

  lines.push(
    ``,
    `**Full audit trail:** [Merge anchor on Suiscan](${anchorUrl})`,
    ``,
    `> _Generated by [MemForks](https://github.com/memforks-dev/memforks) — verifiable agent memory on Sui + Walrus._`,
  );

  const body = lines.join("\n");

  // Post via gh CLI — write body to a temp file to avoid shell interpolation of
  // backticks, special chars, and newlines in the comment text.
  const tmpFile = path.join(process.env["TMPDIR"] ?? "/tmp", `memfork-pr-comment-${Date.now()}.md`);
  const repoFlag = opts.repo ? `--repo ${opts.repo}` : "";
  try {
    fs.writeFileSync(tmpFile, body, "utf8");
    execSync(`gh pr comment ${opts.pr} ${repoFlag} --body-file ${JSON.stringify(tmpFile)}`, {
      stdio: ["ignore", "inherit", "inherit"],
    });
    console.log(chalk.green("✓") + " Comment posted to PR #" + opts.pr);
  } catch {
    console.log(chalk.yellow("gh CLI not available or PR not found. Copy this comment:"));
    console.log("");
    console.log(body);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
  console.log("");
}

// ─── ui ───────────────────────────────────────────────────────────────────────

export async function cmdUi(opts: { share?: boolean; port?: number } = {}): Promise<void> {
  const appDir = findAppDir();
  if (!appDir) {
    console.log(chalk.yellow("Could not find the MemForks app directory."));
    console.log(chalk.dim("Build the app manually: cd apps/visualizer && npm run build"));
    return;
  }

  // Two layouts: the published bundle (packages/cli/ui/) holds index.html +
  // assets/ directly, while the monorepo source (apps/visualizer/) builds into
  // a dist/ subdir. Detect which one we resolved to.
  const distDir  = fs.existsSync(path.join(appDir, "index.html"))
    ? appDir
    : path.join(appDir, "dist");
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
  console.log(chalk.dim("resolved_blob:  ") + chalk.cyan(String(anchor.memwal_blob_id ?? "")));
  console.log(chalk.dim("namespace:      ") + chalk.dim(String(anchor.memwal_namespace ?? "")));
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

  // Valid permission bits: READ(0x01) | WRITE(0x02) | FORK(0x04) | MERGE(0x08) | PROPOSE(0x10).
  // The contract rejects reserved bits (0xE0). Commander always supplies the default so
  // opts.permissions is never undefined — parseInt always runs.
  const permissions = parseInt(opts.permissions ?? "0x1F", 16);
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

// ─── grant-memwal ─────────────────────────────────────────────────────────────

/**
 * Register a new team member's MemWal delegate key with the tree's MemWal account.
 * Run by the tree owner after a teammate runs `memfork join`.
 */
export async function cmdGrantMemwal(opts: {
  agent: string;
  pubkey: string;
}): Promise<void> {
  const { cfg } = await getClient();

  const { addDelegateKey } = await import("@mysten-incubation/memwal/account");
  const { JsonRpcHTTPTransport, SuiJsonRpcClient, getJsonRpcFullnodeUrl } = await import("@mysten/sui/jsonRpc");

  const network = cfg.network ?? "mainnet";
  const consts  = MEMWAL_CONSTANTS[network === "mainnet" ? "mainnet" : "testnet"];
  const rpcUrl  = getJsonRpcFullnodeUrl(network);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const suiClient = new SuiJsonRpcClient({ transport: new JsonRpcHTTPTransport({ url: rpcUrl }), network } as any);

  const pubkeyBytes = Uint8Array.from(Buffer.from(opts.pubkey, "hex"));

  process.stdout.write(
    chalk.dim(`Registering MemWal delegate key for ${chalk.cyan(opts.agent.slice(0, 14) + "…")} …  `),
  );

  try {
    await addDelegateKey({
      packageId:    consts.packageId,
      accountId:    cfg.memwalAccountId,
      publicKey:    pubkeyBytes,
      label:        `memfork-join-${opts.agent.slice(0, 8)}`,
      suiPrivateKey: cfg.privateKey,
      suiClient,
    });
    console.log(chalk.green("done"));
    console.log("");
    console.log(chalk.dim(`  The key is now registered on the MemWal account.`));
    console.log(chalk.dim(`  Tell ${opts.agent.slice(0, 14)}… to run: memfork doctor`));
    console.log("");
  } catch (e) {
    const msg = String(e);
    if (msg.includes("EDelegateKeyAlreadyExists")) {
      console.log(chalk.dim("already registered"));
      console.log("");
    } else {
      console.log(chalk.red("failed"));
      throw new Error(`MemWal key registration failed: ${msg}`);
    }
  }
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

// ─── branch ───────────────────────────────────────────────────────────────────

export async function cmdBranch(
  name: string,
  opts: { from?: string } = {},
): Promise<void> {
  const { client, cfg } = await getClient();
  const from = resolveBranch({ explicit: opts.from, configDefault: cfg.defaultBranch });

  process.stdout.write(
    chalk.dim(`Creating branch ${chalk.green(name)} from ${chalk.green(from)} …  `),
  );
  try {
    const digest = await client.branch(name, { from });
    console.log(chalk.green("done"));
    console.log("");
    console.log(chalk.dim(`  tx: ${digest}`));
    console.log(chalk.dim(`  Run ${chalk.white("memfork checkout " + name)} to switch to it.`));
    console.log("");
  } catch (err: unknown) {
    // E_BRANCH_EXISTS (Move abort code 7) — treat as success so `memfork branch`
    // is safe to run idempotently in scripts and runbooks.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("MoveAbort") && msg.match(/,\s*7\)/)) {
      console.log(chalk.dim("already exists"));
      console.log("");
      console.log(chalk.dim(`  Branch "${name}" is already on this tree — no action needed.`));
      console.log(chalk.dim(`  Run ${chalk.white("memfork checkout " + name)} to switch to it.`));
      console.log("");
    } else {
      throw err;
    }
  }
}

// ─── checkout ─────────────────────────────────────────────────────────────────

export async function cmdCheckout(
  name: string,
  opts: { at?: string } = {},
): Promise<void> {
  const { client, cfg } = await getClient();

  // Verify the branch exists on-chain before switching.
  try {
    await client.getBranchHead(name);
  } catch {
    console.error(
      chalk.red(`\n  Branch "${name}" not found on tree.`) +
      chalk.dim("\n  Use `memfork branch " + name + "` to create it first.\n"),
    );
    process.exit(1);
  }

  if (opts.at) {
    // ── Time-travel mode (read-only, detached HEAD) ──────────────────────────
    console.log("");
    console.log(
      chalk.bold("memfork checkout") + " " + chalk.green(name) +
      chalk.dim(" --at ") + chalk.yellow(opts.at),
    );
    console.log("");
    console.log(chalk.dim("  Reconstructing history…"));

    const { commits, facts, cutBlobId } = await client.materializeAt(name, opts.at);

    if (commits.length === 0) {
      console.log(chalk.dim("  No commits found for this branch."));
      console.log("");
      return;
    }

    console.log("");
    console.log(
      chalk.bold("Memory state as-of ") + chalk.yellow(cutBlobId.slice(0, 10) + "…") +
      chalk.dim(` (${commits.length} commit${commits.length === 1 ? "" : "s"})`),
    );
    console.log("");
    for (const c of commits) {
      const ts = new Date(c.ts_ms).toISOString().replace("T", " ").slice(0, 19);
      console.log(
        "  " + chalk.yellow(c.blobId.slice(0, 8)) +
        chalk.dim("  " + ts + "  ") +
        chalk.white(c.message.slice(0, 72)),
      );
    }
    console.log("");
    if (facts.length) {
      console.log(chalk.bold("  Facts at this point:"));
      for (const f of facts) {
        console.log("  " + chalk.dim("·") + " " + f);
      }
    }
    console.log("");
    console.log(
      chalk.dim(
        "  ⚠  Detached view — this branch is read-only at this point.\n" +
        "     To branch from here: memfork branch <new-name> --from " + name,
      ),
    );
    console.log("");
    return;
  }

  // ── Normal branch switch ───────────────────────────────────────────────────
  const project = readProjectConfig() ?? {};
  writeProjectConfig({ ...project, defaultBranch: name });

  console.log("");
  console.log(chalk.green("✓") + " Switched to " + chalk.bold(name));
  console.log(chalk.dim("  (updated .memfork/config.json)"));
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
  // Resolution order:
  //   1. packages/cli/ui/         — bundled at publish time (npm install path)
  //   2. apps/visualizer/         — monorepo dev path (two depths to handle symlinks)
  const candidates = [
    new URL("../../ui",             import.meta.url).pathname,  // dist/commands/ → cli root → ui/
    new URL("../../../../apps/visualizer",  import.meta.url).pathname,  // monorepo: packages/cli
    new URL("../../../../../apps/visualizer", import.meta.url).pathname, // monorepo: alternate depth
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "index.html")) || fs.existsSync(path.join(c, "package.json"))) {
        return c;
      }
    } catch { continue; }
  }
  return null;
}

// ─── config ───────────────────────────────────────────────────────────────────

const SETTABLE_KEYS = ["author", "defaultBranch"] as const;
type SettableKey = typeof SETTABLE_KEYS[number];

/**
 * memfork config set <key> <value>
 * Writes a value into .memfork/config.json.
 * Settable keys: author, defaultBranch
 */
export async function cmdConfigSet(key: string, value: string): Promise<void> {
  if (!SETTABLE_KEYS.includes(key as SettableKey)) {
    console.error(chalk.red(`Unknown config key "${key}". Settable keys: ${SETTABLE_KEYS.join(", ")}`));
    process.exitCode = 1;
    return;
  }
  const existing = readProjectConfig() ?? {};
  const updated = { ...existing, [key]: value };
  writeProjectConfig(updated);
  console.log(chalk.green(`✓ config.${key} = ${JSON.stringify(value)}`));
  console.log(chalk.dim("  saved to .memfork/config.json"));
}

/**
 * memfork config get [key]
 * Prints one config value or all of them, showing where each comes from.
 */
export async function cmdConfigGet(key?: string): Promise<void> {
  const file = readProjectConfig() ?? {};
  const env = process.env;

  const sources: { key: string; value: string | undefined; source: string }[] = [
    {
      key: "author",
      value: env["MEMFORK_AUTHOR"] ?? file.author,
      source: env["MEMFORK_AUTHOR"]
        ? "env MEMFORK_AUTHOR"
        : file.author
        ? ".memfork/config.json"
        : "git config user.name (fallback)",
    },
    {
      key: "defaultBranch",
      value: env["MEMFORK_DEFAULT_BRANCH"] ?? file.defaultBranch ?? "main",
      source: env["MEMFORK_DEFAULT_BRANCH"]
        ? "env MEMFORK_DEFAULT_BRANCH"
        : file.defaultBranch
        ? ".memfork/config.json"
        : "built-in default",
    },
  ];

  const rows = key ? sources.filter((s) => s.key === key) : sources;
  if (key && rows.length === 0) {
    console.error(chalk.red(`Unknown config key "${key}". Known keys: ${sources.map((s) => s.key).join(", ")}`));
    process.exitCode = 1;
    return;
  }
  for (const row of rows) {
    console.log(
      `${chalk.bold(row.key.padEnd(16))}${chalk.cyan(row.value ?? "(unset)")}  ${chalk.dim(`← ${row.source}`)}`,
    );
  }
}
