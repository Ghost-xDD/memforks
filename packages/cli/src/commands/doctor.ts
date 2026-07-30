/**
 * `memfork doctor`
 *
 * Verifies the full setup end-to-end:
 *   ✓ / ✗  .memfork/config.json exists
 *   ✓ / ✗  credentials file exists and is chmod 600
 *   ✓ / ✗  Sui RPC reachable
 *   ✓ / ✗  MemoryTree object found on-chain
 *   ✓ / ✗  Signer address matches tree owner (or has delegate)
 *   ✓ / ✗  MemWal account reachable
 */

import chalk from "chalk";
import fs from "node:fs";
import {
  resolveConfig,
  readProjectConfig,
  readCredentials,
  writeCredentials,
  credentialsPath,
  type ConfigError,
} from "../config.js";
import { MemForksClient } from "@memfork/core";

type CheckStatus = "ok" | "fail" | "warn" | "skip";

interface Check {
  label: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

function icon(s: CheckStatus): string {
  return { ok: chalk.green("✓"), fail: chalk.red("✗"), warn: chalk.yellow("⚠"), skip: chalk.dim("·") }[s];
}

function printCheck(c: Check): void {
  console.log(`  ${icon(c.status)}  ${c.label}` + (c.detail ? chalk.dim("  — " + c.detail) : ""));
  if (c.fix && c.status !== "ok" && c.status !== "skip") {
    console.log(`      ${chalk.cyan("→")} ${c.fix}`);
  }
}

export async function cmdDoctorEnv(): Promise<void> {
  let cfg;
  try {
    cfg = resolveConfig();
  } catch (e) {
    console.error(chalk.red("✗  Could not resolve config: " + (e as Error).message));
    console.error(chalk.dim("   Run `memfork init` first."));
    process.exit(1);
  }

  console.log("");
  console.log(chalk.dim("# MemForks environment variables — paste into .env.local"));
  console.log(chalk.yellow("# Keep these private. Do not commit or share this output."));
  console.log("");
  console.log(`MEMFORK_TREE_ID=${cfg.treeId}`);
  console.log(`MEMFORK_PRIVATE_KEY=${cfg.privateKey}`);
  console.log(`MEMFORK_MEMWAL_ACCOUNT=${cfg.memwalAccountId}`);
  console.log(`MEMFORK_MEMWAL_KEY=${cfg.memwalKey}`);
  console.log(`MEMFORK_NETWORK=${cfg.network}`);
  if (cfg.rpcUrl)    console.log(`MEMFORK_RPC_URL=${cfg.rpcUrl}`);
  if (cfg.packageId) console.log(`MEMFORK_PACKAGE_ID=${cfg.packageId}`);
  console.log("");
}

export async function cmdDoctor(): Promise<void> {
  console.log("");
  console.log(chalk.bold("memfork doctor"));
  console.log("");

  const checks: Check[] = [];
  let cfg;

  // ── 1. Project config ──────────────────────────────────────────────────────

  const project = readProjectConfig();
  checks.push({
    label:  ".memfork/config.json",
    status: project ? "ok" : "warn",
    detail: project ? `tree: ${project.treeId?.slice(0, 10)}…` : "not found (credentials-only mode)",
    fix:    project ? undefined : "Run `memfork init` from the project root to create it",
  });

  // ── 2. Credentials file ─────────────────────────────────────────────────────

  const credsPath = credentialsPath();
  const credsExists = fs.existsSync(credsPath);
  let credsPerms = "skip";
  if (credsExists) {
    const mode = fs.statSync(credsPath).mode & 0o777;
    credsPerms = (mode === 0o600) ? "ok" : "warn";
  }

  checks.push({
    label:  "~/.memfork/credentials.json",
    status: credsExists ? (credsPerms === "ok" ? "ok" : "warn") : "fail",
    detail: credsExists ? (credsPerms === "ok" ? "chmod 600 ✓" : "permissions too open") : "not found",
    fix:    credsExists
      ? "Run: chmod 600 ~/.memfork/credentials.json"
      : "Run `memfork init` to create it",
  });

  // ── 3. Config resolution ────────────────────────────────────────────────────
  //
  // Special case: after `memfork join` the memwalAccountId in credentials is
  // empty (""). The tree object on-chain carries the correct account ID in its
  // `memwal_account` field. Auto-populate it here so the rest of the checks
  // proceed without asking the user to run `memfork init`.

  try {
    cfg = resolveConfig();
    checks.push({
      label:  "Config resolution",
      status: "ok",
      detail: `tree ${cfg.treeId.slice(0, 10)}… / ${cfg.network}`,
    });
  } catch (e) {
    const msg = (e as ConfigError).message ?? "";
    const isMissingMemwal = msg.includes("No MemWal account");

    if (!isMissingMemwal) {
      checks.push({
        label:  "Config resolution",
        status: "fail",
        detail: msg,
        fix:    "Run `memfork init`",
      });
      checks.forEach(printCheck);
      console.log("");
      console.log(chalk.red("  Setup incomplete. Run `memfork init` to fix."));
      console.log("");
      process.exit(1);
    }

    // Missing memwalAccountId — attempt to fetch it from the on-chain tree.
    process.stdout.write(chalk.dim("  Fetching MemWal account ID from on-chain tree…  "));
    try {
      const partialCreds = readCredentials();
      const project      = readProjectConfig();
      const treeId       = project?.treeId ?? partialCreds.default;
      if (!treeId) throw new Error("no treeId");

      const stored    = partialCreds.trees[treeId];
      const network   = (project?.network ?? "mainnet") as "mainnet" | "testnet" | "devnet" | "localnet";
      const tmpClient = await MemForksClient.connect({
        treeId,
        signer:    stored.privateKey,
        network,
        packageId: project?.packageId,
      });
      const tree = await tmpClient.getTree();
      const accountId = (tree as unknown as { memwal_account: string }).memwal_account;
      if (!accountId) throw new Error("memwal_account not found on tree object");

      partialCreds.trees[treeId] = { ...stored, memwalAccountId: accountId };
      writeCredentials(partialCreds);
      console.log(chalk.green("done"));
      console.log(chalk.dim(`    auto-populated memwalAccountId: ${accountId.slice(0, 10)}…`));
      console.log("");

      cfg = resolveConfig();
      checks.push({
        label:  "Config resolution",
        status: "ok",
        detail: `tree ${cfg.treeId.slice(0, 10)}… / ${cfg.network}  (memwalAccountId auto-populated)`,
      });
    } catch (inner) {
      console.log(chalk.red("failed"));
      checks.push({
        label:  "Config resolution",
        status: "fail",
        detail: msg,
        fix:    "Run `memfork init`",
      });
      checks.push({
        label:  "MemWal account auto-populate",
        status: "fail",
        detail: String(inner),
        fix:    "Ask the tree owner to run `memfork grant-memwal` first, then re-run `memfork doctor`",
      });
      checks.forEach(printCheck);
      console.log("");
      console.log(chalk.red("  Setup incomplete."));
      console.log("");
      process.exit(1);
    }
  }

  // ── 4. Sui RPC reachable ────────────────────────────────────────────────────

  let client: MemForksClient;
  try {
    client = await MemForksClient.connect({
      treeId:    cfg.treeId,
      signer:    cfg.privateKey,
      network:   cfg.network,
      rpcUrl:    cfg.rpcUrl,
      packageId: cfg.packageId,
    });
    // Quick liveness ping via gRPC (JSON-RPC is disabled on Foundation fullnodes).
    await client.suiClient.getReferenceGasPrice();
    checks.push({ label: "Sui RPC", status: "ok", detail: cfg.rpcUrl ?? `${cfg.network} default (gRPC)` });
  } catch (e) {
    checks.push({
      label:  "Sui RPC",
      status: "fail",
      detail: String(e),
      fix:    "Check your network connection or set a custom MEMFORK_RPC_URL",
    });
    checks.forEach(printCheck);
    console.log("");
    process.exit(1);
  }

  // ── 5. MemoryTree on-chain ──────────────────────────────────────────────────

  let treeOwner: string | undefined;
  try {
    const tree = await client.getTree();
    treeOwner = (tree as unknown as { owner: string }).owner;
    checks.push({
      label:  "MemoryTree on-chain",
      status: "ok",
      detail: `default branch: ${(tree as unknown as { default_branch: string }).default_branch}`,
    });
  } catch (e) {
    checks.push({
      label:  "MemoryTree on-chain",
      status: "fail",
      detail: `object not found: ${cfg.treeId.slice(0, 10)}…`,
      fix:    "Check the treeId in .memfork/config.json or run `memfork init`",
    });
  }

  // ── 6. Signer role (owner vs delegate) ──────────────────────────────────────

  const signerAddr = client.keypair.toSuiAddress();

  if (treeOwner) {
    if (signerAddr === treeOwner) {
      checks.push({
        label:  "Signer role",
        status: "ok",
        detail: `owner  (${signerAddr.slice(0, 10)}…)`,
      });
    } else {
      // Look for a DelegateCap owned by this signer for this tree.
      try {
        if (!cfg.packageId) throw new Error("packageId unknown");
        const capType = `${cfg.packageId}::tree::DelegateCap`;
        const owned = await client.suiClient.listOwnedObjects({
          owner: signerAddr,
          type: capType,
          include: { json: true },
        });

        const cap = owned.objects.find((o) => {
          const f = o.json as Record<string, unknown> | null | undefined;
          return f?.["tree_id"] === cfg.treeId && !f?.["revoked"];
        });

        if (cap?.json) {
          const f = cap.json as Record<string, unknown>;
          const raw = Number(f["permissions"] ?? 0);
          const labels: string[] = [];
          if (raw & 0x01) labels.push("READ");
          if (raw & 0x02) labels.push("WRITE");
          if (raw & 0x04) labels.push("FORK");
          if (raw & 0x08) labels.push("MERGE");
          if (raw & 0x10) labels.push("PROPOSE");
          checks.push({
            label:  "Signer role",
            status: "ok",
            detail: `delegate · ${labels.join(" · ") || "no permissions"}  (${signerAddr.slice(0, 10)}…)`,
          });
        } else {
          checks.push({
            label:  "Signer role",
            status: "warn",
            detail: `no delegate cap found for this tree  (${signerAddr.slice(0, 10)}…)`,
            fix:    "Ask the tree owner to run: memfork grant " + signerAddr,
          });
        }
      } catch {
        checks.push({
          label:  "Signer role",
          status: "skip",
          detail: "could not query delegate cap",
        });
      }
    }
  }

  // ── 7. Signer balance (warn if low) ─────────────────────────────────────────

  try {
    const addr = client.keypair.toSuiAddress();
    const balance = await client.suiClient.getBalance({ owner: addr });
    const sui = Number(balance.balance.balance) / 1e9;
    const low = sui < 0.1;
    checks.push({
      label:  "Signer balance",
      status: low ? "warn" : "ok",
      detail: `${sui.toFixed(4)} SUI  (${addr.slice(0, 10)}…)`,
      fix:    low ? (cfg.network === "mainnet" ? "Gas is sponsored — no SUI needed. If you need a balance, send SUI to the address above." : "Fund via faucet: sui client faucet  or https://faucet.testnet.sui.io") : undefined,
    });
  } catch {
    checks.push({ label: "Signer balance", status: "skip", detail: "could not fetch" });
  }

  // ── 8. MemWal reachable ──────────────────────────────────────────────────────

  try {
    const resp = await fetch(cfg.memwalRelayer + "/health", { signal: AbortSignal.timeout(5000) });
    checks.push({
      label:  "MemWal relayer",
      status: resp.ok ? "ok" : "warn",
      detail: resp.ok ? cfg.memwalRelayer : `HTTP ${resp.status}`,
      fix:    resp.ok ? undefined : "Check MEMFORK_MEMWAL_RELAYER or try again",
    });
  } catch {
    checks.push({
      label:  "MemWal relayer",
      status: "warn",
      detail: "could not reach " + cfg.memwalRelayer,
      fix:    "Check your network. MemWal read/write will be unavailable.",
    });
  }

  // ── 9. Artifact storage (optional) ──────────────────────────────────────────

  if (cfg.artifacts.enabled) {
    // Artifacts require WAL tokens. Fetch the signer's WAL coin balance.
    // The WAL package ID is identical on mainnet and testnet.
    // Source: https://docs.wal.app/docs/network-reference
    const walType = "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL";
    try {
      const addr = client.keypair.toSuiAddress();
      const walBalance = await client.suiClient.getBalance({ owner: addr, coinType: walType });
      const walAmount = Number(walBalance.balance.balance) / 1e9;
      const walLow = walAmount < 0.5;
      checks.push({
        label:  "Artifact storage (WAL balance)",
        status: walLow ? "warn" : "ok",
        detail: `${walAmount.toFixed(4)} WAL  (artifacts.enabled = true)`,
        fix:    walLow
          ? `Fund ${addr.slice(0, 10)}… with WAL on ${cfg.network}. See docs/architecture/artifacts.md.`
          : undefined,
      });
    } catch {
      checks.push({
        label:  "Artifact storage (WAL balance)",
        status: "warn",
        detail: "could not fetch WAL balance",
        fix:    "Check your Sui RPC connection.",
      });
    }
  } else {
    checks.push({
      label:  "Artifact storage",
      status: "skip",
      detail: "disabled (set artifacts.enabled = true to enable Walrus artifact persistence)",
    });
  }

  // ── Print all checks ─────────────────────────────────────────────────────────

  console.log("");
  checks.forEach(printCheck);
  console.log("");

  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;

  if (failed > 0) {
    console.log(chalk.red(`  ${failed} check(s) failed. Run \`memfork init\` to fix.`));
    process.exit(1);
  } else if (warned > 0) {
    console.log(chalk.yellow(`  ${warned} warning(s). Setup is functional but review the items above.`));
  } else {
    console.log(chalk.green("  Everything looks good."));
  }
  console.log("");
}
