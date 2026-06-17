import { cpSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Root plugins/ is the single source of truth (also referenced by tests/ and
// .agents/plugins/marketplace.json). We copy it into the package at build time
// so it ships in the npm tarball without being hand-maintained in two places.
const here = path.dirname(fileURLToPath(import.meta.url));
const src  = path.resolve(here, "..", "..", "..", "plugins");
const dst  = path.resolve(here, "..", "plugins");

rmSync(dst, { recursive: true, force: true });
cpSync(src, dst, { recursive: true });
console.log(`copied plugins: ${src} → ${dst}`);
