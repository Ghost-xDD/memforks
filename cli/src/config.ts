/**
 * Layered config resolver.
 *
 * Layer 1 (lowest priority) — project-local, committable:
 *   .memfork/config.json   { treeId, network, defaultBranch, rpcUrl, packageId }
 *
 * Layer 2 — user-global, secrets, never committed (chmod 600):
 *   ~/.memfork/credentials.json
 *   {
 *     "default": "<treeId>",                     // which tree to use when none specified
 *     "trees": {
 *       "<treeId>": {
 *         "privateKey": "suiprivkey1...",
 *         "memwalAccountId": "0x...",
 *         "memwalKey": "<64-char-hex>"
 *       }
 *     }
 *   }
 *
 * Layer 3 (highest priority) — env var overrides for CI / headless use:
 *   MEMFORK_TREE_ID, MEMFORK_PRIVATE_KEY, MEMFORK_MEMWAL_ACCOUNT, MEMFORK_MEMWAL_KEY
 *
 * Plugins and hooks call the CLI binary and never read credentials themselves.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Schema ───────────────────────────────────────────────────────────────────

export interface ProjectConfig {
  /** Sui MemoryTree object ID. */
  treeId?: string;
  /** Sui network. Default: "testnet". */
  network?: "testnet" | "mainnet" | "devnet" | "localnet";
  /** Default branch name. Default: "main". */
  defaultBranch?: string;
  /** Override Sui RPC URL. */
  rpcUrl?: string;
  /** Override package ID (post-upgrade). */
  packageId?: string;
}

export interface TreeCredential {
  /** Ed25519 private key in bech32 suiprivkey1… format. */
  privateKey: string;
  /** MemWal account object ID. */
  memwalAccountId: string;
  /** MemWal delegate key (64-char hex). */
  memwalKey: string;
  /** Optional MemWal relayer URL override. */
  memwalRelayer?: string;
}

export interface CredentialsFile {
  /** treeId of the tree to use when no project config is present. */
  default?: string;
  trees: Record<string, TreeCredential>;
}

/** Fully resolved, ready-to-use config for a single tree. */
export interface ResolvedConfig {
  treeId: string;
  privateKey: string;
  memwalAccountId: string;
  memwalKey: string;
  memwalRelayer: string;
  network: "testnet" | "mainnet" | "devnet" | "localnet";
  defaultBranch: string;
  rpcUrl?: string;
  packageId?: string;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const DEFAULT_RELAYER = "https://relayer.staging.memwal.ai";

export function projectConfigPath(cwd = process.cwd()): string {
  return path.join(cwd, ".memfork", "config.json");
}

/**
 * Walk up the directory tree from `cwd` looking for a `.memfork/config.json`,
 * just like git looks for `.git`. Returns the first one found, or null.
 */
function findProjectConfigPath(cwd = process.cwd()): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, ".memfork", "config.json");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

export function credentialsPath(): string {
  return path.join(os.homedir(), ".memfork", "credentials.json");
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

export function readProjectConfig(cwd = process.cwd()): ProjectConfig | null {
  const p = findProjectConfigPath(cwd);
  if (!p) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as ProjectConfig;
  } catch {
    return null;
  }
}

export function readCredentials(): CredentialsFile {
  const p = credentialsPath();
  if (!fs.existsSync(p)) return { trees: {} };
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as CredentialsFile;
  } catch {
    return { trees: {} };
  }
}

// ─── Write helpers ────────────────────────────────────────────────────────────

export function writeProjectConfig(cfg: ProjectConfig, cwd = process.cwd()): void {
  const root = findGitRoot(cwd) ?? cwd;
  const dir  = path.join(root, ".memfork");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, ".memfork", "config.json"), JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

function findGitRoot(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function writeCredentials(creds: CredentialsFile): void {
  const dir = path.join(os.homedir(), ".memfork");
  fs.mkdirSync(dir, { recursive: true });
  const p = credentialsPath();
  fs.writeFileSync(p, JSON.stringify(creds, null, 2) + "\n", "utf8");
  // 600: owner read+write only — no other users can read private keys.
  fs.chmodSync(p, 0o600);
}

export function upsertCredential(treeId: string, cred: TreeCredential): void {
  const creds = readCredentials();
  creds.trees[treeId] = cred;
  if (!creds.default) creds.default = treeId;
  writeCredentials(creds);
}

export function setDefaultTree(treeId: string): void {
  const creds = readCredentials();
  creds.default = treeId;
  writeCredentials(creds);
}

// ─── Resolution ───────────────────────────────────────────────────────────────

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * Resolve the full config for a single tree, merging all three layers.
 * Throws `ConfigError` with a human-readable message if anything is missing.
 */
export function resolveConfig(opts: { treeId?: string; cwd?: string } = {}): ResolvedConfig {
  const project = readProjectConfig(opts.cwd);
  const creds   = readCredentials();
  const env     = process.env;

  // ── Resolve treeId ──────────────────────────────────────────────────────────
  const treeId =
    env["MEMFORK_TREE_ID"]   ??
    opts.treeId              ??
    project?.treeId          ??
    creds.default;

  if (!treeId) {
    throw new ConfigError(
      "No MemoryTree found. Run `memfork init` to create or link one.",
    );
  }

  // ── Resolve credentials ────────────────────────────────────────────────────
  const stored = creds.trees[treeId];

  const privateKey =
    env["MEMFORK_PRIVATE_KEY"] ??
    stored?.privateKey;

  const memwalAccountId =
    env["MEMFORK_MEMWAL_ACCOUNT"] ??
    stored?.memwalAccountId;

  const memwalKey =
    env["MEMFORK_MEMWAL_KEY"] ??
    stored?.memwalKey;

  if (!privateKey) {
    throw new ConfigError(
      `No private key for tree ${treeId}. Run \`memfork init\` or set MEMFORK_PRIVATE_KEY.`,
    );
  }
  if (!memwalAccountId) {
    throw new ConfigError(
      `No MemWal account for tree ${treeId}. Run \`memfork init\` or set MEMFORK_MEMWAL_ACCOUNT.`,
    );
  }
  if (!memwalKey) {
    throw new ConfigError(
      `No MemWal delegate key for tree ${treeId}. Run \`memfork init\` or set MEMFORK_MEMWAL_KEY.`,
    );
  }

  // ── Merge non-secret config ────────────────────────────────────────────────
  const network = (
    env["MEMFORK_NETWORK"]   ??
    project?.network         ??
    "testnet"
  ) as ResolvedConfig["network"];

  return {
    treeId,
    privateKey,
    memwalAccountId,
    memwalKey,
    memwalRelayer: stored?.memwalRelayer ?? DEFAULT_RELAYER,
    network,
    defaultBranch: project?.defaultBranch ?? "main",
    rpcUrl:    env["MEMFORK_RPC_URL"]   ?? project?.rpcUrl,
    packageId: env["MEMFORK_PACKAGE_ID"] ?? project?.packageId,
  };
}

/**
 * Build a `MemForksClientConfig` from resolved config (for SDK calls).
 * Imported by commands that need to create a MemForksClient.
 */
export function toClientConfig(r: ResolvedConfig) {
  return {
    treeId:    r.treeId,
    signer:    r.privateKey,
    network:   r.network,
    rpcUrl:    r.rpcUrl,
    packageId: r.packageId,
    memwal: {
      accountId:   r.memwalAccountId,
      delegateKey: r.memwalKey,
      serverUrl:   r.memwalRelayer,
    },
  };
}
