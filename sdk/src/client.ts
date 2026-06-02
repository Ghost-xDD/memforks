/**
 * MemForksClient — the primary SDK entry point.
 *
 * Wraps the Sui PTB client and MemWal SDK to expose a high-level API:
 *   branch / commit / recall / grantDelegate / revokeDelegate
 *
 * SPEC §5 entry functions, §3 auth, §8 payload strategy (A: facts-as-text).
 *
 * Usage:
 *   const mem = await MemForksClient.connect({ treeId, signer, memwal: {...} });
 *   await mem.branch("hypothesis-a", { from: "main" });
 *   const commit = await mem.commit("hypothesis-a", { facts: ["..."], message: "..." });
 *   const results = await mem.recall("what did we learn about latency?");
 */

import { SuiJsonRpcClient as SuiClient, JsonRpcHTTPTransport, getJsonRpcFullnodeUrl } from "@mysten/sui/jsonRpc";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { bcs } from "@mysten/sui/bcs";
import { MemWal } from "@mysten-incubation/memwal";
import type { OnChainTree, OnChainCommit, OnChainMergeProposal, PermFlags } from "./types.js";
import { PROPOSAL_STATUS, branchNamespace } from "./types.js";
import type { ResolverDef } from "./resolvers.js";

// BCS-encode a vector<String> (vector<vector<u8>>) for Move PTB calls.
function bcsEncodeStringVector(strings: string[]): Uint8Array {
  return bcs.vector(bcs.string()).serialize(strings).toBytes();
}

// ─── Config types ─────────────────────────────────────────────────────────────

export interface MemWalConfig {
  /** The MemWalAccount object ID (0x-prefixed). */
  accountId: string;
  /** Ed25519 delegate private key (64-char hex). */
  delegateKey: string;
  /** Relayer URL. Defaults to staging testnet. */
  serverUrl?: string;
}

export interface MemForksClientConfig {
  /** The MemoryTree shared object ID (0x-prefixed). */
  treeId: string;
  /**
   * Signer. Either:
   *  - an Ed25519Keypair, or
   *  - a suiprivkey1... bech32 string (Sui CLI export format), or
   *  - a 64-char hex private key string.
   */
  signer: Ed25519Keypair | string;
  /**
   * MemWal delegate credentials.
   * Optional — only required for `commit()` and `recall()`.
   * Resolver workers and other chain-only callers can omit this.
   */
  memwal?: MemWalConfig;
  /** Sui network. Defaults to "testnet". */
  network?: "testnet" | "mainnet" | "devnet" | "localnet";
  /** Override RPC URL. */
  rpcUrl?: string;
  /**
   * MemForks package ID. Defaults to the deployed testnet package.
   * Override for local testing or after an upgrade.
   */
  packageId?: string;
  /**
   * Optional gas sponsor endpoint URL (PRD §10, SPEC §13.7).
   * If set, unsigned txs are POSTed here for co-signing before submission.
   */
  sponsorUrl?: string;
}

// ─── Deployed constants ───────────────────────────────────────────────────────

const DEFAULT_PACKAGE_ID =
  "0x684624f897c88ac1e9701561512bd55caf29f33bb79a51aed607c18a941b78ad";
const DEFAULT_RELAYER = "https://relayer.staging.memwal.ai";

// ─── Client ───────────────────────────────────────────────────────────────────

export class MemForksClient {
  readonly treeId: string;
  readonly packageId: string;
  readonly suiClient: SuiClient;
  readonly keypair: Ed25519Keypair;
  readonly sponsorUrl: string | undefined;

  // Stored separately so we can re-create branch-scoped MemWal instances.
  // Optional — only populated when memwal config is provided.
  private readonly memwalKey: string | undefined;
  private readonly memwalAccountId: string | undefined;
  private readonly memwalServerUrl: string | undefined;

