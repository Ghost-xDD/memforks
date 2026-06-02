/**
 * `memfork init`
 *
 * Interactive first-run setup. Writes:
 *   .memfork/config.json        — committable project config (treeId, network, branch)
 *   ~/.memfork/credentials.json — secrets, chmod 600 (privateKey, memwalKey, etc.)
 *
 * Idempotent: re-running updates values without destroying existing ones.
 */

import { input, select, password, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import {
  readProjectConfig,
  readCredentials,
  writeProjectConfig,
  upsertCredential,
  credentialsPath,
  type ProjectConfig,
  type TreeCredential,
} from "../config.js";
import { MemForksClient } from "@memfork/core";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dim(s: string) { return chalk.dim(s); }
function ok(s: string)  { return chalk.green("✓") + " " + s; }
function err(s: string) { return chalk.red("✗") + " " + chalk.red(s); }
function tip(s: string) { return chalk.cyan("→") + " " + s; }

// ─── Command ──────────────────────────────────────────────────────────────────

export async function cmdInit(): Promise<void> {
  console.log("");
  console.log(chalk.bold("MemForks init") + "  " + dim("configure your memory tree"));
  console.log("");

  const existing = readProjectConfig();
  const creds    = readCredentials();

  // ── Step 1: network ─────────────────────────────────────────────────────────

  const network = await select({
    message: "Sui network",
    default: existing?.network ?? "testnet",
    choices: [
      { value: "testnet", name: "testnet  (default — free gas via faucet)" },
      { value: "mainnet", name: "mainnet" },
      { value: "devnet",  name: "devnet" },
      { value: "localnet",name: "localnet" },
    ],
  }) as ProjectConfig["network"];

  // ── Step 2: tree ID ──────────────────────────────────────────────────────────

  const mode = await select({
    message: "MemoryTree",
    choices: [
      { value: "existing", name: "Use an existing tree  (paste the object ID)" },
      { value: "new",      name: "Create a new tree now" },
    ],
  });

  let treeId: string;

  if (mode === "existing") {
    treeId = await input({
      message: "Tree object ID (0x…)",
      default: existing?.treeId,
      validate: (v) => /^0x[0-9a-fA-F]{64}$/.test(v.trim())
        ? true
        : "Must be a 64-char hex address starting with 0x",
    });
    treeId = treeId.trim();
  } else {
    // Create a new tree — need the key first.
    console.log("");
    console.log(dim("  To create a tree we need your Sui private key."));
  }

  // ── Step 3: Sui private key ──────────────────────────────────────────────────

  const storedKey = mode === "existing"
    ? creds.trees[treeId!]?.privateKey
    : undefined;

  const privateKey = await password({
    message: storedKey
      ? "Sui private key  (suiprivkey1… or hex — enter to keep existing)"
      : "Sui private key  (suiprivkey1… bech32 or 64-char hex)",
    mask: "*",
    validate: (v) => {
      if (storedKey && v === "") return true; // keep existing
      if (v.startsWith("suiprivkey")) return true;
      if (/^[0-9a-fA-F]{64}$/.test(v)) return true;
      return "Expected suiprivkey1… (Sui CLI format) or 64-char hex";
    },
  });

  const resolvedKey = (privateKey === "" && storedKey) ? storedKey : privateKey;

  // ── Step 4: create tree if needed ────────────────────────────────────────────

  if (mode === "new") {
    console.log("");
    process.stdout.write(chalk.dim("  Creating MemoryTree on " + network + "…  "));

    try {
      const tempClient = await MemForksClient.connect({
        treeId: "0x" + "0".repeat(64), // placeholder — initTree doesn't need it
        signer: resolvedKey,
        network,
      });
      const defaultBranch = await input({
        message: "Default branch name",
        default: "main",
      });

      const memwalAccountId = await input({
        message: "MemWal account ID (needed to create the tree)",
        validate: (v) => /^0x[0-9a-fA-F]{64}$/.test(v.trim()) ? true : "Must be 0x… address",
      });

      const { treeId: newId, digest } = await tempClient.initTree(
        memwalAccountId.trim(),
        defaultBranch,
      );
      treeId = newId;
      console.log(chalk.green("done"));
      console.log(ok(`Tree created: ${chalk.bold(treeId)}`));
      console.log(dim(`  tx: ${digest}`));
    } catch (e) {
      console.log(chalk.red("failed"));
      console.error(err(String(e)));
      process.exit(1);
    }
  }

  // ── Step 5: MemWal credentials ───────────────────────────────────────────────

  console.log("");
  console.log(dim("  MemWal — decentralised blob storage for memory contents."));
  console.log(dim("  Get credentials at: https://memwal.ai/dashboard"));
  console.log("");

  const storedCred = creds.trees[treeId!];

  const memwalAccountId = await input({
    message: "MemWal account ID (0x…)",
    default: storedCred?.memwalAccountId,
    validate: (v) => /^0x[0-9a-fA-F]{64}$/.test(v.trim()) ? true : "Must be 0x… address",
  });

  const memwalKey = await password({
    message: storedCred?.memwalKey
      ? "MemWal delegate key  (enter to keep existing)"
      : "MemWal delegate key  (64-char hex)",
    mask: "*",
    validate: (v) => {
      if (storedCred?.memwalKey && v === "") return true;
      if (/^[0-9a-fA-F]{64}$/.test(v)) return true;
      return "Expected 64-char hex";
    },
  });

  const resolvedMemwalKey = (memwalKey === "" && storedCred?.memwalKey)
    ? storedCred.memwalKey
    : memwalKey;

  // ── Step 6: optional overrides ───────────────────────────────────────────────

  const advanced = await confirm({
    message: "Configure advanced options (RPC URL, package ID override)?",
    default: false,
  });

  let rpcUrl: string | undefined;
  let packageId: string | undefined;
  let defaultBranch = "main";

  if (advanced) {
    rpcUrl = (await input({ message: "Custom RPC URL  (leave blank for default)" })).trim() || undefined;
    packageId = (await input({ message: "Package ID override  (leave blank for default)" })).trim() || undefined;
    defaultBranch = await input({ message: "Default branch", default: existing?.defaultBranch ?? "main" });
  }

  // ── Write ─────────────────────────────────────────────────────────────────────

  const projectCfg: ProjectConfig = {
    treeId:  treeId!,
    network: network ?? "testnet",
    defaultBranch,
    ...(rpcUrl    ? { rpcUrl }    : {}),
    ...(packageId ? { packageId } : {}),
  };

  const credential: TreeCredential = {
    privateKey:     resolvedKey,
    memwalAccountId: memwalAccountId.trim(),
    memwalKey:      resolvedMemwalKey,
  };

  writeProjectConfig(projectCfg);
  upsertCredential(treeId!, credential);

  // Ensure .memfork/credentials.json is in .gitignore
  ensureGitignore();

  console.log("");
  console.log(ok(`Project config written to ${chalk.bold(".memfork/config.json")}  ${dim("(safe to commit)")}`));
  console.log(ok(`Credentials stored in ${chalk.bold(credentialsPath())}  ${dim("(chmod 600, gitignored)")}`));
  console.log("");

  // ── Verify connection ─────────────────────────────────────────────────────────

  process.stdout.write(chalk.dim("  Verifying connection to Sui…  "));
  try {
    const client = await MemForksClient.connect({
      treeId: treeId!,
      signer: resolvedKey,
      network: network ?? "testnet",
      rpcUrl,
      packageId,
    });
    await client.getTree();
    console.log(chalk.green("ok"));
  } catch (e) {
    console.log(chalk.yellow("failed"));
    console.log(chalk.yellow("  ⚠ Could not reach tree — check treeId and network. Run `memfork doctor` to diagnose."));
  }

  console.log("");
  console.log(chalk.bold("Next steps:"));
  console.log(tip("memfork doctor           — verify the full setup"));
  console.log(tip("memfork install cursor   — install the Cursor plugin"));
  console.log(tip("memfork install codex    — install the Codex plugin"));
  console.log(tip("memfork status           — show tree status"));
  console.log("");
}

// ─── .gitignore helper ────────────────────────────────────────────────────────

function ensureGitignore(cwd = process.cwd()): void {
  const lines = [
    ".memfork/credentials.json",
    ".memfork/*.local.json",
  ];
  const gitignorePath = path.join(cwd, ".gitignore");

  let existing = "";
  if (fs.existsSync(gitignorePath)) {
    existing = fs.readFileSync(gitignorePath, "utf8");
  }

  const toAdd = lines.filter((l) => !existing.includes(l));
  if (toAdd.length === 0) return;

  const block = "\n# MemForks — never commit private keys\n" + toAdd.join("\n") + "\n";
  fs.appendFileSync(gitignorePath, block, "utf8");
}
