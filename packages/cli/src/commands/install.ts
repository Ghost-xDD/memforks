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
import { execSync } from "node:child_process";
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

  // ── 2. Codex plugin — build marketplace layout + register + install ───────
  //
  // Codex uses a marketplace model. We copy the plugin source into
  // ~/.memfork/codex-plugin/ (a global location so it works from any project),
  // register it as a local marketplace, then install memforks@memforks.
  // The user runs nothing extra.

  const marketplaceDst = path.join(os.homedir(), ".memfork", "codex-plugin");
  const pluginSrc      = path.join(PLUGIN_ROOT, "codex");

  copyDir(pluginSrc, marketplaceDst);
  console.log(ok(`Plugin files: ${dim(marketplaceDst)}`));

  // Register marketplace (idempotent — Codex no-ops if already added).
  try {
    execSync(`codex plugin marketplace add ${JSON.stringify(marketplaceDst)} --json`, {
      stdio: "pipe",
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Codex exits non-zero when the marketplace is already registered.
    if (!msg.includes("already")) {
      console.log(warn(`Marketplace registration failed: ${msg}`));
      console.log(dim(`    Run manually: codex plugin marketplace add ~/.memfork/codex-plugin`));
    }
  }

  // Install / upgrade the plugin (idempotent).
  try {
    execSync(`codex plugin add memforks@memforks --json`, { stdio: "pipe" });
    console.log(ok("Plugin:     memforks@memforks  (installed)"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Already installed at the same version is not a real error.
    if (msg.includes("already")) {
      console.log(ok("Plugin:     memforks@memforks  (up to date)"));
    } else {
      console.log(warn(`Plugin install failed: ${msg}`));
      console.log(dim(`    Run manually: codex plugin add memforks@memforks`));
    }
  }

  // ── 3. Project-scoped Codex config (.codex/config.toml) ──────────────────
  //
  // Codex defaults to read-only sandbox, which blocks `memfork commit` (it
  // needs to write ~/.memfork/ and hit the network). A project-level override
  // turns on workspace-write + network without touching the user's global
  // Codex config or any other project.

  const projectCodexDir = path.join(cwd, ".codex");
  const projectCodexCfg = path.join(projectCodexDir, "config.toml");
  fs.mkdirSync(projectCodexDir, { recursive: true });

  const sandboxBlock = `# Written by memfork install codex
# workspace-write + network_access lets the agent run \`memfork commit\`
# without escalation prompts, scoped to this project only.
sandbox_mode = "workspace-write"

[sandbox_workspace_write]
network_access = true
`;

  if (!fs.existsSync(projectCodexCfg)) {
    fs.writeFileSync(projectCodexCfg, sandboxBlock, "utf8");
    console.log(ok(`Sandbox:    ${dim(projectCodexCfg)}  (workspace-write + network)`));
  } else {
    // File already exists — only patch if the keys are missing.
    const existing = fs.readFileSync(projectCodexCfg, "utf8");
    let patched = existing;
    if (!existing.includes("sandbox_mode")) {
      patched += "\n" + sandboxBlock;
      fs.writeFileSync(projectCodexCfg, patched, "utf8");
      console.log(ok(`Sandbox:    ${dim(projectCodexCfg)}  (patched workspace-write + network)`));
    } else {
      console.log(ok(`Sandbox:    ${dim(projectCodexCfg)}  (already configured)`));
    }
  }

  // ── Summary (Codex) ────────────────────────────────────────────────────────
  console.log("");
  console.log(tip("The agent now has:"));
  console.log(dim("    memwal_recall          — semantic memory recall via MemWal MCP"));
  console.log(dim("    memfork commit / merge — the only write path: MemWal + on-chain anchor"));
  console.log("");
  console.log(dim("    Raw MemWal writes (remember / remember_bulk / analyze) are disabled"));
  console.log(dim("    so every saved memory is anchored on Sui. Want raw, unanchored notes?"));
  console.log(dim("    Install the standalone MemWal plugin alongside MemForks."));
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

  // `disabled_tools` denies the raw MemWal write tools so the agent cannot
  // bypass the on-chain DAG. All persistence is forced through `memfork commit`
  // (which writes MemWal *and* anchors on Sui). Recall + health + restore stay
  // enabled and are auto-approved (read-only / diagnostic — no approval needed).
  // Users who want raw, unanchored memory can install the standalone MemWal
  // plugin instead.
  const block = `
[mcp_servers.memwal]
url = "${creds.relayerUrl}"
http_headers = { Authorization = "Bearer ${creds.delegateKey}", x-memwal-account-id = "${creds.accountId}" }
disabled_tools = ["memwal_remember", "memwal_remember_bulk", "memwal_analyze"]
default_tools_approval_mode = "auto"
`;

  if (existing.includes("[mcp_servers.memwal]")) {
    // Replace the existing block — from the header through every following line
    // that is NOT a new TOML table header (`[...]` at line start). This keeps
    // inline arrays like `disabled_tools = [...]` intact instead of truncating
    // at the first `[`.
    existing = existing.replace(
      /^\[mcp_servers\.memwal\]\n(?:(?!\[)[^\n]*\n?)*/m,
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
