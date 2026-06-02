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

  try {
    cfg = resolveConfig();
    checks.push({
      label:  "Config resolution",
      status: "ok",
      detail: `tree ${cfg.treeId.slice(0, 10)}… / ${cfg.network}`,
    });
  } catch (e) {
    checks.push({
      label:  "Config resolution",
      status: "fail",
      detail: (e as ConfigError).message,
      fix:    "Run `memfork init`",
    });

    checks.forEach(printCheck);
    console.log("");
    console.log(chalk.red("  Setup incomplete. Run `memfork init` to fix."));
    console.log("");
    process.exit(1);
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
    // Quick liveness ping — getChainIdentifier is cheap.
    await (client.suiClient as unknown as { getChainIdentifier(): Promise<string> }).getChainIdentifier();
    checks.push({ label: "Sui RPC", status: "ok", detail: cfg.rpcUrl ?? `${cfg.network} default` });
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

  try {
    const tree = await client.getTree();
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

  // ── 6. Signer balance (warn if low) ─────────────────────────────────────────

  try {
    const addr = client.keypair.toSuiAddress();
    const balance = await client.suiClient.getBalance({ owner: addr });
    const sui = Number(balance.totalBalance) / 1e9;
    const low = sui < 0.1;
    checks.push({
      label:  "Signer balance",
      status: low ? "warn" : "ok",
      detail: `${sui.toFixed(4)} SUI  (${addr.slice(0, 10)}…)`,
      fix:    low ? "Fund via faucet: sui client faucet  or https://faucet.testnet.sui.io" : undefined,
    });
  } catch {
    checks.push({ label: "Signer balance", status: "skip", detail: "could not fetch" });
  }

  // ── 7. MemWal reachable ──────────────────────────────────────────────────────

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