  private constructor(
    treeId: string,
    packageId: string,
    suiClient: SuiClient,
    keypair: Ed25519Keypair,
    memwalKey: string | undefined,
    memwalAccountId: string | undefined,
    memwalServerUrl: string | undefined,
    sponsorUrl?: string,
  ) {
    this.treeId           = treeId;
    this.packageId        = packageId;
    this.suiClient        = suiClient;
    this.keypair          = keypair;
    this.memwalKey        = memwalKey;
    this.memwalAccountId  = memwalAccountId;
    this.memwalServerUrl  = memwalServerUrl;
    this.sponsorUrl       = sponsorUrl;
  }

  // ─── Factory ──────────────────────────────────────────────────────────────

  static async connect(cfg: MemForksClientConfig): Promise<MemForksClient> {
    const network   = cfg.network ?? "testnet";
    const packageId = cfg.packageId ?? DEFAULT_PACKAGE_ID;

    // Build Sui keypair from whatever format was provided.
    let keypair: Ed25519Keypair;
    if (cfg.signer instanceof Ed25519Keypair) {
      keypair = cfg.signer;
    } else if (cfg.signer.startsWith("suiprivkey")) {
      const { secretKey } = decodeSuiPrivateKey(cfg.signer);
      keypair = Ed25519Keypair.fromSecretKey(secretKey);
    } else {
      // 64-char hex
      keypair = Ed25519Keypair.fromSecretKey(
        Uint8Array.from(Buffer.from(cfg.signer, "hex")),
      );
    }

    // v2: network is always metadata; the actual URL must come through a transport.
    const rpcUrl = cfg.rpcUrl ?? getJsonRpcFullnodeUrl(network);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const suiClient = new SuiClient({ transport: new JsonRpcHTTPTransport({ url: rpcUrl }), network } as any);

    return new MemForksClient(
      cfg.treeId,
      packageId,
      suiClient,
      keypair,
      cfg.memwal?.delegateKey ?? undefined,
      cfg.memwal?.accountId   ?? undefined,
      cfg.memwal?.serverUrl   ?? undefined,
      cfg.sponsorUrl,
    );
  }

  // ─── PTB execution ────────────────────────────────────────────────────────

