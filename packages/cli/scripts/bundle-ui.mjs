/**
 * bundle-ui.mjs — build apps/visualizer and copy the output into packages/cli/ui/
 *
 * Run automatically as part of `npm run build`.
 * The resulting packages/cli/ui/ directory is included in the npm tarball so
 * `memfork ui` works for users who installed @memfork/cli globally from npm,
 * not just from the monorepo source.
 */

import { execSync }          from "node:child_process";
import { cpSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath }     from "node:url";
import path                  from "node:path";

const here      = path.dirname(fileURLToPath(import.meta.url));
const repoRoot  = path.resolve(here, "..", "..", "..");
const vizDir    = path.resolve(repoRoot, "apps", "visualizer");
const vizDist   = path.resolve(vizDir, "dist");
const pkgUiDir  = path.resolve(here, "..", "ui");

if (!existsSync(vizDir + "/package.json")) {
  console.log("bundle-ui: apps/visualizer not found — skipping (monorepo only)");
  process.exit(0);
}

console.log("bundle-ui: building apps/visualizer…");
execSync("npm run build", { cwd: vizDir, stdio: "inherit" });

console.log("bundle-ui: copying dist → packages/cli/ui/…");
rmSync(pkgUiDir, { recursive: true, force: true });
cpSync(vizDist, pkgUiDir, { recursive: true });

console.log(`bundle-ui: done  (${pkgUiDir})`);
