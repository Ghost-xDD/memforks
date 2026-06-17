/**
 * `memfork install <target>`
 *
 * Installs MemForks into an IDE client. Two responsibilities:
 *
 *   1. Configure the MemWal MCP server (Streamable HTTP) using the credentials
 *      that `memfork init` already provisioned — no browser login needed.
 *
 *   2. Install the MemForks rule/skill that tells the agent:
 *        - use memwal_recall / memwal_remember for memory (via MCP)
 *        - use memfork commit / merge for the on-chain DAG
 *
 * Targets:
 *   cursor   — ~/.cursor/mcp.json  +  .cursor/rules/memforks.mdc
 *   codex    — ~/.codex/config.toml  +  installs plugin into this project
 */

import chalk from "chalk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readCredentials, readProjectConfig, MEMWAL_CONSTANTS } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// dist/commands/install.js → dist/ → package root → plugins/
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "plugins");

function ok(s: string)   { return chalk.green("✓") + " " + s; }
function warn(s: string) { return chalk.yellow("⚠") + " " + s; }
function tip(s: string)  { return chalk.cyan("→") + " " + s; }
function dim(s: string)  { return chalk.dim(s); }

// ─── Shared: resolve MCP credentials ─────────────────────────────────────────

interface McpCreds {
  relayerUrl:  string;
  accountId:   string;
  delegateKey: string;
}

function resolveMcpCreds(): McpCreds | null {
  const project = readProjectConfig();
  if (!project) return null;

  if (!project.treeId) return null;

  const creds = readCredentials();
  const tree  = creds.trees[project.treeId];
  if (!tree?.memwalAccountId || !tree?.memwalKey) return null;

  const rawNetwork = project.network ?? "mainnet";
  const network    = (rawNetwork === "mainnet" ? "mainnet" : "testnet") as "testnet" | "mainnet";
  const relayer    = MEMWAL_CONSTANTS[network].relayer;

  return {
    relayerUrl:  relayer + "/api/mcp",
    accountId:   tree.memwalAccountId,
    delegateKey: tree.memwalKey,
  };
}

// ─── Cursor ───────────────────────────────────────────────────────────────────

function installCursor(cwd: string): void {
  console.log("");
  console.log(chalk.bold("Installing MemForks — Cursor") + dim("  →  " + cwd));
  console.log("");

  // ── 1. MemWal MCP → ~/.cursor/mcp.json ────────────────────────────────────

  const mcpJsonPath = path.join(os.homedir(), ".cursor", "mcp.json");
  const mcpCreds    = resolveMcpCreds();

  if (mcpCreds) {
    upsertCursorMcp(mcpJsonPath, mcpCreds);
    console.log(ok(`MemWal MCP: ${dim(mcpJsonPath)}`));
    console.log(dim(`    endpoint:   ${mcpCreds.relayerUrl}`));
    console.log(dim(`    account:    ${mcpCreds.accountId.slice(0, 18)}…`));
    console.log(dim(`    auth:       Bearer (delegate key)`));
  } else {
    console.log(warn("MemWal MCP skipped — run `memfork init` first to provision credentials."));
    console.log(dim("    You can manually run `memfork install cursor` again after init."));
  }

  // ── 2. Cursor rule → .cursor/rules/memforks.mdc ───────────────────────────

  const rulesDir = path.join(cwd, ".cursor", "rules");
  fs.mkdirSync(rulesDir, { recursive: true });

  const ruleSrc = path.join(PLUGIN_ROOT, "cursor", "rules", "memforks.mdc");
  const ruleDst = path.join(rulesDir, "memforks.mdc");
  fs.copyFileSync(ruleSrc, ruleDst);
  console.log(ok(`Rule:  .cursor/rules/memforks.mdc`));

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log("");
  console.log(chalk.bold("Done.") + " Restart Cursor to pick up the MCP server.");
  console.log("");
  console.log(tip("The agent now has:"));
  console.log(dim("    memwal_recall / memwal_remember  — memory storage via MemWal MCP"));
  console.log(dim("    memwal_analyze                   — extract facts from conversation"));
  console.log(dim("    memfork commit / merge           — on-chain DAG anchoring"));
  console.log("");
  console.log(tip("memfork doctor   — verify the full setup"));
  console.log(tip("memfork status   — show current memory tree"));
  console.log("");
}