  private async execute(tx: Transaction): Promise<string> {
    if (this.sponsorUrl) {
      return this.executeSponsored(tx);
    }
    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: this.keypair,
      options: { showEffects: true, showObjectChanges: true, showEvents: true },
    });
    if (result.effects?.status.status !== "success") {
      throw new Error(
        `Transaction failed: ${result.effects?.status.error ?? "unknown"}`,
      );
    }
    return result.digest;
  }

  private async executeSponsored(tx: Transaction): Promise<string> {
    const bytes = await tx.build({ client: this.suiClient });
    const userSig = await this.keypair.signTransaction(bytes);

    const resp = await fetch(this.sponsorUrl!, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        txBytes:   Buffer.from(bytes).toString("base64"),
        userSig:   userSig.signature,
        sender:    this.keypair.toSuiAddress(),
      }),
    });
    if (!resp.ok) throw new Error(`Sponsor error: ${resp.status} ${await resp.text()}`);

    const { txBytes: sponsoredBytes, sponsorSig } = await resp.json() as {
      txBytes: string;
      sponsorSig: string;
    };

    const result = await this.suiClient.executeTransactionBlock({
      transactionBlock: sponsoredBytes,
      signature: [userSig.signature, sponsorSig],
      options: { showEffects: true },
    });
    if (result.effects?.status.status !== "success") {
      throw new Error(`Sponsored tx failed: ${result.effects?.status.error}`);
    }
    return result.digest;
  }

  // ─── MemWal helpers ───────────────────────────────────────────────────────

  /** Create a MemWal client scoped to a specific branch namespace. */
  private memwalForBranch(branch: string): MemWal {
    if (!this.memwalKey || !this.memwalAccountId) {
      throw new Error(
        "MemWal credentials required for commit/recall — pass `memwal` in connect().",
      );
    }
    return MemWal.create({
      key:       this.memwalKey,
      accountId: this.memwalAccountId,
      serverUrl: this.memwalServerUrl ?? DEFAULT_RELAYER,
      namespace: branchNamespace(this.treeId, branch),
    });
  }

  // ─── Tree reads ───────────────────────────────────────────────────────────

  /** Fetch the current on-chain state of the MemoryTree. */
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

  /** Get the current head commit ID for a branch. */
  async getBranchHead(branch: string): Promise<string> {
    const tree = await this.getTree();
    const branchTable = tree.branches as unknown as { fields: { id: { id: string } } };
    // Read from the dynamic field Table
    const result = await this.suiClient.getDynamicFieldObject({
      parentId: (branchTable as unknown as { fields: { id: { id: string } } }).fields.id.id,
      name: { type: "0x1::string::String", value: branch },
    });
    if (!result.data?.content || result.data.content.dataType !== "moveObject") {
      throw new Error(`Branch not found: ${branch}`);
    }
    const fields = result.data.content.fields as Record<string, unknown>;
    return fields["value"] as string;
  }

  /** Fetch a MemoryCommit by ID. */
  async getCommit(commitId: string): Promise<OnChainCommit> {
    const obj = await this.suiClient.getObject({
      id: commitId,
      options: { showContent: true },
    });
    if (!obj.data?.content || obj.data.content.dataType !== "moveObject") {
      throw new Error(`Commit not found: ${commitId}`);
    }
    return obj.data.content.fields as unknown as OnChainCommit;
  }

  // ─── initTree() ───────────────────────────────────────────────────────────

  /**
   * Create a new MemoryTree with a genesis commit and default branch.
   * Returns the new tree's object ID.
   * Calls `tree::init_tree`. The caller becomes the tree owner.
   */
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
        tx.object("0x6"), // Sui Clock singleton (SPEC §13 — real ms timestamps)
      ],
    });
    tx.setGasBudget(30_000_000);

    // Need object changes to extract the new tree ID.
    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: this.keypair,
      options: { showObjectChanges: true, showEffects: true },
    });
    if (result.effects?.status.status !== "success") {
      throw new Error(`init_tree failed: ${result.effects?.status.error}`);
    }
    const treeChange = result.objectChanges?.find(
      c => c.type === "created" && "objectType" in c &&
           c.objectType.includes("::tree::MemoryTree"),
    );
    if (!treeChange || treeChange.type !== "created") {
      throw new Error("init_tree: MemoryTree not found in object changes");
    }
    return { digest: result.digest, treeId: treeChange.objectId };
  }

  // ─── branch() ─────────────────────────────────────────────────────────────

  /**
   * Fork a new branch from an existing one.
   * Calls `tree::branch`. Requires FORK permission on `from`.
   *
   * @returns transaction digest
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
    return this.execute(tx);
  }

  // ─── commit() ─────────────────────────────────────────────────────────────

  /**
   * Store facts in MemWal and anchor the blob_id on-chain as a MemoryCommit.
   * This is the core Phase 1 flow (Strategy A: facts-as-text).
   *
   * @param branch  - target branch name
   * @param opts    - facts (array of strings), message, optional extra parents
   * @returns       - { digest, commitId, blobId }
   */
  async commit(
    branch: string,
    opts: {
      facts: string[];
      message: string;
      /** Additional parent commit IDs (beyond the current branch head). */
      extraParents?: string[];
    },
  ): Promise<{ digest: string; blobId: string }> {
    // 1. Get the current branch head — that becomes the parent.
    const tree = await this.getTree();
    const branchesTableId = (tree.branches as unknown as { fields: { id: { id: string } } })
      .fields.id.id;
    const headField = await this.suiClient.getDynamicFieldObject({
      parentId: branchesTableId,
      name: { type: "0x1::string::String", value: branch },
    });
    if (!headField.data?.content || headField.data.content.dataType !== "moveObject") {
      throw new Error(`Branch "${branch}" not found on tree ${this.treeId}`);
    }
    const parentId = (headField.data.content.fields as Record<string, unknown>)["value"] as string;
    const parentIds = [parentId, ...(opts.extraParents ?? [])];

    // 2. Store facts in MemWal under the branch namespace.
    const ns = branchNamespace(this.treeId, branch);
    const branchMemwal = this.memwalForBranch(branch);
    const memResult = await branchMemwal.rememberAndWait(opts.facts.join("\n"));
    const blobIdBytes = Array.from(Buffer.from(memResult.blob_id, "utf8"));

    // 3. Anchor on-chain.
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::tree::commit`,
      arguments: [
        tx.object(this.treeId),
        tx.pure.vector("u8", Array.from(Buffer.from(branch))),
        tx.pure.vector("u8", blobIdBytes),
        tx.pure.vector("u8", Array.from(Buffer.from(opts.message))),
        // vector<ID> — IDs are 32-byte addresses in Move
        tx.pure.vector("address", parentIds),
        tx.object("0x6"), // Sui Clock singleton
      ],
    });
    tx.setGasBudget(30_000_000);

    const digest = await this.execute(tx);
    return { digest, blobId: memResult.blob_id };
  }

  // ─── recall() ─────────────────────────────────────────────────────────────

  /**
   * Semantic recall across a branch's MemWal namespace.
   * Uses the MemWal relayer's vector search (D-1 confirmed working).
   */
  async recall(
    query: string,
    opts: { branch?: string; limit?: number } = {},
  ): Promise<Array<{ distance: number; blobId: string; text: string }>> {
    const branch = opts.branch ?? (await this.getTree()).default_branch;
    const branchMemwal = this.memwalForBranch(branch);

    const result = await branchMemwal.recall({
      query,
      limit: opts.limit ?? 5,
    });

    return result.results.map(r => ({
      distance: r.distance,
      blobId:   r.blob_id,
      text:     r.text,
    }));
  }

  // ─── grantDelegate() ──────────────────────────────────────────────────────

  /**
   * Grant a DelegateCap to an agent address.
   * Only the tree owner can call this.
   */
  async grantDelegate(
    agent: string,
    opts: {
      branches?: string[];   // empty = all branches
      perms?: PermFlags;     // defaults to WRITE | FORK | PROPOSE
      expiresEpoch?: bigint; // defaults to u64::MAX (no expiry)
    } = {},
  ): Promise<string> {
    const perms       = opts.perms ?? (0x02 | 0x04 | 0x10); // WRITE | FORK | PROPOSE
    const expires     = opts.expiresEpoch ?? BigInt("18446744073709551615"); // u64::MAX
    const branches    = opts.branches ?? [];

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::tree::grant_delegate`,
      arguments: [
        tx.object(this.treeId),
        tx.pure.address(agent),
        // vector<String> — each String is a BCS-length-prefixed UTF-8 byte vector
        tx.pure(bcsEncodeStringVector(branches)),
        tx.pure.u8(perms),
        tx.pure.u64(expires),
      ],
    });
    tx.setGasBudget(15_000_000);
    return this.execute(tx);
  }

  // ─── revokeDelegate() ─────────────────────────────────────────────────────

  /** Revoke a delegate's cap. Only the tree owner can call this. */
  async revokeDelegate(agent: string): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::tree::revoke_delegate`,
      arguments: [
        tx.object(this.treeId),
        tx.pure.address(agent),
      ],
    });
    tx.setGasBudget(10_000_000);
    return this.execute(tx);
  }

  // ─── proposeMerge() ───────────────────────────────────────────────────────

  /**
   * Open a merge proposal for `fromBranch → intoBranch` using the given
   * resolver object.  Requires PROPOSE permission on `fromBranch`.
   *
   * @param ttlMs  TTL in milliseconds (e.g. 86_400_000 = 1 day).
   * @returns      transaction digest
   */
  async proposeMerge(opts: {
    fromBranch: string;
    intoBranch: string;
    resolverId: string;
    ttlMs?: number;
  }): Promise<string> {
    const ttlMs = opts.ttlMs ?? 86_400_000; // default 1 day
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::resolver::propose_merge`,
      arguments: [
        tx.object(this.treeId),
        tx.pure.vector("u8", Array.from(Buffer.from(opts.fromBranch))),
        tx.pure.vector("u8", Array.from(Buffer.from(opts.intoBranch))),
        tx.object(opts.resolverId),
        tx.pure.u64(ttlMs),
        tx.object("0x6"), // Sui Clock singleton
      ],
    });
    tx.setGasBudget(30_000_000);
    return this.execute(tx);
  }

  // ─── submitAttestation() ──────────────────────────────────────────────────

  /**
   * Submit an attestation for an open merge proposal.
   *
   * The Ed25519 signature over `attestPayload` is produced automatically
   * using this client's keypair, satisfying the on-chain content-binding
   * requirement (SPEC §5 — deviation #4 fixed).
   *
   * @param proposalId   Shared MergeProposal object ID.
   * @param resolverId   The ResolverRef governing this proposal.
   * @param attestKind   Attestation kind byte (e.g. 0x01 = JURY_VOTE).
   * @param attestPayload Raw payload bytes (jury vote, LLM output, etc.).
   */
  async submitAttestation(opts: {
    proposalId: string;
    resolverId: string;
    attestKind: number;
    attestPayload: Uint8Array;
  }): Promise<string> {
    const pubkeyBytes = Array.from(this.keypair.getPublicKey().toRawBytes()); // 32 bytes
    const sigBytes    = Array.from(await this.keypair.sign(opts.attestPayload)); // 64 bytes

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
   * Finalize a merge proposal once the resolver verdict is APPROVE.
   * Requires MERGE permission on `intoBranch`.
   *
   * @param resolvedNamespace  The MemWal namespace holding the resolved state.
   * @param resolvedBlobId     The blob ID of the resolved content.
   */
  async finalizeMerge(opts: {
    proposalId: string;
    resolverId: string;
    resolvedNamespace: string;
    resolvedBlobId: string;
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
        tx.object("0x6"), // Sui Clock singleton
      ],
    });
    tx.setGasBudget(40_000_000);
    return this.execute(tx);
  }

  // ─── claimExpired() ───────────────────────────────────────────────────────

  /**
   * Mark a proposal as EXPIRED once its TTL has elapsed.
   * Anyone may call this; the Clock timestamp is verified on-chain.
   */
  async claimExpired(proposalId: string): Promise<string> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::resolver::claim_expired`,
      arguments: [
        tx.object(proposalId),
        tx.object("0x6"), // Sui Clock singleton
      ],
    });
    tx.setGasBudget(10_000_000);
    return this.execute(tx);
  }

  // ─── createResolver() ─────────────────────────────────────────────────────

  /**
   * Create a `ResolverRef` on-chain and transfer it to the caller.
   * Use the `resolvers.*` builders to construct the `def` argument.
   *
   * @example
   *   const def = resolvers.sequence([
   *     resolvers.jury(judgeAddrs, 2, 3),
   *     resolvers.llmReconcile(runnerAddr),
   *   ]);
   *   const { resolverId } = await mem.createResolver(def);
   */
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

    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: this.keypair,
      options: { showObjectChanges: true, showEffects: true },
    });
    if (result.effects?.status.status !== "success") {
      throw new Error(`createResolver failed: ${result.effects?.status.error}`);
    }
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

  /**
   * Poll a `MergeProposal` until it leaves PENDING status.
   * Returns the final status string: `"finalized" | "aborted" | "expired"`.
   *
   * @param proposalId  Shared MergeProposal object ID.
   * @param opts.pollMs      Polling interval (default 3 000 ms).
   * @param opts.timeoutMs   Max wait (default 300 000 ms = 5 min).
   */
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
        throw new Error(`Proposal object not found: ${proposalId}`);
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

  /**
   * Send MIST from this client's signer to another address.
   * Useful for funding judge/runner wallets in tests.
   */
  async transferSui(to: string, amountMist: bigint): Promise<string> {
    const tx = new Transaction();
    const [coin] = tx.splitCoins(tx.gas, [tx.pure.u64(amountMist)]);
    tx.transferObjects([coin], tx.pure.address(to));
    tx.setGasBudget(10_000_000);
    return this.execute(tx);
  }
}
