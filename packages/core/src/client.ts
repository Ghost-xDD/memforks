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

import {
  SuiJsonRpcClient as SuiClient,
  JsonRpcHTTPTransport,
  getJsonRpcFullnodeUrl,
} from '@mysten/sui/jsonRpc';
import { Transaction } from '@mysten/sui/transactions';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { bcs } from '@mysten/sui/bcs';
import { MemWal } from '@mysten-incubation/memwal';
import type {
  OnChainTree,
  OnChainCommit,
  OnChainMergeProposal,
  CommitPayload,
  CommitEntry,
  CommitDelta,
  ArtifactRef,
  PermFlags,
} from './types.js';
import { PROPOSAL_STATUS, PAYLOAD_VERSION, branchNamespace } from './types.js';
import {
  putArtifact,
  ArtifactStorageError,
  DEFAULT_ARTIFACT_CONFIG,
} from './artifacts.js';
import type { ArtifactConfig } from './artifacts.js';
import { resolvers } from './resolvers.js';
import type { ResolverDef } from './resolvers.js';
import { emitTelemetry } from './telemetry.js';

// ─── SHA-256 via Web Crypto (Node 15+ / browser) ─────────────────────────────

/**
 * MemWal stores the full commit payload JSON string as the indexed text.
 * This helper unwraps a blob string into its individual plain-text facts,
 * handling arbitrary nesting (a merge commit whose facts are also blobs).
 */
