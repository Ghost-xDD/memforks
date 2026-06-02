/**
 * `memfork install <target>`
 *
 * Installs the MemForks plugin into the current project.
 *
 * Targets:
 *   cursor   — copies .cursor/rules/memforks.mdc + hooks
 *   codex    — prints the `codex plugin marketplace add` instruction
 */

import chalk from "chalk";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Plugin source root — relative to this compiled file (dist/commands/install.js)
const PLUGIN_ROOT = path.resolve(__dirname, "..", "..", "..", "plugins");

function ok(s: string)  { return chalk.green("✓") + " " + s; }
function tip(s: string) { return chalk.cyan("→") + " " + s; }

// ─── Cursor ───────────────────────────────────────────────────────────────────

function installCursor(cwd: string): void {
  const cursorDir  = path.join(cwd, ".cursor");
  const rulesDir   = path.join(cursorDir, "rules");
  const hooksDir   = path.join(cursorDir, "hooks");
  const hooksJson  = path.join(cursorDir, "hooks.json");
  const pluginDir  = path.join(PLUGIN_ROOT, "cursor");

  console.log("");
  console.log(chalk.bold("Installing MemForks Cursor plugin") + chalk.dim("  →  " + cwd));
  console.log("");

  // ── Rule ────────────────────────────────────────────────────────────────────
  fs.mkdirSync(rulesDir, { recursive: true });
  const ruleSrc = path.join(pluginDir, "rules", "memforks.mdc");
  const ruleDst = path.join(rulesDir, "memforks.mdc");
  fs.copyFileSync(ruleSrc, ruleDst);
  console.log(ok("Rule:  .cursor/rules/memforks.mdc"));

  // ── Hook scripts ─────────────────────────────────────────────────────────────
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const script of ["memforks-session-start.sh", "memforks-stop.sh"]) {
    const src = path.join(pluginDir, "hooks", script);
    const dst = path.join(hooksDir, script);
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
    console.log(ok(`Hook:  .cursor/hooks/${script}`));
  }

  // ── hooks.json — merge with existing ─────────────────────────────────────────
  const pluginHooks: HooksJson = JSON.parse(
    fs.readFileSync(path.join(pluginDir, "hooks", "hooks.json"), "utf8"),
  );

  let merged: HooksJson = { version: 1, hooks: {} };
  if (fs.existsSync(hooksJson)) {
    try {
      merged = JSON.parse(fs.readFileSync(hooksJson, "utf8")) as HooksJson;
    } catch { /* start fresh if corrupt */ }
  }

  for (const [event, entries] of Object.entries(pluginHooks.hooks ?? {})) {
    merged.hooks ??= {};
    const existing = new Set((merged.hooks[event] ?? []).map((h) => h.command));
    merged.hooks[event] ??= [];
    for (const entry of entries) {
      if (!existing.has(entry.command)) {
        merged.hooks[event].push(entry);
      }
    }
  }

  fs.writeFileSync(hooksJson, JSON.stringify(merged, null, 2) + "\n", "utf8");
  console.log(ok("Hooks: .cursor/hooks.json  (merged)"));

  console.log("");
  console.log(chalk.bold("Done.") + " Restart Cursor (or it picks up hooks automatically).");
  console.log("");
  console.log(tip("memfork doctor   — verify the full setup"));
  console.log(tip("memfork status   — show current memory tree status"));
  console.log("");
}

// ─── Codex ────────────────────────────────────────────────────────────────────

function installCodex(cwd: string): void {
  // Codex plugin marketplace uses a local path reference.
  // We print the install command — Codex handles the actual installation.
  const repoRoot = findRepoRoot(cwd) ?? cwd;
  const relPath = path.relative(cwd, path.join(repoRoot, "plugins", "codex"));

  console.log("");
  console.log(chalk.bold("MemForks Codex plugin"));
  console.log("");
  console.log("Install via the Codex plugin marketplace:");
  console.log("");
  console.log(chalk.dim("  # From inside Codex:"));
  console.log(`  codex plugin marketplace add ${relPath}`);
  console.log("");
  console.log("Or via the marketplace.json at the repo root:");
  console.log(chalk.dim("  # Codex Settings → Plugins → Add from local path"));
  console.log("");
  console.log(tip("After installing, restart the Codex session — memory recall starts immediately."));
  console.log("");
}

// ─── Command ──────────────────────────────────────────────────────────────────

export function cmdInstall(target: string): void {
  const cwd = process.cwd();

  switch (target.toLowerCase()) {
    case "cursor":
      installCursor(cwd);
      break;
    case "codex":
      installCodex(cwd);
      break;
    default:
      console.error(chalk.red(`Unknown install target: ${target}`));
      console.error("Available targets: cursor, codex");
      process.exit(1);
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface HookEntry { command: string; timeout?: number; loop_limit?: number; }
interface HooksJson { version: number; hooks: Record<string, HookEntry[]>; }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findRepoRoot(cwd: string): string | null {
  let dir = cwd;
  while (dir !== path.parse(dir).root) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    dir = path.dirname(dir);
  }
  return null;
}
