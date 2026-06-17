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
import { autoProvision } from "./provision.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function dim(s: string) { return chalk.dim(s); }
function ok(s: string)  { return chalk.green("✓") + " " + s; }
function err(s: string) { return chalk.red("✗") + " " + chalk.red(s); }
function tip(s: string) { return chalk.cyan("→") + " " + s; }

// ─── Command ──────────────────────────────────────────────────────────────────

export async function cmdInit(opts: { quick?: boolean } = {}): Promise<void> {
  console.log("");
  console.log(chalk.bold("MemForks init") + "  " + dim("configure your memory tree"));
  console.log("");

  // ── Mode selection ──────────────────────────────────────────────────────────

  const mode = opts.quick
    ? "quick"
    : await select({
        message: "How do you want to set up?",
        choices: [
          {
            value: "quick",
            name:  "Quick setup  " + chalk.dim("— auto-provision: keygen → funding → MemWal → tree  (recommended)"),
          },
          {
            value: "manual",
            name:  "Manual setup  " + chalk.dim("— paste existing keys & IDs"),
          },
        ],
      });

  if (mode === "quick") {
    await cmdInitQuick();
  } else {
    await cmdInitManual();
  }
}

// ─── Quick path ───────────────────────────────────────────────────────────────

async function cmdInitQuick(): Promise<void> {
  console.log("");
  console.log(dim("  We'll generate a fresh keypair, guide wallet funding if needed,"));
  console.log(dim("  create your MemWal account and memory tree automatically."));
  console.log(dim("  Nothing to copy-paste."));
  console.log("");

  const network = await select({
    message: "Sui network",
    default: "mainnet",
    choices: [
      { value: "mainnet", name: "mainnet  " + chalk.dim("— gas sponsored by MemForks  (recommended)") },
      { value: "testnet", name: "testnet  " + chalk.dim("— free funding via faucet") },
    ],
  }) as "testnet" | "mainnet";

  const existingKey = readProjectConfig()
    ? (await confirm({
        message: "Reuse your existing Sui key instead of generating a new one?",
        default:  false,
      }))
      ? await password({
          message: "Sui private key  (suiprivkey1… or 64-char hex)",
          mask: "*",
        })
      : undefined
    : undefined;

  console.log("");
  try {
    const result = await autoProvision({
      network,
      existingKey: existingKey || undefined,
    });

    // Persist — include sponsor URL on mainnet so all subsequent commands
    // (branch, commit, merge) use sponsored gas automatically.
    const sponsorBase = (process.env.MEMFORK_SPONSOR_URL ?? "https://memforks-sponsor-production.up.railway.app")
      .replace(/\/sponsor\/?$/, "");
    writeProjectConfig({
      treeId:        result.treeId,
      network:       result.network,
      defaultBranch: "main",
      ...(result.network === "mainnet" ? { sponsorUrl: `${sponsorBase}/sponsor` } : {}),
    });
    upsertCredential(result.treeId, {
      privateKey:      result.privateKey,
      memwalAccountId: result.memwalAccountId,
      memwalKey:       result.memwalKey,
    });
    ensureGitignore();

    console.log("");
    console.log(chalk.green.bold("  Setup complete!"));
    console.log("");
    console.log(ok(`Tree ID:     ${chalk.bold(result.treeId)}`));
    console.log(ok(`Address:     ${chalk.dim("(saved to credentials)")}`));
    console.log(ok(`Project cfg: ${chalk.bold(".memfork/config.json")}  ${dim("(safe to commit)")}`));
    console.log(ok(`Credentials: ${chalk.bold(credentialsPath())}  ${dim("(chmod 600, gitignored)")}`));
    printNextSteps();
  } catch (e) {
    console.log("");
    console.log(err(String(e)));
    process.exit(1);
  }
}

// ─── Manual path ──────────────────────────────────────────────────────────────

