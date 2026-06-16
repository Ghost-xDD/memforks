/**
 * MemForksClient — primary SDK entry point.
 *
 * Model A architecture (SPEC §8):
 *   - commit() writes an off-chain Walrus blob via memwal.remember(). No Sui tx.
 *   - A local head tracker (Map<branch, HeadEntry>) tracks the live branch tip
 *     between merges. Initialised from the on-chain settled head at connect() time.
 *   - proposeMerge() reads live blob IDs from the head tracker and passes them
 *     as explicit arguments to the on-chain propose_merge() entry function.
 *   - All other chain operations (branch, initTree, grant/revoke, merge ceremony)
 *     are unchanged in semantics; their signatures update to use blob IDs.
 *
 * Usage:
 *   const mem = await MemForksClient.connect({ treeId, signer, memwal: {...} });
 *   await mem.branch("hypothesis-a", { from: "main" });
 *   const { blobId } = await mem.commit("hypothesis-a", { facts: [...], message: "..." });
 *   const results    = await mem.recall("what did we learn?");
 */

import { SuiJsonRpcClient as SuiClient, JsonRpcHTTPTransport, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { bcs } from "@mysten/sui/bcs";
import { MemWal } from "@mysten-incubation/memwal";
import type {
  OnChainTree,
  OnChainCommit,
  OnChainMergeProposal,
  CommitPayload,
  CommitDelta,
  PermFlags,
} from "./types.js";
import { PROPOSAL_STATUS, PAYLOAD_VERSION, branchNamespace } from "./types.js";
import { resolvers } from "./resolvers.js";
import type { ResolverDef } from "./resolvers.js";

// ─── SHA-256 via Web Crypto (Node 15+ / browser) ─────────────────────────────

async function sha256Hex(input: string): Promise<string> {
  const bytes  = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Head tracker ─────────────────────────────────────────────────────────────

/**
 * Tracks the live branch tip between merges.
 *
 * blobId      — current head Walrus blob ID. Empty string = at genesis.
 * contentHash — SHA-256 of the JSON payload string we stored at this head.
 *               Used as parent_blob_hashes[0] in the next commit.
 *               Empty string = genesis (no content to hash).
 */
interface HeadEntry {
  blobId: string;
  contentHash: string;
}

// ─── Config types ─────────────────────────────────────────────────────────────

export interface MemWalConfig {
  accountId: string;
  delegateKey: string;
  serverUrl?: string;
}

export interface MemForksClientConfig {
  treeId: string;
  signer: Ed25519Keypair | string;
  memwal?: MemWalConfig;
  network?: "testnet" | "mainnet" | "devnet" | "localnet";
  rpcUrl?: string;
  packageId?: string;
  sponsorUrl?: string;
  /**
   * Object ID of a pre-created ResolverRef to use as the default for merge().
   * When set, merge() uses the governed path (proposeMerge → waitForFinalization)
   * instead of the zero-infra LastWriteWins path.
   * Readable from the MEMFORK_RESOLVER_ID env var via `memfork init` / auto-config.
   */
  defaultResolverId?: string;
}

// ─── Auto-config (reads .memfork/config.json + ~/.memfork/credentials.json) ───

/**
 * Resolve MemForksClientConfig from the three-layer config system, mirroring
 * the CLI's resolveConfig() without depending on @memfork/cli.
 *
 * Priority: env vars > ~/.memfork/credentials.json > .memfork/config.json
 *
 * Only available in Node.js environments (uses node:fs / node:os / node:path).
 */
async function resolveAutoConfig(): Promise<MemForksClientConfig> {
  // Dynamic imports so bundlers targeting browsers can tree-shake this path.
  const fs   = await import("node:fs");
  const os   = await import("node:os");
  const path = await import("node:path");

  const env = process.env;

  // ── Walk up from cwd looking for .memfork/config.json ──────────────────────
  let projectConfig: Record<string, string> = {};
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, ".memfork", "config.json");
    if (fs.existsSync(candidate)) {
      try { projectConfig = JSON.parse(fs.readFileSync(candidate, "utf8")); } catch { /* ignore */ }
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // ── Read ~/.memfork/credentials.json ───────────────────────────────────────
  let creds: Record<string, Record<string, string>> = {};
  let defaultTree: string | undefined;
  try {
    const credsPath = path.join(os.homedir(), ".memfork", "credentials.json");
    if (fs.existsSync(credsPath)) {
      const raw = JSON.parse(fs.readFileSync(credsPath, "utf8")) as {
        default?: string;
        trees?: Record<string, Record<string, string>>;
      };
      creds       = raw.trees ?? {};
      defaultTree = raw.default;
    }
  } catch { /* ignore */ }

  // ── Resolve values ──────────────────────────────────────────────────────────
  const treeId =
    env["MEMFORK_TREE_ID"] ??
    projectConfig["treeId"] ??
    defaultTree;

  if (!treeId) {
    throw new Error(
      "MemForksClient.connect(): no treeId found.\n" +
      "Run `memfork init` to create a tree, or pass treeId explicitly.",
    );
  }

  const stored = creds[treeId] ?? {};

  const privateKey =
    env["MEMFORK_PRIVATE_KEY"] ??
    stored["privateKey"];

  if (!privateKey) {
    throw new Error(
      `MemForksClient.connect(): no private key for tree ${treeId}.\n` +
      "Run `memfork init` or set MEMFORK_PRIVATE_KEY.",
    );
  }

  const memwalAccountId =
    env["MEMFORK_MEMWAL_ACCOUNT"] ??
    stored["memwalAccountId"];

  const memwalKey =
    env["MEMFORK_MEMWAL_KEY"] ??
    stored["memwalKey"];

  const network = (
    env["MEMFORK_NETWORK"] ??
    projectConfig["network"] ??
    "testnet"
  ) as MemForksClientConfig["network"];

  const resolved: MemForksClientConfig = { treeId, signer: privateKey };

  if (network)    resolved.network   = network;

  const rpcUrl     = env["MEMFORK_RPC_URL"]     ?? projectConfig["rpcUrl"];
  const packageId  = env["MEMFORK_PACKAGE_ID"]  ?? projectConfig["packageId"]
                     ?? PACKAGE_IDS[network ?? "mainnet"];
  const sponsorUrl       = env["MEMFORK_SPONSOR_URL"]   ?? projectConfig["sponsorUrl"];
  const defaultResolverId = env["MEMFORK_RESOLVER_ID"]  ?? projectConfig["resolverId"];

  if (rpcUrl)            resolved.rpcUrl            = rpcUrl;
  if (packageId)         resolved.packageId          = packageId;
  if (sponsorUrl)        resolved.sponsorUrl         = sponsorUrl;
  if (defaultResolverId) resolved.defaultResolverId  = defaultResolverId;

  if (memwalAccountId && memwalKey) {
    const serverUrl =
      env["MEMFORK_RELAYER_URL"] ??
      stored["memwalRelayer"] ??
      relayerForNetwork(network);
    resolved.memwal = { accountId: memwalAccountId, delegateKey: memwalKey, serverUrl };
  }

  return resolved;
}

// ─── Deployed constants ───────────────────────────────────────────────────────

const PACKAGE_IDS: Record<string, string> = {
  mainnet: "0x7df9719d799386d34d657c49ae8cd6f5f03b39036f7c428b556095e42afd852f",
  testnet: "0xc9f0a4964f810c794479bc5b66347998969d2c59d6797c313b8a96d2bdd6a914",
};

const DEFAULT_PACKAGE_ID = PACKAGE_IDS["mainnet"];

const RELAYER_BY_NETWORK: Record<string, string> = {
  mainnet: "https://relayer.memory.walrus.xyz",
  testnet: "https://relayer.staging.memwal.ai",
};

function relayerForNetwork(network: string | undefined): string {
  return RELAYER_BY_NETWORK[network ?? "mainnet"] ?? RELAYER_BY_NETWORK["mainnet"]!;
}

// ─── Client ───────────────────────────────────────────────────────────────────

export class MemForksClient {
  readonly treeId: string;
  readonly packageId: string;
  readonly suiClient: SuiClient;
  readonly keypair: Ed25519Keypair;
  readonly sponsorUrl: string | undefined;
  /** Pre-configured ResolverRef ID used by merge() when set. */
  readonly defaultResolverId: string | undefined;

  private readonly memwalKey: string | undefined;
  private readonly memwalAccountId: string | undefined;
  private readonly memwalServerUrl: string | undefined;

  // Live branch tips. Seeded from on-chain state at connect() time.
  private readonly heads = new Map<string, HeadEntry>();

  // Caches LWW resolver IDs created by merge() so we only pay createResolver
  // once per client instance rather than once per merge call.
  private readonly resolverCache = new Map<string, string>();

  private constructor(
    treeId: string,
    packageId: string,
    suiClient: SuiClient,
    keypair: Ed25519Keypair,
    memwalKey: string | undefined,
    memwalAccountId: string | undefined,
    memwalServerUrl: string | undefined,
    sponsorUrl: string | undefined,
    defaultResolverId: string | undefined,
  ) {
    this.treeId             = treeId;
    this.packageId          = packageId;
    this.suiClient          = suiClient;
    this.keypair            = keypair;
    this.memwalKey          = memwalKey;
    this.memwalAccountId    = memwalAccountId;
    this.memwalServerUrl    = memwalServerUrl;
    this.sponsorUrl         = sponsorUrl;
    this.defaultResolverId  = defaultResolverId;
  }

  // ─── Factory ──────────────────────────────────────────────────────────────

  // Overloads allow both `connect()` and `connect(cfg)` to be called from
  // consumers that import this as a package (where `cfg?` alone isn't always
  // picked up as truly optional across package boundaries).
  static async connect(): Promise<MemForksClient>;
  static async connect(cfg: MemForksClientConfig): Promise<MemForksClient>;
  static async connect(cfg?: MemForksClientConfig): Promise<MemForksClient> {
    if (!cfg) cfg = await resolveAutoConfig();
    const network   = cfg.network ?? "mainnet";
    const packageId = (cfg.packageId ?? PACKAGE_IDS[network] ?? DEFAULT_PACKAGE_ID) as string;

    let keypair: Ed25519Keypair;
    if (cfg.signer instanceof Ed25519Keypair) {
      keypair = cfg.signer;
    } else if (cfg.signer.startsWith("suiprivkey")) {
      const { secretKey } = decodeSuiPrivateKey(cfg.signer);
      keypair = Ed25519Keypair.fromSecretKey(secretKey);
    } else {
      keypair = Ed25519Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(cfg.signer, "hex")),
      );
    }

    const rpcUrl    = cfg.rpcUrl ?? getJsonRpcFullnodeUrl(network);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const suiClient = new SuiClient({ transport: new JsonRpcHTTPTransport({ url: rpcUrl }), network } as any);

    const client = new MemForksClient(
      cfg.treeId,
      packageId,
      suiClient,
      keypair,
      cfg.memwal?.delegateKey,
      cfg.memwal?.accountId,
      cfg.memwal?.serverUrl,
      cfg.sponsorUrl,
      cfg.defaultResolverId,
    );

    // Seed the head tracker from on-chain settled state (skip when treeId not yet known).
    if (cfg.treeId) await client.syncHeadsFromChain();

    return client;
  }

  // ─── Head tracker helpers ─────────────────────────────────────────────────

  /** Fetch the on-chain branches table and seed the local head tracker. */
  private async syncHeadsFromChain(): Promise<void> {
    const tree = await this.getTree();
    // tree.branches is Record<branch_name, blob_id_hex>
    // We can't reconstruct content hashes from chain state, so new sessions
    // start with empty contentHash. The hash chain is populated as new commits
    // are written in this session.
    for (const [branch, blobId] of Object.entries(tree.branches as Record<string, string>)) {
      this.heads.set(branch, { blobId: blobId ?? "", contentHash: "" });
    }
  }

  /** Get the current live head for a branch (may be ahead of the settled chain head). */
  getLocalHead(branch: string): HeadEntry | undefined {
    return this.heads.get(branch);
  }

  private setLocalHead(branch: string, entry: HeadEntry): void {
    this.heads.set(branch, entry);
  }

  // ─── PTB execution ────────────────────────────────────────────────────────

  /**
   * Core execution primitive. Handles both sponsored and self-paid paths and
   * returns the full result so callers that need objectChanges (initTree,
   * createResolver) can inspect created objects without a second RPC round-trip.
   *
   * Sponsored flow (per docs.sui.io/develop/transaction-payment/sponsor-txn):
   *   1. Client serializes the unsigned tx (no gas set).
   *   2. Sponsor adds gasOwner + gasPayment + gasBudget, signs the final bytes.
   *   3. Client signs the same final bytes (gas now embedded).
   *   4. Both sigs are submitted together via executeTransactionBlock.
   */
  private async executeWithChanges(tx: Transaction): Promise<{
    digest: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    objectChanges: any[] | undefined;
  }> {
    if (this.sponsorUrl) {
      const serialized = tx.serialize();

      const resp = await fetch(this.sponsorUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tx: serialized, sender: this.keypair.toSuiAddress() }),
      });
      if (!resp.ok) throw new Error(`Sponsor error: ${resp.status} ${await resp.text()}`);

      const { txBytes, sponsorSig } =
        await resp.json() as { txBytes: string; sponsorSig: string };

      const finalBytes = Buffer.from(txBytes, "base64");
      const userSig    = await this.keypair.signTransaction(finalBytes);

      const result = await this.suiClient.executeTransactionBlock({
        transactionBlock: txBytes,
        signature: [userSig.signature, sponsorSig],
        options: { showEffects: true, showObjectChanges: true },
      });
      if (result.effects?.status.status !== "success") {
        throw new Error(`Sponsored tx failed: ${result.effects?.status.error}`);
      }
      return { digest: result.digest, objectChanges: result.objectChanges ?? undefined };
    }

    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: this.keypair,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });
    if (result.effects?.status.status !== "success") {
      throw new Error(`Transaction failed: ${result.effects?.status.error ?? "unknown"}`);
    }
    return { digest: result.digest, objectChanges: result.objectChanges ?? undefined };
  }

  private async execute(tx: Transaction): Promise<string> {
    const { digest } = await this.executeWithChanges(tx);
    return digest;
  }

  // ─── MemWal helpers ───────────────────────────────────────────────────────

  private memwalForBranch(branch: string): MemWal {
    if (!this.memwalKey || !this.memwalAccountId) {
      throw new Error("MemWal credentials required — pass `memwal` in connect().");
    }
    return MemWal.create({
      key:       this.memwalKey,
      accountId: this.memwalAccountId,
      serverUrl: this.memwalServerUrl ?? relayerForNetwork(this.suiClient.network),
      namespace: branchNamespace(this.treeId, branch),
    });
  }

  // ─── Tree reads ───────────────────────────────────────────────────────────

  async getTree(): Promise<OnChainTree> {
    const obj = await this.suiClient.getObject({
      id: this.treeId,
      options: { showContent: true },
    });
    if (!obj.data?.content || obj.data.content.dataType !== "moveObject") {
      throw new Error(`Tree object not found: ${this.treeId}`);
    }
    return obj.data.content.fields as unknown as OnChainTree;
  }

  /**
   * Read the on-chain settled head (Walrus blob ID) for a branch.
   *
   * MemoryTree.branches is a Table<String, vector<u8>> stored as dynamic
   * fields. We must use getDynamicFieldObject — getObject showContent does
   * NOT expand table entries.
   *
   * Returns "" if the branch exists but has never been advanced by a merge.
   */
  async getBranchHead(branch: string): Promise<string> {
    const treeObj = await this.suiClient.getObject({
      id: this.treeId,
      options: { showContent: true },
    });
    if (!treeObj.data?.content || treeObj.data.content.dataType !== "moveObject") {
      throw new Error(`Tree object not found: ${this.treeId}`);
    }
    // Extract the Table's object ID from the raw fields.
    const rawFields = treeObj.data.content.fields as Record<string, unknown>;
    const branchesRaw = rawFields["branches"] as { fields?: { id?: { id?: string } } } | undefined;
    const tableId = branchesRaw?.fields?.id?.id;
    if (!tableId) {
      // Fall back to the legacy direct-map representation (older SDK versions).
      const legacyMap = rawFields["branches"] as Record<string, string> | undefined;
      return legacyMap?.[branch] ?? "";
    }

    try {
      const dynField = await this.suiClient.getDynamicFieldObject({
        parentId: tableId,
        name: { type: "0x1::string::String", value: branch },
      });
      if (!dynField.data?.content || dynField.data.content.dataType !== "moveObject") return "";
      // The table value is vector<u8> — byte array of the blob ID string.
      const valFields = dynField.data.content.fields as Record<string, unknown>;
      const bytes = valFields["value"] as number[] | string | undefined;
      if (!bytes) return "";
      if (typeof bytes === "string") return bytes;
      // Convert byte array to UTF-8 string.
      return Buffer.from(bytes).toString("utf8");
    } catch {
      // Branch not found in table = genesis.
      return "";
    }
  }

  /** Fetch a merge anchor commit by its on-chain object ID. */
  async getMergeAnchor(commitId: string): Promise<OnChainCommit> {
    const obj = await this.suiClient.getObject({
      id: commitId,
      options: { showContent: true },
    });
    if (!obj.data?.content || obj.data.content.dataType !== "moveObject") {
      throw new Error(`Commit anchor not found: ${commitId}`);
    }
    return obj.data.content.fields as unknown as OnChainCommit;
  }

  // ─── initTree() ───────────────────────────────────────────────────────────

  async initTree(
    memwalAccountId: string,
    defaultBranch = "main",
  ): Promise<{ digest: string; treeId: string }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::tree::init_tree`,
      arguments: [
        tx.pure.address(memwalAccountId),
        tx.pure.vector("u8", Array.from(Buffer.from(defaultBranch))),
        tx.object("0x6"),
      ],
    });
    tx.setGasBudget(30_000_000);

    const { digest: initDigest, objectChanges: initChanges } = await this.executeWithChanges(tx);
    const result = { digest: initDigest, objectChanges: initChanges };
    const treeChange = result.objectChanges?.find(
      c => c.type === "created" && "objectType" in c &&
           c.objectType.includes("::tree::MemoryTree"),
    );
    if (!treeChange || treeChange.type !== "created") {
      throw new Error("init_tree: MemoryTree not found in object changes");
    }

    this.setLocalHead(defaultBranch, { blobId: "", contentHash: "" });

    return { digest: result.digest, treeId: treeChange.objectId };
  }

  // ─── branch() ─────────────────────────────────────────────────────────────

  /**
   * Fork a new branch from an existing one (on-chain tx).
   * Also copies the live local head to the new branch so off-chain commits
   * made since the last merge are visible on the fork immediately.
   */
  async branch(name: string, opts: { from: string }): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::tree::branch`,
      arguments: [
        tx.object(this.treeId),
        tx.pure.vector("u8", Array.from(Buffer.from(opts.from))),
        tx.pure.vector("u8", Array.from(Buffer.from(name))),
      ],
    });
    tx.setGasBudget(30_000_000);
    const digest = await this.execute(tx);

    // Copy the live local head so the new branch inherits uncommitted off-chain history.
    const parentHead = this.heads.get(opts.from);
    this.setLocalHead(name, parentHead ? { ...parentHead } : { blobId: "", contentHash: "" });

    return digest;
  }

  // ─── commit() ─────────────────────────────────────────────────────────────

  /**
   * Write an off-chain commit as a Walrus blob via MemWal. No Sui transaction.
   *
   * Builds the SPEC §8 payload including the hash chain fields:
   *   - parent_blob_ids:   Walrus blob ID of the current branch head.
   *   - parent_blob_hashes: SHA-256 of the parent payload JSON string.
   *
   * Updates the local head tracker on success.
   */
  async commit(
    branch: string,
    opts: {
      facts: string[];
      message: string;
      delta?: Partial<CommitDelta>;
    },
  ): Promise<{ blobId: string; contentHash: string }> {
    const currentHead = this.heads.get(branch) ?? { blobId: "", contentHash: "" };

    const parentBlobIds: string[]    = currentHead.blobId    ? [currentHead.blobId]    : [];
    const parentBlobHashes: string[] = currentHead.contentHash ? [currentHead.contentHash] : [];

    const treeIdBytes    = Buffer.from(this.treeId.replace(/^0x/, ""), "hex");
    const authorBytes    = Buffer.from(this.keypair.toSuiAddress().replace(/^0x/, ""), "hex");

    const payload: CommitPayload = {
      v:                  PAYLOAD_VERSION,
      type:               "commit",
      tree:               Uint8Array.from(treeIdBytes),
      branch,
      author:             Uint8Array.from(authorBytes),
      ts_ms:              Date.now(),
      parent_blob_ids:    parentBlobIds,
      parent_blob_hashes: parentBlobHashes,
      delta: {
        facts:    opts.facts,
        ...(opts.delta?.messages && { messages: opts.delta.messages }),
        ...(opts.delta?.files    && { files:    opts.delta.files }),
      },
    };

    // Serialise to JSON for MemWal. The hash is over this exact string.
    const payloadJson = JSON.stringify(payload, (_key, value) => {
      // Uint8Array serialises as { 0: x, 1: y, ... } by default — convert to base64.
      if (value instanceof Uint8Array) {
        return Buffer.from(value).toString("base64");
      }
      return value;
    });

    // Hash the plaintext payload. The NEXT commit will include this as parent_blob_hashes[0].
    const contentHash = await sha256Hex(payloadJson);

    const branchMemwal = this.memwalForBranch(branch);
    const memResult    = await branchMemwal.rememberAndWait(payloadJson);
    const blobId       = memResult.blob_id;

    // Advance the local head.
    this.setLocalHead(branch, { blobId, contentHash });

    return { blobId, contentHash };
  }

  // ─── recall() ─────────────────────────────────────────────────────────────

  async recall(
    query: string,
    opts: { branch?: string; limit?: number } = {},
  ): Promise<Array<{ distance: number; blobId: string; text: string }>> {
    const branch       = opts.branch ?? (await this.getTree()).default_branch;
    const branchMemwal = this.memwalForBranch(branch);

    const result = await branchMemwal.recall({ query, limit: opts.limit ?? 5 });

    return result.results.map(r => ({
      distance: r.distance,
      blobId:   r.blob_id,
      text:     r.text,
    }));
  }

  // ─── grantDelegate() ──────────────────────────────────────────────────────

  async grantDelegate(
    agent: string,
    opts: {
      branches?: string[];
      perms?: PermFlags;
      expiresEpoch?: bigint;
    } = {},
  ): Promise<string> {
    const perms    = opts.perms ?? (0x02 | 0x04 | 0x10);
    const expires  = opts.expiresEpoch ?? BigInt("18446744073709551615");
    const branches = opts.branches ?? [];

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::tree::grant_delegate`,
      arguments: [
        tx.object(this.treeId),
        tx.pure.address(agent),
        tx.pure(bcs.vector(bcs.string()).serialize(branches).toBytes()),
        tx.pure.u8(perms),
        tx.pure.u64(expires),
      ],
    });
    tx.setGasBudget(15_000_000);
    return this.execute(tx);
  }

  // ─── revokeDelegate() ─────────────────────────────────────────────────────

  async revokeDelegate(agent: string): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::tree::revoke_delegate`,
      arguments: [tx.object(this.treeId), tx.pure.address(agent)],
    });
    tx.setGasBudget(10_000_000);
    return this.execute(tx);
  }

  // ─── proposeMerge() ───────────────────────────────────────────────────────

  /**
   * Open a merge proposal. Reads the live branch-tip blob IDs from the local
   * head tracker and passes them to the on-chain propose_merge() entry function.
   * These blob IDs are stored in the MergeProposal for the fast-forward guard.
   *
   * Override fromHeadBlobId / intoHeadBlobId if you need to propose from a
   * specific point in the history rather than the current live tip.
   */
  async proposeMerge(opts: {
    fromBranch: string;
    intoBranch: string;
    resolverId: string;
    ttlMs?: number;
    fromHeadBlobId?: string;
    intoHeadBlobId?: string;
  }): Promise<string> {
    const ttlMs = opts.ttlMs ?? 86_400_000;

    // The fast-forward guard in finalize_merge compares the on-chain branch head
    // (set only by previous finalize_merge calls) to what was recorded here.
    // We must pass the on-chain settled heads from the Table, NOT the local
    // MemWal commit heads. Table entries require getDynamicFieldObject.
    const [fromHead, intoHead] = await Promise.all([
      opts.fromHeadBlobId ?? this.getBranchHead(opts.fromBranch),
      opts.intoHeadBlobId ?? this.getBranchHead(opts.intoBranch),
    ]);

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::resolver::propose_merge`,
      arguments: [
        tx.object(this.treeId),
        tx.pure.vector("u8", Array.from(Buffer.from(opts.fromBranch))),
        tx.pure.vector("u8", Array.from(Buffer.from(opts.intoBranch))),
        tx.pure.vector("u8", Array.from(Buffer.from(fromHead, "utf8"))),
        tx.pure.vector("u8", Array.from(Buffer.from(intoHead, "utf8"))),
        tx.object(opts.resolverId),
        tx.pure.u64(ttlMs),
        tx.object("0x6"),
      ],
    });
    tx.setGasBudget(30_000_000);
    return this.execute(tx);
  }

  // ─── submitAttestation() ──────────────────────────────────────────────────

  async submitAttestation(opts: {
    proposalId: string;
    resolverId: string;
    attestKind: number;
    attestPayload: Uint8Array;
  }): Promise<string> {
    const pubkeyBytes = Array.from(this.keypair.getPublicKey().toRawBytes());
    const sigBytes    = Array.from(await this.keypair.sign(opts.attestPayload));

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::resolver::submit_attestation`,
      arguments: [
        tx.object(opts.proposalId),
        tx.object(opts.resolverId),
        tx.pure.u8(opts.attestKind),
        tx.pure.vector("u8", Array.from(opts.attestPayload)),
        tx.pure.vector("u8", pubkeyBytes),
        tx.pure.vector("u8", sigBytes),
      ],
    });
    tx.setGasBudget(25_000_000);
    return this.execute(tx);
  }

  // ─── finalizeMerge() ──────────────────────────────────────────────────────

  /**
   * Finalize a merge proposal. On success the contract advances the into_branch
   * head to resolved_blob_id; we also update our local head tracker accordingly.
   */
  async finalizeMerge(opts: {
    proposalId: string;
    resolverId: string;
    resolvedNamespace: string;
    resolvedBlobId: string;
    intoBranch: string;
  }): Promise<string> {
    const blobIdBytes = Array.from(Buffer.from(opts.resolvedBlobId, "utf8"));
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::resolver::finalize_merge`,
      arguments: [
        tx.object(this.treeId),
        tx.object(opts.proposalId),
        tx.object(opts.resolverId),
        tx.pure.vector("u8", Array.from(Buffer.from(opts.resolvedNamespace))),
        tx.pure.vector("u8", blobIdBytes),
        tx.object("0x6"),
      ],
    });
    tx.setGasBudget(40_000_000);
    const digest = await this.execute(tx);

    // The into_branch head is now the resolved blob. Reset the content hash since
    // we don't have the plaintext of the resolver's output to hash.
    this.setLocalHead(opts.intoBranch, { blobId: opts.resolvedBlobId, contentHash: "" });

    return digest;
  }

  // ─── merge() ──────────────────────────────────────────────────────────────

  /**
   * Merge `from` into `into`.
   *
   * **Default (no resolver configured):** LastWriteWins — self-signed, no
   * external service required. All you need are the standard `memfork init`
   * credentials. Creates a real on-chain merge anchor.
   *
   * **Governed (resolver configured):** set `MEMFORK_RESOLVER_ID` in your env
   * (or pass `opts.resolverId`) and point at a pre-created ResolverRef such as
   * a `JuryReconcile`. merge() will open the proposal and poll until the
   * resolver service finalizes it, then return. The jury path is opt-in — the
   * only change is adding one env var.
   *
   * Returns `{ digest, mergedCount, blobId, proposalId? }`.
   * `digest` is the finalize tx for LWW, empty string for governed (the
   * resolver service's tx is on-chain and visible via `proposalId`).
   * When `mergedCount === 0` no Sui txs are issued.
   */
  async merge(
    from: string,
    into: string,
    opts: {
      resolverId?: string;
      recallQueries?: string[];
      recallLimit?: number;
      timeoutMs?: number;
    } = {},
  ): Promise<{ digest: string; mergedCount: number; blobId: string; proposalId?: string }> {
    const queries = opts.recallQueries ?? [
      "facts about this project and conversation",
      "user preferences decisions and technical choices",
      "user background goals context and identity",
    ];
    const limit = opts.recallLimit ?? 10;

    // Sweep the from branch for distinct facts.
    const sweepResults = await Promise.all(
      queries.map(q => this.recall(q, { branch: from, limit }).catch(() => [])),
    );
    const seen  = new Set<string>();
    const facts: string[] = [];
    for (const batch of sweepResults) {
      for (const r of batch) {
        const key = r.text.trim().slice(0, 120);
        if (!seen.has(key)) { seen.add(key); facts.push(r.text); }
      }
    }
    if (facts.length === 0) {
      return { digest: "", mergedCount: 0, blobId: "" };
    }

    // Write the merged facts to the into branch (MemWal — no Sui tx).
    const { blobId } = await this.commit(into, {
      facts,
      message: `Merge from ${from}`,
    });

    // Resolve which path to take: governed (external resolver) or LWW (self).
    const governedResolverId = opts.resolverId ?? this.defaultResolverId;

    if (governedResolverId) {
      // ── Governed path ────────────────────────────────────────────────────
      // Propose the merge, then wait for the resolver service to finalize it.
      const proposalId = await this.proposeMerge({
        fromBranch: from,
        intoBranch: into,
        resolverId: governedResolverId,
      });
      console.log(`[memfork] merge ${from} → ${into}: proposal ${proposalId}, awaiting resolver…`);

      const { status, proposal } = await this.waitForFinalization(proposalId, {
        timeoutMs: opts.timeoutMs ?? 300_000,
      });
      if (status !== "finalized") {
        throw new Error(
          `Merge proposal ${proposalId} ended with status "${status}". ` +
          `Check that your resolver service is running and has MERGE permission on "${into}".`,
        );
      }

      const resolvedBlobId = proposal.resolved_memwal_blob_id ?? blobId;
      console.log(
        `[memfork] merge ${from} → ${into}: finalized, ${facts.length} facts, blob ${resolvedBlobId}`,
      );
      return { digest: "", mergedCount: facts.length, blobId: resolvedBlobId, proposalId };
    }

    // ── LWW self-serve path ───────────────────────────────────────────────
    // No external service needed. Propose + finalize in the same call.
    let lwwResolverId = this.resolverCache.get("lastWriteWins");
    if (!lwwResolverId) {
      const created = await this.createResolver(resolvers.lastWriteWins());
      lwwResolverId = created.resolverId;
      this.resolverCache.set("lastWriteWins", lwwResolverId);
    }

    const proposalId = await this.proposeMerge({
      fromBranch: from,
      intoBranch: into,
      resolverId: lwwResolverId,
    });
    const digest = await this.finalizeMerge({
      proposalId,
      resolverId: lwwResolverId,
      resolvedNamespace: branchNamespace(this.treeId, into),
      resolvedBlobId: blobId,
      intoBranch: into,
    });

    console.log(
      `[memfork] merge ${from} → ${into}: ${facts.length} facts, blob ${blobId}, tx ${digest}`,
    );
    return { digest, mergedCount: facts.length, blobId };
  }

  // ─── claimExpired() ───────────────────────────────────────────────────────

  async claimExpired(proposalId: string): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::resolver::claim_expired`,
      arguments: [tx.object(proposalId), tx.object("0x6")],
    });
    tx.setGasBudget(10_000_000);
    return this.execute(tx);
  }

  // ─── createResolver() ─────────────────────────────────────────────────────

  async createResolver(def: ResolverDef): Promise<{ digest: string; resolverId: string }> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::resolver::create_and_keep_resolver`,
      arguments: [
        tx.pure.u8(def.kind),
        tx.pure.vector("u8", Array.from(def.config)),
      ],
    });
    tx.setGasBudget(15_000_000);

    const { digest: resolverDigest, objectChanges: resolverChanges } = await this.executeWithChanges(tx);
    const result = { digest: resolverDigest, objectChanges: resolverChanges };
    const created = result.objectChanges?.find(
      c => c.type === "created" && "objectType" in c &&
           c.objectType.includes("::resolver::ResolverRef"),
    );
    if (!created || created.type !== "created") {
      throw new Error("createResolver: ResolverRef not found in object changes");
    }
    return { digest: result.digest, resolverId: created.objectId };
  }

  // ─── waitForFinalization() ────────────────────────────────────────────────

  async waitForFinalization(
    proposalId: string,
    opts: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<{ status: "finalized" | "aborted" | "expired"; proposal: OnChainMergeProposal }> {
    const pollMs    = opts.pollMs    ?? 3_000;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const deadline  = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const obj = await this.suiClient.getObject({
        id: proposalId,
        options: { showContent: true },
      });
      if (!obj.data?.content || obj.data.content.dataType !== "moveObject") {
        throw new Error(`Proposal not found: ${proposalId}`);
      }
      const proposal = obj.data.content.fields as unknown as OnChainMergeProposal;
      const status   = Number(proposal.status);

      if (status === PROPOSAL_STATUS.FINALIZED) return { status: "finalized", proposal };
      if (status === PROPOSAL_STATUS.ABORTED)   return { status: "aborted",   proposal };
      if (status === PROPOSAL_STATUS.EXPIRED)   return { status: "expired",   proposal };

      await new Promise(r => setTimeout(r, pollMs));
    }
    throw new Error(`waitForFinalization: timed out after ${timeoutMs} ms`);
  }

  // ─── transferSui() — test utility ─────────────────────────────────────────

  async transferSui(to: string, amountMist: bigint): Promise<string> {
    const tx = new Transaction();
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
    tx.transferObjects([coin], tx.pure.address(to));
    tx.setGasBudget(10_000_000);
    return this.execute(tx);
  }
}
