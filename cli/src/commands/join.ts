/**
 * `memfork join`
 *
 * Onboards a new team member to an existing MemoryTree.
 *
 * Prerequisites:
 *   - The repo has been cloned — .memfork/config.json is already present.
 *   - The tree owner is reachable to run `memfork grant` after this completes.
 *
 * What this does:
 *   1. Reads treeId from .memfork/config.json
 *   2. Generates a fresh Sui Ed25519 keypair for this machine
 *   3. Generates a MemWal delegate key for memory encryption/decryption
 *   4. Saves both to ~/.memfork/credentials.json (chmod 600)
 *   5. Prints copy-pasteable commands for the owner to run
 */

import chalk from "chalk";
import { select } from "@inquirer/prompts";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { generateDelegateKey } from "@mysten-incubation/memwal/account";
import {
  readProjectConfig,
  readCredentials,
  writeCredentials,
} from "../config.js";

function ok(s: string)  { return chalk.green("✓") + " " + s; }
function tip(s: string) { return chalk.cyan("→") + " " + chalk.white(s); }
function dim(s: string) { return chalk.dim(s); }
function step(n: number, total: number, msg: string) {
  process.stdout.write(`  ${dim(`[${n}/${total}]`)} ${msg}…  `);
}
function done() { console.log(chalk.green("done")); }

export async function cmdJoin(): Promise<void> {
  console.log("");
  console.log(chalk.bold("MemForks join") + "  " + dim("onboard to an existing memory tree"));
  console.log("");

  // ── 1. Find tree from project config ────────────────────────────────────────

  const project = readProjectConfig();
  if (!project?.treeId) {
    console.error(
      chalk.red("  ✗ No .memfork/config.json found in this directory tree.\n") +
      chalk.dim("    Make sure you've cloned the repo and are running this\n") +
      chalk.dim("    from inside the project directory.\n"),
    );
    process.exit(1);
  }

  const treeId  = project.treeId;
  const network = project.network ?? "testnet";

  console.log(dim(`  Found .memfork/config.json`));
  console.log(dim(`    tree:    ${treeId}`));
  console.log(dim(`    network: ${network}`));
  console.log("");

  // ── 2. Check if credentials already exist for this tree ─────────────────────

  const existing = readCredentials();
  if (existing.trees[treeId]) {
    const address = (() => {
      try {
        const kp = existing.trees[treeId].privateKey.startsWith("suiprivkey")
          ? Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(existing.trees[treeId].privateKey).secretKey)
          : Ed25519Keypair.fromSecretKey(Uint8Array.from(Buffer.from(existing.trees[treeId].privateKey, "hex")));
        return kp.toSuiAddress();
      } catch { return "unknown"; }
    })();

    console.log(chalk.yellow("  ⚠  Credentials already exist for this tree on this machine."));
    console.log(dim(`     Sui address: ${address}`));
    console.log("");

    const action = await select({
      message: "What would you like to do?",
      choices: [
        { value: "keep",    name: "Keep existing credentials  " + dim("(recommended)") },
        { value: "replace", name: "Generate new credentials    " + dim("(replaces the old ones)") },
      ],
    });
    if (action === "keep") {
      console.log("");
      console.log(dim("  No changes made. Run `memfork doctor` to verify your access."));
      console.log("");
      return;
    }
    console.log("");
  }

  // ── 3. Generate Sui keypair ──────────────────────────────────────────────────

  step(1, 2, "Generating Sui keypair");
  const keypair    = new Ed25519Keypair();
  const privateKey = keypair.getSecretKey();
  const address    = keypair.toSuiAddress();
  done();
  console.log(dim(`       address: ${address}`));

  // ── 4. Generate MemWal delegate key ─────────────────────────────────────────

  step(2, 2, "Generating MemWal delegate key");
  const delegate = await generateDelegateKey();
  done();
  console.log(dim(`       pubkey:  ${Buffer.from(delegate.publicKey).toString("hex").slice(0, 32)}…`));

  // ── 5. Save credentials ──────────────────────────────────────────────────────

  const creds = readCredentials();
  creds.trees[treeId] = {
    privateKey,
    memwalAccountId: "", // populated after the owner grants access
    memwalKey:       delegate.privateKey,
  };
  if (!creds.default) creds.default = treeId;
  writeCredentials(creds);

  // ── 6. Instructions for owner ────────────────────────────────────────────────

  console.log("");
  console.log(ok("Credentials saved to ~/.memfork/credentials.json"));
  console.log("");
  console.log("  " + chalk.bold("Next: share these two commands with the tree owner"));
  console.log("");

  console.log(
    "  " + dim("① Grant you on-chain access (lets you branch, propose merges):"),
  );
  console.log(
    "    " + chalk.cyan(`memfork grant --agent ${address}`),
  );
  console.log("");

  console.log(
    "  " + dim("② Register your MemWal key (lets you read/write branch memory):"),
  );
  console.log(
    "    " + chalk.cyan(`memfork grant-memwal --agent ${address} --pubkey ${Buffer.from(delegate.publicKey).toString("hex")}`),
  );
  console.log("");
  console.log(
    "  " + dim("Or send the owner this full block to copy-paste:"),
  );
  console.log(
    chalk.dim("  ─────────────────────────────────────────────────────────────"),
  );
  console.log(`  memfork grant --agent ${address}`);
  console.log(`  memfork grant-memwal --agent ${address} --pubkey ${Buffer.from(delegate.publicKey).toString("hex")}`);
  console.log(
    chalk.dim("  ─────────────────────────────────────────────────────────────"),
  );
  console.log("");

  console.log("  " + dim("Once the owner has run both commands, verify your access:"));
  console.log("    " + tip("memfork doctor"));
  console.log("");

  console.log(
    chalk.dim("  Note: the MemWal account ID will be filled in automatically\n") +
    chalk.dim("  when you run `memfork doctor` after access is granted.\n"),
  );
}