async function cmdInitManual(): Promise<void> {
  const existing = readProjectConfig();
  const creds    = readCredentials();

  // ── Step 1: network ──────────────────────────────────────────────────────────

  const network = await select({
    message: "Sui network",
    default: existing?.network ?? "mainnet",
    choices: [
      { value: "mainnet",  name: "mainnet  (requires funded wallet for setup)" },
      { value: "testnet",  name: "testnet  (free funding via faucet)" },
      { value: "devnet",   name: "devnet" },
      { value: "localnet", name: "localnet" },
    ],
  }) as ProjectConfig["network"];

  // ── Step 2: tree ID ──────────────────────────────────────────────────────────

  const treeMode = await select({
    message: "MemoryTree",
    choices: [
      { value: "existing", name: "Use an existing tree  (paste the object ID)" },
      { value: "new",      name: "Create a new tree now" },
    ],
  });

  let treeId: string = "";

  if (treeMode === "existing") {
    treeId = (await input({
      message: "Tree object ID (0x…)",
      default: existing?.treeId,
      validate: (v) =>
        /^0x[0-9a-fA-F]{64}$/.test(v.trim()) ? true : "Must be a 64-char hex address starting with 0x",
    })).trim();
  }

  // ── Step 3: Sui private key ───────────────────────────────────────────────────

  const storedKey = treeMode === "existing" ? creds.trees[treeId]?.privateKey : undefined;

  const privateKeyInput = await password({
    message: storedKey
      ? "Sui private key  (suiprivkey1… or hex — enter to keep existing)"
      : "Sui private key  (suiprivkey1… bech32 or 64-char hex)",
    mask: "*",
    validate: (v) => {
      if (storedKey && v === "") return true;
      if (v.startsWith("suiprivkey")) return true;
      if (/^[0-9a-fA-F]{64}$/.test(v)) return true;
      return "Expected suiprivkey1… (Sui CLI format) or 64-char hex";
    },
  });

  const resolvedKey = privateKeyInput === "" && storedKey ? storedKey : privateKeyInput;

  // ── Step 4: create tree if needed ─────────────────────────────────────────────

  if (treeMode === "new") {
    console.log("");
    const defaultBranch = await input({ message: "Default branch name", default: "main" });
    const memwalAccId = (await input({
      message: "MemWal account ID  (0x…)",
      validate: (v) => /^0x[0-9a-fA-F]{64}$/.test(v.trim()) ? true : "Must be 0x… address",
    })).trim();

    process.stdout.write(chalk.dim("  Creating MemoryTree on " + network + "…  "));
    try {
      const tempClient = await MemForksClient.connect({
        treeId: "0x" + "0".repeat(64),
        signer: resolvedKey,
        network,
      });
      const { treeId: newId, digest } = await tempClient.initTree(memwalAccId, defaultBranch);
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

  // ── Step 5: MemWal credentials ────────────────────────────────────────────────

  console.log("");
  console.log(dim("  MemWal — decentralised blob storage for memory contents."));
  console.log("");

  const storedCred = creds.trees[treeId];

  const memwalAccountId = (await input({
    message: "MemWal account ID (0x…)",
    default: storedCred?.memwalAccountId,
    validate: (v) => /^0x[0-9a-fA-F]{64}$/.test(v.trim()) ? true : "Must be 0x… address",
  })).trim();

  const memwalKeyInput = await password({
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

  const resolvedMemwalKey = memwalKeyInput === "" && storedCred?.memwalKey
    ? storedCred.memwalKey
    : memwalKeyInput;

  // ── Step 6: optional overrides ────────────────────────────────────────────────

  const advanced = await confirm({
    message: "Configure advanced options (RPC URL, package ID override)?",
    default: false,
  });

  let rpcUrl: string | undefined;
  let packageId: string | undefined;
  let defaultBranch = existing?.defaultBranch ?? "main";

  if (advanced) {
    rpcUrl        = (await input({ message: "Custom RPC URL  (leave blank for default)" })).trim() || undefined;
    packageId     = (await input({ message: "Package ID override  (leave blank for default)" })).trim() || undefined;
    defaultBranch = await input({ message: "Default branch", default: defaultBranch });
  }

  // ── Write ──────────────────────────────────────────────────────────────────────

  writeProjectConfig({
    treeId,
    network: network ?? "mainnet",
    defaultBranch,
    ...(rpcUrl    ? { rpcUrl }    : {}),
    ...(packageId ? { packageId } : {}),
  });

  upsertCredential(treeId, {
    privateKey:      resolvedKey,
    memwalAccountId,
    memwalKey:       resolvedMemwalKey,
  });

  ensureGitignore();

  console.log("");
  console.log(ok(`Project config written to ${chalk.bold(".memfork/config.json")}  ${dim("(safe to commit)")}`));
  console.log(ok(`Credentials stored in ${chalk.bold(credentialsPath())}  ${dim("(chmod 600, gitignored)")}`));
  console.log("");

  // ── Verify ────────────────────────────────────────────────────────────────────

  process.stdout.write(chalk.dim("  Verifying connection to Sui…  "));
  try {
    const client = await MemForksClient.connect({
      treeId,
      signer: resolvedKey,
      network: network ?? "mainnet",
      ...(rpcUrl    ? { rpcUrl }    : {}),
      ...(packageId ? { packageId } : {}),
    });
    await client.getTree();
    console.log(chalk.green("ok"));
  } catch {
    console.log(chalk.yellow("failed"));
    console.log(chalk.yellow("  ⚠ Could not reach tree — run `memfork doctor` to diagnose."));
  }

  printNextSteps();
}

// ─── Shared footer ─────────────────────────────────────────────────────────────

function printNextSteps() {
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