function upsertCursorMcp(mcpJsonPath: string, creds: McpCreds): void {
  fs.mkdirSync(path.dirname(mcpJsonPath), { recursive: true });

  let config: Record<string, unknown> = {};
  if (fs.existsSync(mcpJsonPath)) {
    try {
      config = JSON.parse(fs.readFileSync(mcpJsonPath, "utf8")) as Record<string, unknown>;
    } catch { /* start fresh if corrupt */ }
  }

  const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;

  mcpServers["memwal"] = {
    url: creds.relayerUrl,
    headers: {
      "Authorization":        `Bearer ${creds.delegateKey}`,
      "x-memwal-account-id":  creds.accountId,
    },
  };

  config.mcpServers = mcpServers;
  fs.writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

// ─── Codex ────────────────────────────────────────────────────────────────────

function installCodex(cwd: string): void {
  console.log("");
  console.log(chalk.bold("Installing MemForks — Codex") + dim("  →  " + cwd));
  console.log("");

  // ── 1. MemWal MCP → ~/.codex/config.toml ─────────────────────────────────

  const configTomlPath = path.join(os.homedir(), ".codex", "config.toml");
  const mcpCreds       = resolveMcpCreds();

  if (mcpCreds) {
    upsertCodexMcp(configTomlPath, mcpCreds);
    console.log(ok(`MemWal MCP: ${dim(configTomlPath)}`));
    console.log(dim(`    endpoint:   ${mcpCreds.relayerUrl}`));
    console.log(dim(`    account:    ${mcpCreds.accountId.slice(0, 18)}…`));
  } else {
    console.log(warn("MemWal MCP skipped — run `memfork init` first to provision credentials."));
  }

  // ── 2. Codex plugin (skills + metadata) ──────────────────────────────────

  const pluginSrc = path.join(PLUGIN_ROOT, "codex");
  const pluginDst = path.join(cwd, ".codex-plugin");

  copyDir(pluginSrc, pluginDst);
  console.log(ok("Plugin: .codex-plugin/  (skills + plugin.json)"));

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log("");
  console.log(chalk.bold("Done."));
  console.log("");
  console.log(tip("Register the plugin in Codex:"));
  console.log(dim("    codex plugin add .codex-plugin"));
  console.log("");
  console.log(tip("The agent now has:"));
  console.log(dim("    memwal_recall / memwal_remember  — memory storage via MemWal MCP"));
  console.log(dim("    memwal_analyze                   — extract facts from conversation"));
  console.log(dim("    memfork commit / merge           — on-chain DAG anchoring"));
  console.log("");
  console.log(tip("memfork doctor   — verify the full setup"));
  console.log("");
}

function upsertCodexMcp(tomlPath: string, creds: McpCreds): void {
  fs.mkdirSync(path.dirname(tomlPath), { recursive: true });

  // Read existing TOML as raw text — we do minimal surgery to avoid
  // a full TOML parser dependency. We look for an existing [mcp_servers.memwal]
  // block and replace it, or append if absent.
  let existing = "";
  if (fs.existsSync(tomlPath)) {
    existing = fs.readFileSync(tomlPath, "utf8");
  }

  const block = `
[mcp_servers.memwal]
transport = "http"
url = "${creds.relayerUrl}"
headers = { Authorization = "Bearer ${creds.delegateKey}", x-memwal-account-id = "${creds.accountId}" }
`;

  if (existing.includes("[mcp_servers.memwal]")) {
    // Replace the existing block — find from the header to the next blank line / EOF.
    existing = existing.replace(
      /\[mcp_servers\.memwal\][^\[]*/s,
      block.trimStart(),
    );
  } else {
    existing = existing.trimEnd() + "\n" + block;
  }

  fs.writeFileSync(tomlPath, existing, "utf8");
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function cmdInstall(target: string): void {
  const cwd = process.cwd();
  switch (target.toLowerCase()) {
    case "cursor": installCursor(cwd); break;
    case "codex":  installCodex(cwd);  break;
    default:
      console.error(chalk.red(`Unknown install target: ${target}`));
      console.error("Available targets: cursor, codex");
      process.exit(1);
  }
}
