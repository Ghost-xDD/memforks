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

import { SuiClient, getFullnodeUrl } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { MemWal } from "@mysten-incubation/memwal";
import type { OnChainTree, OnChainCommit, PermFlags } from "./types.js";
import { branchNamespace, PERM_ALL } from "./types.js";

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
  /** MemWal delegate credentials. */
  memwal: MemWalConfig;
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
  readonly memwal: MemWal;
  readonly sponsorUrl: string | undefined;

  private constructor(
    treeId: string,
    packageId: string,
    suiClient: SuiClient,
    keypair: Ed25519Keypair,
    memwal: MemWal,
    sponsorUrl?: string,
  ) {
    this.treeId     = treeId;
    this.packageId  = packageId;
    this.suiClient  = suiClient;
    this.keypair    = keypair;
    this.memwal     = memwal;
    this.sponsorUrl = sponsorUrl;
  }

  // ─── Factory ──────────────────────────────────────────────────────────────

  static async connect(cfg: MemForksClientConfig): Promise<MemForksClient> {
    const network   = cfg.network ?? "testnet";
    const rpcUrl    = cfg.rpcUrl  ?? getFullnodeUrl(network);
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

    const suiClient = new SuiClient({ url: rpcUrl });

    // Build MemWal client using the branch namespace as the default namespace
    // (overridden per operation when a specific branch is needed).
    const memwalClient = MemWal.create({
      key:       cfg.memwal.delegateKey,
      accountId: cfg.memwal.accountId,
      serverUrl: cfg.memwal.serverUrl ?? DEFAULT_RELAYER,
      namespace: `memforks/${cfg.treeId.replace(/^0x/, "")}`,
    });

    return new MemForksClient(
      cfg.treeId,
      packageId,
      suiClient,
      keypair,
      memwalClient,
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
    // MemWal client was created with the tree namespace; re-create with branch ns.
    const branchMemwal = MemWal.create({
      key:       (this.memwal as unknown as { opts: { key: string } }).opts?.key ??
                  (this.memwal as unknown as { _key: string })._key,
      accountId: (this.memwal as unknown as { opts: { accountId: string } }).opts?.accountId ??
                  (this.memwal as unknown as { _accountId: string })._accountId,
      serverUrl: (this.memwal as unknown as { opts: { serverUrl: string } }).opts?.serverUrl ??
                  DEFAULT_RELAYER,
      namespace: ns,
    });
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
        tx.pure.vector("address", parentIds.map(id =>
          // IDs are 0x-prefixed hex strings — pass as raw bytes
          Array.from(Buffer.from(id.replace(/^0x/, ""), "hex"))
        )),
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
    const ns = branchNamespace(this.treeId, branch);

    const branchMemwal = MemWal.create({
      key:       this.memwal["_key"] ?? this.memwal["opts"]?.["key"],
      accountId: this.memwal["_accountId"] ?? this.memwal["opts"]?.["accountId"],
      serverUrl: this.memwal["_serverUrl"] ?? DEFAULT_RELAYER,
      namespace: ns,
    });

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
        tx.pure.vector("address", branches as unknown as string[]),  // vector<String>
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
}