function unwrapCommitBlob(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return [trimmed];
  try {
    const parsed = JSON.parse(trimmed) as {
      type?: string;
      delta?: { facts?: unknown[] };
    };
    if (parsed.type === 'commit' && Array.isArray(parsed.delta?.facts)) {
      return (parsed.delta.facts as unknown[]).flatMap((f) =>
        unwrapCommitBlob(typeof f === 'string' ? f : JSON.stringify(f)),
      );
    }
  } catch { /* not JSON — fall through */ }
  return [trimmed];
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
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
  network?: 'testnet' | 'mainnet' | 'devnet' | 'localnet';
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
  /** Artifact storage config. Default: disabled. See docs/architecture/artifacts.md. */
  artifacts?: Partial<ArtifactConfig>;
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
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');

  const env = process.env;

  // ── Walk up from cwd looking for .memfork/config.json ──────────────────────
  let projectConfig: Record<string, string> = {};
  let dir = process.cwd();
  while (true) {
    const candidate = path.join(dir, '.memfork', 'config.json');
    if (fs.existsSync(candidate)) {
      try {
        projectConfig = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      } catch {
        /* ignore */
      }
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
    const credsPath = path.join(os.homedir(), '.memfork', 'credentials.json');
    if (fs.existsSync(credsPath)) {
      const raw = JSON.parse(fs.readFileSync(credsPath, 'utf8')) as {
        default?: string;
        trees?: Record<string, Record<string, string>>;
      };
      creds = raw.trees ?? {};
      defaultTree = raw.default;
    }
  } catch {
    /* ignore */
  }

  // ── Resolve values ──────────────────────────────────────────────────────────
  const treeId =
    env['MEMFORK_TREE_ID'] ?? projectConfig['treeId'] ?? defaultTree;

  if (!treeId) {
    throw new Error(
      'MemForksClient.connect(): no treeId found.\n' +
        'Run `memfork init` to create a tree, or pass treeId explicitly.',
    );
  }

  const stored = creds[treeId] ?? {};

  const privateKey = env['MEMFORK_PRIVATE_KEY'] ?? stored['privateKey'];

  if (!privateKey) {
    throw new Error(
      `MemForksClient.connect(): no private key for tree ${treeId}.\n` +
        'Run `memfork init` or set MEMFORK_PRIVATE_KEY.',
    );
  }

  const memwalAccountId =
    env['MEMFORK_MEMWAL_ACCOUNT'] ?? stored['memwalAccountId'];

  const memwalKey = env['MEMFORK_MEMWAL_KEY'] ?? stored['memwalKey'];

  const network = (env['MEMFORK_NETWORK'] ??
    projectConfig['network'] ??
    'testnet') as MemForksClientConfig['network'];

  const resolved: MemForksClientConfig = { treeId, signer: privateKey };

  if (network) resolved.network = network;

  const rpcUrl = env['MEMFORK_RPC_URL'] ?? projectConfig['rpcUrl'];
  const packageId =
    env['MEMFORK_PACKAGE_ID'] ??
    projectConfig['packageId'] ??
    PACKAGE_IDS[network ?? 'mainnet'];
  const sponsorUrl = env['MEMFORK_SPONSOR_URL'] ?? projectConfig['sponsorUrl'];
  const defaultResolverId =
    env['MEMFORK_RESOLVER_ID'] ?? projectConfig['resolverId'];

  if (rpcUrl) resolved.rpcUrl = rpcUrl;
  if (packageId) resolved.packageId = packageId;
  if (sponsorUrl) resolved.sponsorUrl = sponsorUrl;
  if (defaultResolverId) resolved.defaultResolverId = defaultResolverId;

  if (memwalAccountId && memwalKey) {
    const serverUrl =
      env['MEMFORK_RELAYER_URL'] ??
      stored['memwalRelayer'] ??
      relayerForNetwork(network);
    resolved.memwal = {
      accountId: memwalAccountId,
      delegateKey: memwalKey,
      serverUrl,
    };
  }

  return resolved;
}

// ─── Deployed constants ───────────────────────────────────────────────────────

const PACKAGE_IDS: Record<string, string> = {
  mainnet: '0xc13cc014fb8084b3468f6e5ffdc272e64ef35b7a912332eba7a0d44dd66b3121',
  testnet: '0x185e765a4979fb9d9089374f822485c88b9d0b2f91f9b1313a73043d5ef2357f',
};

const DEFAULT_PACKAGE_ID = PACKAGE_IDS['mainnet'];

const RELAYER_BY_NETWORK: Record<string, string> = {
  mainnet: 'https://relayer.memory.walrus.xyz',
  testnet: 'https://relayer-staging.memory.walrus.xyz',
};

function relayerForNetwork(network: string | undefined): string {
  return (
    RELAYER_BY_NETWORK[network ?? 'mainnet'] ?? RELAYER_BY_NETWORK['mainnet']!
  );
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
  /** Resolved artifact config (enabled = false by default). */
  readonly artifactConfig: ArtifactConfig;

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
    artifactConfig: ArtifactConfig,
  ) {
    this.treeId = treeId;
    this.packageId = packageId;
    this.suiClient = suiClient;
    this.keypair = keypair;
    this.memwalKey = memwalKey;
    this.memwalAccountId = memwalAccountId;
    this.memwalServerUrl = memwalServerUrl;
    this.sponsorUrl = sponsorUrl;
    this.defaultResolverId = defaultResolverId;
    this.artifactConfig = artifactConfig;
  }

  // ─── Factory ──────────────────────────────────────────────────────────────

  // Overloads allow both `connect()` and `connect(cfg)` to be called from
  // consumers that import this as a package (where `cfg?` alone isn't always
  // picked up as truly optional across package boundaries).
  static async connect(): Promise<MemForksClient>;
  static async connect(cfg: MemForksClientConfig): Promise<MemForksClient>;
  static async connect(cfg?: MemForksClientConfig): Promise<MemForksClient> {
    if (!cfg) cfg = await resolveAutoConfig();
    const network = cfg.network ?? 'mainnet';
    const packageId = (cfg.packageId ??
      PACKAGE_IDS[network] ??
      DEFAULT_PACKAGE_ID) as string;

    let keypair: Ed25519Keypair;
    if (cfg.signer instanceof Ed25519Keypair) {
      keypair = cfg.signer;
    } else if (cfg.signer.startsWith('suiprivkey')) {
      const { secretKey } = decodeSuiPrivateKey(cfg.signer);
      keypair = Ed25519Keypair.fromSecretKey(secretKey);
    } else {
      keypair = Ed25519Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(cfg.signer, 'hex')),
      );
    }

    const rpcUrl = cfg.rpcUrl ?? getJsonRpcFullnodeUrl(network);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const suiClient = new SuiClient({
      transport: new JsonRpcHTTPTransport({ url: rpcUrl }),
      network,
    } as any);

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
      { ...DEFAULT_ARTIFACT_CONFIG, ...cfg.artifacts },
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
    for (const [branch, blobId] of Object.entries(
      tree.branches as Record<string, string>,
    )) {
      this.heads.set(branch, { blobId: blobId ?? '', contentHash: '' });
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
  /**
   * True for errors that are safe to retry by rebuilding the transaction.
   *
   * The dominant case is the object-version race: the shared MemoryTree and
   * (under a shared sponsor) the sponsor's gas coin get their versions bumped
   * by concurrent transactions, so a tx built against version N fails once the
   * chain has already advanced to N+1. Rebuilding re-resolves to the current
   * version, so these are transient — not real failures.
   */
  private static isTransientChainError(e: unknown): boolean {
    const msg = String(e).toLowerCase();
    return (
      msg.includes('needs to be rebuilt') ||
      msg.includes('unavailable for consumption') ||
      msg.includes('not available for consumption') ||
      msg.includes('object version') ||
      msg.includes('objectversionunavailable') ||
      msg.includes('reserved for another transaction') ||
      msg.includes('object is locked') ||
      msg.includes('could not find the referenced object') ||
      // sponsor server hiccups while it re-selects a gas coin
      msg.includes('sponsor error: 409') ||
      msg.includes('sponsor error: 429') ||
      msg.includes('sponsor error: 500') ||
      msg.includes('sponsor error: 503')
    );
  }

  /**
   * Submit one fully-built transaction (sponsored or self-paid). No retry —
   * retry/rebuild logic lives in executeWithChanges().
   */
  private async submitTx(tx: Transaction): Promise<{
    digest: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    objectChanges: any[] | undefined;
  }> {
    if (this.sponsorUrl) {
      const serialized = tx.serialize();

      const resp = await fetch(this.sponsorUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tx: serialized,
          sender: this.keypair.toSuiAddress(),
        }),
      });
      if (!resp.ok)
        throw new Error(`Sponsor error: ${resp.status} ${await resp.text()}`);

      const { txBytes, sponsorSig } = (await resp.json()) as {
        txBytes: string;
        sponsorSig: string;
      };

      const finalBytes = Buffer.from(txBytes, 'base64');
      const userSig = await this.keypair.signTransaction(finalBytes);

      const result = await this.suiClient.executeTransactionBlock({
        transactionBlock: txBytes,
        signature: [userSig.signature, sponsorSig],
        options: { showEffects: true, showObjectChanges: true },
      });
      if (result.effects?.status.status !== 'success') {
        throw new Error(`Sponsored tx failed: ${result.effects?.status.error}`);
      }
      return {
        digest: result.digest,
        objectChanges: result.objectChanges ?? undefined,
      };
    }

    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: this.keypair,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });
    if (result.effects?.status.status !== 'success') {
      throw new Error(
        `Transaction failed: ${result.effects?.status.error ?? 'unknown'}`,
      );
    }
    return {
      digest: result.digest,
      objectChanges: result.objectChanges ?? undefined,
    };
  }

  /**
   * Build + submit a transaction, transparently retrying transient
   * object-version races.
   *
   * The `build` thunk is invoked fresh on every attempt, which is what makes
   * this self-healing: a rebuilt tx is re-resolved against current chain state
   * (sponsored txs re-POST to the sponsor for a fresh gas coin + freshly
   * resolved shared-object versions; self-paid txs re-resolve owned-object
   * versions against the fullnode). Concurrent mutation of a shared object
   * therefore no longer fails cold — it just costs one extra round-trip.
   *
   * Backoff is exponential with jitter to avoid lockstep retries when several
   * agents hit the same sponsor at once.
   */
  private async executeWithChanges(build: () => Transaction): Promise<{
    digest: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    objectChanges: any[] | undefined;
  }> {
    const maxAttempts = 6;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.submitTx(build());
      } catch (e) {
        lastErr = e;
        if (
          !MemForksClient.isTransientChainError(e) ||
          attempt === maxAttempts
        ) {
          throw e;
        }
        const base = Math.min(200 * 2 ** (attempt - 1), 2500);
        const jitter = Math.floor(Math.random() * 250);
        await new Promise((r) => setTimeout(r, base + jitter));
      }
    }
    throw lastErr;
  }

  private async execute(build: () => Transaction): Promise<string> {
    const { digest } = await this.executeWithChanges(build);
    return digest;
  }

  // ─── MemWal helpers ───────────────────────────────────────────────────────

  private memwalForBranch(branch: string): MemWal {
    if (!this.memwalKey || !this.memwalAccountId) {
      throw new Error(
        'MemWal credentials required — pass `memwal` in connect().',
      );
    }
    return MemWal.create({
      key: this.memwalKey,
      accountId: this.memwalAccountId,
      serverUrl:
        this.memwalServerUrl ?? relayerForNetwork(this.suiClient.network),
      namespace: branchNamespace(this.treeId, branch),
    });
  }

  // ─── Tree reads ───────────────────────────────────────────────────────────

  async getTree(): Promise<OnChainTree> {
    const obj = await this.suiClient.getObject({
      id: this.treeId,
      options: { showContent: true },
    });
    if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
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
    if (
      !treeObj.data?.content ||
      treeObj.data.content.dataType !== 'moveObject'
    ) {
      throw new Error(`Tree object not found: ${this.treeId}`);
    }
    // Extract the Table's object ID from the raw fields.
    const rawFields = treeObj.data.content.fields as Record<string, unknown>;
    const branchesRaw = rawFields['branches'] as
      | { fields?: { id?: { id?: string } } }
      | undefined;
    const tableId = branchesRaw?.fields?.id?.id;
    if (!tableId) {
      // Fall back to the legacy direct-map representation (older SDK versions).
      const legacyMap = rawFields['branches'] as
        | Record<string, string>
        | undefined;
      return legacyMap?.[branch] ?? '';
    }

    try {
      const dynField = await this.suiClient.getDynamicFieldObject({
        parentId: tableId,
        name: { type: '0x1::string::String', value: branch },
      });
      if (
        !dynField.data?.content ||
        dynField.data.content.dataType !== 'moveObject'
      )
        return '';
      // The table value is vector<u8> — byte array of the blob ID string.
      const valFields = dynField.data.content.fields as Record<string, unknown>;
      const bytes = valFields['value'] as number[] | string | undefined;
      if (!bytes) return '';
      if (typeof bytes === 'string') return bytes;
      // Convert byte array to UTF-8 string.
      return Buffer.from(bytes).toString('utf8');
    } catch {
      // Branch not found in table = genesis.
      return '';
    }
  }

  /** Fetch a merge anchor commit by its on-chain object ID. */
  async getMergeAnchor(commitId: string): Promise<OnChainCommit> {
    const obj = await this.suiClient.getObject({
      id: commitId,
      options: { showContent: true },
    });
    if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
      throw new Error(`Commit anchor not found: ${commitId}`);
    }
    return obj.data.content.fields as unknown as OnChainCommit;
  }

  // ─── initTree() ───────────────────────────────────────────────────────────

  async initTree(
    memwalAccountId: string,
    defaultBranch = 'main',
  ): Promise<{ digest: string; treeId: string }> {
    const { digest: initDigest, objectChanges: initChanges } =
      await this.executeWithChanges(() => {
        const tx = new Transaction();
        tx.moveCall({
          target: `${this.packageId}::tree::init_tree`,
          arguments: [
            tx.pure.address(memwalAccountId),
            tx.pure.vector('u8', Array.from(Buffer.from(defaultBranch))),
            tx.object('0x6'),
          ],
        });
        tx.setGasBudget(30_000_000);
        return tx;
      });
    const result = { digest: initDigest, objectChanges: initChanges };
    const treeChange = result.objectChanges?.find(
      (c) =>
        c.type === 'created' &&
        'objectType' in c &&
        c.objectType.includes('::tree::MemoryTree'),
    );
    if (!treeChange || treeChange.type !== 'created') {
      throw new Error('init_tree: MemoryTree not found in object changes');
    }

    this.setLocalHead(defaultBranch, { blobId: '', contentHash: '' });

    return { digest: result.digest, treeId: treeChange.objectId };
  }

  // ─── branch() ─────────────────────────────────────────────────────────────

  /**
   * Fork a new branch from an existing one (on-chain tx).
   * Also copies the live local head to the new branch so off-chain commits
   * made since the last merge are visible on the fork immediately.
   */
  async branch(name: string, opts: { from: string }): Promise<string> {
    const digest = await this.execute(() => {
      const tx = new Transaction();
      tx.moveCall({
        target: `${this.packageId}::tree::branch`,
        arguments: [
          tx.object(this.treeId),
          tx.pure.vector('u8', Array.from(Buffer.from(opts.from))),
          tx.pure.vector('u8', Array.from(Buffer.from(name))),
        ],
      });
      tx.setGasBudget(30_000_000);
      return tx;
    });

    // Copy the live local head so the new branch inherits uncommitted off-chain history.
    const parentHead = this.heads.get(opts.from);
    this.setLocalHead(
      name,
      parentHead ? { ...parentHead } : { blobId: '', contentHash: '' },
    );

    void emitTelemetry(
      { op: 'branch', namespace: branchNamespace(this.treeId, name) },
      this.sponsorUrl,
    );

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
   * If `artifacts` are supplied and `this.artifactConfig.enabled = true`,
   * each file is uploaded to Walrus first (upload-before-commit ordering) so
   * the commit never references a blob that wasn't successfully stored.
   *
   * Updates the local head tracker on success.
   */
  async commit(
    branch: string,
    opts: {
      facts: string[];
      message: string;
      delta?: Partial<CommitDelta>;
      /** Which tool is writing this commit — shown in the visualizer inspector. */
      tool?: "codex" | "cursor" | "sdk" | string;
      /** Human display name for the author (e.g. "Dev A"). */
      authorName?: string;
      /**
       * Files to persist as standalone Walrus blobs and reference from this commit.
       * Requires `artifactConfig.enabled = true` and a WAL-funded signer.
       */
      artifacts?: Array<{ path: string; bytes: Uint8Array; mime?: string; epochs?: number }>;
    },
  ): Promise<{ blobId: string; contentHash: string; artifacts: ArtifactRef[] }> {
    const _t0 = Date.now();

    // ── Artifact upload (before payload construction) ────────────────────────
    const network = (this.suiClient as unknown as { network?: string }).network as 'mainnet' | 'testnet' | undefined;
    const artifactRefs: ArtifactRef[] = [];
    if (opts.artifacts && opts.artifacts.length > 0) {
      for (let i = 0; i < opts.artifacts.length; i++) {
        const art = opts.artifacts[i]!;
        try {
          const ref = await putArtifact(art.bytes, {
            path: art.path,
            ...(art.mime !== undefined ? { mime: art.mime } : {}),
            config: this.artifactConfig,
            network: network === 'mainnet' ? 'mainnet' : 'testnet',
            keypair: this.keypair,
            ...(art.epochs !== undefined ? { epochsOverride: art.epochs } : {}),
          });
          artifactRefs.push(ref);
        } catch (err) {
          const uploaded = artifactRefs.map((r) => r.path).join(', ');
          const remaining = opts.artifacts.slice(i + 1).map((a) => a.path).join(', ');
          const context = [
            uploaded ? `  Already uploaded (${artifactRefs.length}/${opts.artifacts.length}): ${uploaded}` : null,
            remaining ? `  Not yet attempted: ${remaining}` : null,
          ].filter(Boolean).join('\n');
          const base = err instanceof Error ? err.message : String(err);
          throw new Error(
            `${base}${context ? '\n' + context : ''}\n` +
            '  The commit was NOT written — no facts or artifact refs were stored.\n' +
            '  Already-uploaded blobs on Walrus are permanent but will remain unreferenced.',
          );
        }
      }
    }
    const currentHead = this.heads.get(branch) ?? {
      blobId: '',
      contentHash: '',
    };

    const parentBlobIds: string[] = currentHead.blobId
      ? [currentHead.blobId]
      : [];
    const parentBlobHashes: string[] = currentHead.contentHash
      ? [currentHead.contentHash]
      : [];

    const treeIdBytes = Buffer.from(this.treeId.replace(/^0x/, ''), 'hex');
    const authorBytes = Buffer.from(
      this.keypair.toSuiAddress().replace(/^0x/, ''),
      'hex',
    );

    const payload: CommitPayload = {
      v: PAYLOAD_VERSION,
      type: 'commit',
      tree: Uint8Array.from(treeIdBytes),
      branch,
      author: Uint8Array.from(authorBytes),
      ts_ms: Date.now(),
      parent_blob_ids: parentBlobIds,
      parent_blob_hashes: parentBlobHashes,
      delta: {
        facts: opts.facts,
        ...(opts.delta?.messages && { messages: opts.delta.messages }),
        ...(opts.delta?.files && { files: opts.delta.files }),
        // Merge pre-uploaded refs (delta.artifacts) with inline-uploaded refs.
        ...((artifactRefs.length > 0 || (opts.delta?.artifacts?.length ?? 0) > 0) && {
          artifacts: [...(opts.delta?.artifacts ?? []), ...artifactRefs],
        }),
      },
      ...(opts.tool ? { tool: opts.tool } : {}),
      ...(opts.authorName ? { author_name: opts.authorName } : {}),
    };

    // Serialise to JSON for MemWal. The hash is over this exact string.
    const payloadJson = JSON.stringify(payload, (_key, value) => {
      // Uint8Array serialises as { 0: x, 1: y, ... } by default — convert to base64.
      if (value instanceof Uint8Array) {
        return Buffer.from(value).toString('base64');
      }
      return value;
    });

    // Hash the plaintext payload. The NEXT commit will include this as parent_blob_hashes[0].
    const contentHash = await sha256Hex(payloadJson);

    const branchMemwal = this.memwalForBranch(branch);
    const memResult = await branchMemwal.rememberAndWait(payloadJson);
    const blobId = memResult.blob_id;

    // Advance the local head.
    this.setLocalHead(branch, { blobId, contentHash });

    void emitTelemetry(
      {
        op: 'commit',
        namespace: branchNamespace(this.treeId, branch),
        bytes: payloadJson.length,
        latencyMs: Date.now() - _t0,
      },
      this.sponsorUrl,
    );

    return { blobId, contentHash, artifacts: artifactRefs };
  }

  // ─── recall() ─────────────────────────────────────────────────────────────

  async recall(
    query: string,
    opts: { branch?: string; limit?: number } = {},
  ): Promise<Array<{ distance: number; blobId: string; text: string }>> {
    const _t0 = Date.now();
    const tree = await this.getTree();
    const branch = opts.branch ?? tree.default_branch;
    const limit  = opts.limit ?? 5;
    const branchMemwal = this.memwalForBranch(branch);

    const result = await branchMemwal.recall({ query, limit });

    // Dedup primary results by text content — the same fact committed twice
    // (or indexed twice by the relayer) should surface only once.
    const primarySeen = new Set<string>();
    let results = result.results.filter((r) => {
      const key = r.text.trim().slice(0, 120);
      if (primarySeen.has(key)) return false;
      primarySeen.add(key);
      return true;
    });

    // GAP-1: ancestor-fallback — if the branch returned fewer results than
    // requested, also query the default branch (main).  This ensures a new
    // fork inherits memory from its parent context without requiring an
    // explicit merge first.  The most relevant facts across both namespaces
    // are surfaced, deduped by text content.
    const defaultBranch = String(tree.default_branch ?? 'main');
    if (results.length < limit && branch !== defaultBranch) {
      try {
        const parentMemwal = this.memwalForBranch(defaultBranch);
        const parentResult = await parentMemwal.recall({ query, limit });
        for (const r of parentResult.results) {
          if (!primarySeen.has(r.text.trim().slice(0, 120))) {
            primarySeen.add(r.text.trim().slice(0, 120));
            results = [...results, r];
            if (results.length >= limit) break;
          }
        }
      } catch {
        // fallback failed silently — primary branch results still returned
      }
    }

    void emitTelemetry(
      {
        op: 'recall',
        namespace: branchNamespace(this.treeId, branch),
        resultCount: results.length,
        latencyMs: Date.now() - _t0,
      },
      this.sponsorUrl,
    );

    // Unwrap commit payload blobs — MemWal stores the full JSON string, but
    // callers expect plain-text facts. Expand each blob into its delta.facts.
    return results.flatMap((r) => {
      const texts = unwrapCommitBlob(r.text);
      return texts.map((text) => ({
        distance: r.distance,
        blobId: r.blob_id,
        text,
      }));
    });
  }

  // ─── history() ────────────────────────────────────────────────────────────

  /**
   * Return the ordered commit history for a branch (SPEC §8.2 hash-chain walk).
   *
   * Reconstructs the DAG by fetching all MemWal entries for the branch namespace
   * and topo-sorting them via parent_blob_ids / ts_ms. The result is oldest-first
   * — index 0 is the first commit on the branch.
   *
   * Because MemWal recall is semantic top-K (not a keyed scan), we fetch with a
   * broad empty query at a high limit. Callers operating on very large branches
   * should call memwal.restore() first to guarantee index completeness.
   */
  async history(
    branch: string,
    opts: { limit?: number } = {},
  ): Promise<CommitEntry[]> {
    const tree  = await this.getTree();
    const b     = branch ?? tree.default_branch;
    const limit = opts.limit ?? 200;
    const branchMemwal = this.memwalForBranch(b);

    const result = await branchMemwal.recall({ query: '', limit });

    const entries: CommitEntry[] = [];
    const seen = new Set<string>();

    for (const r of result.results) {
      if (seen.has(r.blob_id)) continue;
      seen.add(r.blob_id);
      let payload: CommitPayload | null = null;
      try {
        payload = JSON.parse(r.text) as CommitPayload;
        if (payload.type !== 'commit' || payload.v !== PAYLOAD_VERSION) continue;
      } catch {
        continue;
      }
      entries.push({
        blobId:           r.blob_id,
        branch:           String(payload.branch ?? b),
        ts_ms:            payload.ts_ms,
        parent_blob_ids:  payload.parent_blob_ids ?? [],
        facts:            payload.delta?.facts ?? [],
        message:          payload.delta?.facts?.[0] ?? `commit ${r.blob_id.slice(0, 7)}`,
        distance:         r.distance,
        artifacts:        payload.delta?.artifacts ?? [],
      });
    }

    // Topo-sort: build parent → children map, then BFS from roots.
    // Falls back to ts_ms ordering when the chain is ambiguous (e.g. partial
    // index) so the result is always deterministic.
    const byBlob = new Map(entries.map((e) => [e.blobId, e]));
    const childCount = new Map<string, number>();
    for (const e of entries) childCount.set(e.blobId, 0);
    for (const e of entries) {
      for (const pid of e.parent_blob_ids) {
        if (byBlob.has(pid)) childCount.set(pid, (childCount.get(pid) ?? 0) + 1);
      }
    }

    // BFS from roots (commits with no known parents in this set).
    const queue = entries
      .filter((e) => e.parent_blob_ids.every((p) => !byBlob.has(p)))
      .sort((a, b) => a.ts_ms - b.ts_ms);

    const ordered: CommitEntry[] = [];
    const visited = new Set<string>();
    while (queue.length) {
      const e = queue.shift()!;
      if (visited.has(e.blobId)) continue;
      visited.add(e.blobId);
      ordered.push(e);
      // Enqueue children whose parents are all visited.
      for (const candidate of entries) {
        if (visited.has(candidate.blobId)) continue;
        if (candidate.parent_blob_ids.every((p) => !byBlob.has(p) || visited.has(p))) {
          queue.push(candidate);
        }
      }
      queue.sort((a, b) => a.ts_ms - b.ts_ms);
    }

    // Append any entries not reachable from roots (orphaned by partial index).
    for (const e of entries) {
      if (!visited.has(e.blobId)) ordered.push(e);
    }

    return ordered;
  }

  /**
   * Materialize the memory state at a historical cut point (time-travel).
   *
   * `point` is one of:
   *   - `~N`     — N commits back from the tip (e.g. `~1` = one before the tip)
   *   - `<blobId-prefix>` — any commit whose blobId starts with this prefix
   *   - `<ISO-8601 | Unix-ms>` — the last commit at or before this timestamp
   *
   * Returns the ordered commits up to (and including) the cut point, plus the
   * union of all `delta.facts[]` across those commits as the materialized state.
   *
   * This is read-only. To commit against this state, create a new branch from it.
   */
  async materializeAt(
    branch: string,
    point: string,
  ): Promise<{ commits: CommitEntry[]; facts: string[]; cutBlobId: string }> {
    const all = await this.history(branch);
    if (all.length === 0) return { commits: [], facts: [], cutBlobId: '' };

    let cutIdx = all.length - 1;

    if (point.startsWith('~')) {
      const n = parseInt(point.slice(1), 10);
      if (!isNaN(n)) cutIdx = Math.max(0, all.length - 1 - n);
    } else {
      // Try blob-ID prefix first.
      const prefixMatch = all.findIndex((e) => e.blobId.startsWith(point));
      if (prefixMatch !== -1) {
        cutIdx = prefixMatch;
      } else {
        // Try timestamp (ISO or Unix-ms).
        const ts = isNaN(Number(point))
          ? new Date(point).getTime()
          : Number(point);
        if (!isNaN(ts)) {
          // Last commit at or before ts.
          const tsMatch = [...all].reverse().findIndex((e) => e.ts_ms <= ts);
          cutIdx = tsMatch === -1 ? 0 : all.length - 1 - tsMatch;
        }
      }
    }

    const commits = all.slice(0, cutIdx + 1);
    const seen = new Set<string>();
    const facts: string[] = [];
    for (const c of commits) {
      for (const f of c.facts) {
        if (!seen.has(f)) { seen.add(f); facts.push(f); }
      }
    }

    return { commits, facts, cutBlobId: all[cutIdx]?.blobId ?? '' };
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
    const perms = opts.perms ?? 0x02 | 0x04 | 0x10;
    const expires = opts.expiresEpoch ?? BigInt('18446744073709551615');
    const branches = opts.branches ?? [];

    return this.execute(() => {
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
      return tx;
    });
  }

  // ─── revokeDelegate() ─────────────────────────────────────────────────────

  async revokeDelegate(agent: string): Promise<string> {
    return this.execute(() => {
      const tx = new Transaction();
      tx.moveCall({
        target: `${this.packageId}::tree::revoke_delegate`,
        arguments: [tx.object(this.treeId), tx.pure.address(agent)],
      });
      tx.setGasBudget(10_000_000);
      return tx;
    });
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

    const { objectChanges } = await this.executeWithChanges(() => {
      const tx = new Transaction();
      tx.moveCall({
        target: `${this.packageId}::resolver::propose_merge`,
        arguments: [
          tx.object(this.treeId),
          tx.pure.vector('u8', Array.from(Buffer.from(opts.fromBranch))),
          tx.pure.vector('u8', Array.from(Buffer.from(opts.intoBranch))),
          tx.pure.vector('u8', Array.from(Buffer.from(fromHead, 'utf8'))),
          tx.pure.vector('u8', Array.from(Buffer.from(intoHead, 'utf8'))),
          tx.object(opts.resolverId),
          tx.pure.u64(ttlMs),
          tx.object('0x6'),
        ],
      });
      tx.setGasBudget(30_000_000);
      return tx;
    });

    const created = objectChanges?.find(
      (c) =>
        c.type === 'created' &&
        'objectType' in c &&
        c.objectType.includes('::resolver::MergeProposal'),
    );
    if (!created || created.type !== 'created') {
      throw new Error(
        'proposeMerge: MergeProposal not found in object changes',
      );
    }
    return created.objectId;
  }

  // ─── submitAttestation() ──────────────────────────────────────────────────

  async submitAttestation(opts: {
    proposalId: string;
    resolverId: string;
    attestKind: number;
    attestPayload: Uint8Array;
  }): Promise<string> {
    const pubkeyBytes = Array.from(this.keypair.getPublicKey().toRawBytes());
    const sigBytes = Array.from(await this.keypair.sign(opts.attestPayload));

    return this.execute(() => {
      const tx = new Transaction();
      tx.moveCall({
        target: `${this.packageId}::resolver::submit_attestation`,
        arguments: [
          tx.object(opts.proposalId),
          tx.object(opts.resolverId),
          tx.pure.u8(opts.attestKind),
          tx.pure.vector('u8', Array.from(opts.attestPayload)),
          tx.pure.vector('u8', pubkeyBytes),
          tx.pure.vector('u8', sigBytes),
        ],
      });
      tx.setGasBudget(25_000_000);
      return tx;
    });
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
    const blobIdBytes = Array.from(Buffer.from(opts.resolvedBlobId, 'utf8'));
    const digest = await this.execute(() => {
      const tx = new Transaction();
      tx.moveCall({
        target: `${this.packageId}::resolver::finalize_merge`,
        arguments: [
          tx.object(this.treeId),
          tx.object(opts.proposalId),
          tx.object(opts.resolverId),
          tx.pure.vector('u8', Array.from(Buffer.from(opts.resolvedNamespace))),
          tx.pure.vector('u8', blobIdBytes),
          tx.object('0x6'),
        ],
      });
      tx.setGasBudget(40_000_000);
      return tx;
    });

    // The into_branch head is now the resolved blob. Reset the content hash since
    // we don't have the plaintext of the resolver's output to hash.
    this.setLocalHead(opts.intoBranch, {
      blobId: opts.resolvedBlobId,
      contentHash: '',
    });

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
  ): Promise<{
    digest: string;
    mergedCount: number;
    blobId: string;
    proposalId?: string;
  }> {
    const _t0 = Date.now();
    const queries = opts.recallQueries ?? [
      'facts about this project and conversation',
      'user preferences decisions and technical choices',
      'user background goals context and identity',
    ];
    const limit = opts.recallLimit ?? 10;

    // Sweep the from branch for distinct facts.
    const sweepResults = await Promise.all(
      queries.map((q) =>
        this.recall(q, { branch: from, limit }).catch(() => []),
      ),
    );
    const seen = new Set<string>();
    const facts: string[] = [];
    for (const batch of sweepResults) {
      for (const r of batch) {
        // recall() already unwraps commit blobs via unwrapCommitBlob();
        // r.text is a plain-text fact string here.
        const key = r.text.trim().slice(0, 120);
        if (!seen.has(key)) {
          seen.add(key);
          facts.push(r.text);
        }
      }
    }
    if (facts.length === 0) {
      void emitTelemetry(
        {
          op: 'merge',
          namespace: branchNamespace(this.treeId, into),
          latencyMs: Date.now() - _t0,
        },
        this.sponsorUrl,
      );
      return { digest: '', mergedCount: 0, blobId: '' };
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
      console.log(
        `[memfork] merge ${from} → ${into}: proposal ${proposalId}, awaiting resolver…`,
      );

      const { status, proposal } = await this.waitForFinalization(proposalId, {
        timeoutMs: opts.timeoutMs ?? 300_000,
      });
      if (status !== 'finalized') {
        throw new Error(
          `Merge proposal ${proposalId} ended with status "${status}". ` +
            `Check that your resolver service is running and has MERGE permission on "${into}".`,
        );
      }

      const resolvedBlobId = proposal.resolved_memwal_blob_id ?? blobId;
      void emitTelemetry(
        {
          op: 'merge',
          namespace: branchNamespace(this.treeId, into),
          latencyMs: Date.now() - _t0,
        },
        this.sponsorUrl,
      );
      console.log(
        `[memfork] merge ${from} → ${into}: finalized, ${facts.length} facts, blob ${resolvedBlobId}`,
      );
      return {
        digest: '',
        mergedCount: facts.length,
        blobId: resolvedBlobId,
        proposalId,
      };
    }

    // ── LWW self-serve path ───────────────────────────────────────────────
    // No external service needed. Propose + finalize in the same call.
    let lwwResolverId = this.resolverCache.get('lastWriteWins');
    if (!lwwResolverId) {
      const created = await this.createResolver(resolvers.lastWriteWins());
      lwwResolverId = created.resolverId;
      this.resolverCache.set('lastWriteWins', lwwResolverId);
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

    void emitTelemetry(
      {
        op: 'merge',
        namespace: branchNamespace(this.treeId, into),
        latencyMs: Date.now() - _t0,
      },
      this.sponsorUrl,
    );
    console.log(
      `[memfork] merge ${from} → ${into}: ${facts.length} facts, blob ${blobId}, tx ${digest}`,
    );
    return { digest, mergedCount: facts.length, blobId };
  }

  // ─── claimExpired() ───────────────────────────────────────────────────────

  async claimExpired(proposalId: string): Promise<string> {
    return this.execute(() => {
      const tx = new Transaction();
      tx.moveCall({
        target: `${this.packageId}::resolver::claim_expired`,
        arguments: [tx.object(proposalId), tx.object('0x6')],
      });
      tx.setGasBudget(10_000_000);
      return tx;
    });
  }

  // ─── createResolver() ─────────────────────────────────────────────────────

  async createResolver(
    def: ResolverDef,
  ): Promise<{ digest: string; resolverId: string }> {
    const { digest: resolverDigest, objectChanges: resolverChanges } =
      await this.executeWithChanges(() => {
        const tx = new Transaction();
        tx.moveCall({
          target: `${this.packageId}::resolver::create_and_keep_resolver`,
          arguments: [
            tx.pure.u8(def.kind),
            tx.pure.vector('u8', Array.from(def.config)),
          ],
        });
        tx.setGasBudget(15_000_000);
        return tx;
      });
    const result = { digest: resolverDigest, objectChanges: resolverChanges };
    const created = result.objectChanges?.find(
      (c) =>
        c.type === 'created' &&
        'objectType' in c &&
        c.objectType.includes('::resolver::ResolverRef'),
    );
    if (!created || created.type !== 'created') {
      throw new Error(
        'createResolver: ResolverRef not found in object changes',
      );
    }
    return { digest: result.digest, resolverId: created.objectId };
  }

  // ─── waitForFinalization() ────────────────────────────────────────────────

  async waitForFinalization(
    proposalId: string,
    opts: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<{
    status: 'finalized' | 'aborted' | 'expired';
    proposal: OnChainMergeProposal;
  }> {
    const pollMs = opts.pollMs ?? 3_000;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const deadline = Date.now() + timeoutMs;

    let notFoundRetries = 0;
    const maxNotFoundRetries = 10;

    while (Date.now() < deadline) {
      const obj = await this.suiClient.getObject({
        id: proposalId,
        options: { showContent: true },
      });
      if (!obj.data?.content || obj.data.content.dataType !== 'moveObject') {
        // Object not yet indexed — retry up to maxNotFoundRetries times before giving up.
        if (++notFoundRetries <= maxNotFoundRetries) {
          await new Promise((r) => setTimeout(r, pollMs));
          continue;
        }
        throw new Error(`Proposal not found: ${proposalId}`);
      }
      notFoundRetries = 0;
      const proposal = obj.data.content
        .fields as unknown as OnChainMergeProposal;
      const status = Number(proposal.status);

      if (status === PROPOSAL_STATUS.FINALIZED)
        return { status: 'finalized', proposal };
      if (status === PROPOSAL_STATUS.ABORTED)
        return { status: 'aborted', proposal };
      if (status === PROPOSAL_STATUS.EXPIRED)
        return { status: 'expired', proposal };

      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`waitForFinalization: timed out after ${timeoutMs} ms`);
  }

  // ─── transferSui() — test utility ─────────────────────────────────────────

  async transferSui(to: string, amountMist: bigint): Promise<string> {
    return this.execute(() => {
      const tx = new Transaction();
      const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
      tx.transferObjects([coin], tx.pure.address(to));
      tx.setGasBudget(10_000_000);
      return tx;
    });
  }
}
