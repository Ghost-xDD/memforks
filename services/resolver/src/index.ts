/**
 * MemForks off-chain resolver runtime.
 *
 * Polls Sui for `MergeProposed` events and drives the full merge ceremony:
 *
 *   MergeProposed → [jury workers vote] → [LLM runner reconciles] → finalize_merge
 *
 * Architecture
 * ────────────
 *   - One `MergeProposalRuntime` per deployment (singleton event loop).
 *   - One `JuryWorker` per configured judge keypair.
 *   - One `LlmWorker` per LLM runner (optional).
 *   - A map of `ProposalState` tracks in-flight proposals.
 *
 * Start:  `npm start` or `tsx src/index.ts`
 * Config: .env.local (see .env.example)
 */

import 'dotenv/config';
import {
  SuiJsonRpcClient as SuiClient,
  JsonRpcHTTPTransport,
} from '@mysten/sui/jsonRpc';
import type { EventId } from '@mysten/sui/jsonRpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Transaction } from '@mysten/sui/transactions';
import { MemWal } from '@mysten-incubation/memwal';
import {
  RESOLVER_KIND,
  PROPOSAL_STATUS,
  branchNamespace,
  decodeJuryConfig,
  decodeLlmConfig,
  decodeChildren,
  onChainBytesToUint8Array,
} from './bcs.js';
import { JuryWorker } from './workers/jury.js';
import { LlmWorker } from './workers/llm.js';
import type { ProposalState, VoteRecord, RuntimeConfig } from './types.js';

// ─── Runtime ─────────────────────────────────────────────────────────────────

export class MergeProposalRuntime {
  private readonly suiClient: SuiClient;
  private readonly finalizer: Ed25519Keypair;
  private readonly juryWorkers: JuryWorker[];
  private readonly llmWorker: LlmWorker | undefined;
  private readonly proposals = new Map<
    string,
    ProposalState & { resolverId: string }
  >();
  private cursor: EventId | null | undefined = null;

  constructor(private readonly config: RuntimeConfig) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.suiClient = new SuiClient({
      transport: new JsonRpcHTTPTransport({ url: config.rpcUrl }),
      network: 'testnet',
    } as any);

    const { secretKey } = decodeSuiPrivateKey(config.finalizerKey);
    this.finalizer = Ed25519Keypair.fromSecretKey(secretKey);

    this.juryWorkers = config.judges.map(
      (j) => new JuryWorker(j, this.suiClient, config.packageId),
    );

    if (config.llmRunner && config.memwal) {
      this.llmWorker = new LlmWorker(
        config.llmRunner,
        config.memwal,
        this.suiClient,
        config.packageId,
      );
    }
  }

  /** Start the event loop.  Runs until the process is killed. */
  async start(): Promise<void> {
    const interval = this.config.pollIntervalMs ?? 5_000;
    console.log(`[runtime] started — polling every ${interval}ms`);
    console.log(
      `[runtime] judges : ${this.juryWorkers.map((j) => j.suiAddress.slice(0, 10) + '…').join(', ')}`,
    );
    if (this.llmWorker) {
      console.log(
        `[runtime] llm    : ${this.llmWorker.suiAddress.slice(0, 10)}…`,
      );
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        await this.poll();
        await this.driveInFlight();
      } catch (err) {
        console.error('[runtime] poll error:', err);
      }
      await sleep(interval);
    }
  }

  // ─── Event polling ──────────────────────────────────────────────────────

  private async poll(): Promise<void> {
    const result = await this.suiClient.queryEvents({
      query: {
        MoveEventType: `${this.config.packageId}::resolver::MergeProposed`,
      },
      cursor: this.cursor ?? undefined,
      limit: 50,
      order: 'ascending',
    });

    for (const evt of result.data) {
      const fields = evt.parsedJson as {
        tree_id: string;
        proposal_id: string;
        from_branch: string;
        into_branch: string;
        resolver_id: string;
        expires_at_ms: string;
      };

      if (fields.tree_id !== this.config.treeId) continue;
      if (this.proposals.has(fields.proposal_id)) continue;

      console.log(
        `[runtime] new proposal ${fields.proposal_id.slice(0, 12)}… (${fields.from_branch} → ${fields.into_branch})`,
      );
      await this.initProposal(
        fields.proposal_id,
        fields.resolver_id,
        fields.from_branch,
        fields.into_branch,
        fields.tree_id,
      );
    }

    if (result.nextCursor)
      this.cursor = result.nextCursor as unknown as EventId;
  }

  private async initProposal(
    proposalId: string,
    resolverId: string,
    fromBranch: string,
    intoBranch: string,
    treeId: string,
  ): Promise<void> {
    // Read the ResolverRef to get kind + config.
    const resolverObj = await this.suiClient.getObject({
      id: resolverId,
      options: { showContent: true },
    });
    if (
      !resolverObj.data?.content ||
      resolverObj.data.content.dataType !== 'moveObject'
    ) {
      console.warn(`[runtime] resolver object not found: ${resolverId}`);
      return;
    }
    const fields = resolverObj.data.content.fields as {
      kind: number;
      config: number[] | string;
    };
    const kind = Number(fields.kind);
    const config = onChainBytesToUint8Array(fields.config);

    this.proposals.set(proposalId, {
      proposalId,
      treeId,
      fromBranch,
      intoBranch,
      resolverId,
      resolverKind: kind,
      resolverConfig: config,
      phase: this.initialPhase(kind),
      judgesVoted: new Set(),
      voteLog: [],
    });
  }

  private initialPhase(kind: number): ProposalState['phase'] {
    if (kind === RESOLVER_KIND.JURY_RECONCILE) return 'jury';
    if (kind === RESOLVER_KIND.LLM_RECONCILE) return 'llm';
    if (kind === RESOLVER_KIND.SEQUENCE || kind === RESOLVER_KIND.AND)
      return 'jury';
    // LWW / UNION don't need attestations — go straight to finalizing.
    return 'finalizing';
  }

  // ─── In-flight proposal driving ────────────────────────────────────────

  private async driveInFlight(): Promise<void> {
    for (const state of this.proposals.values()) {
      if (state.phase === 'done' || state.phase === 'aborted') continue;
      try {
        await this.step(state);
      } catch (err) {
        console.error(
          `[runtime] error driving ${state.proposalId.slice(0, 12)}…:`,
          err,
        );
      }
    }
  }

  private async step(
    state: ProposalState & { resolverId: string },
  ): Promise<void> {
    // Check if the proposal has already moved off PENDING on-chain.
    const onChainStatus = await this.fetchProposalStatus(state.proposalId);
    if (onChainStatus !== PROPOSAL_STATUS.PENDING) {
      state.phase =
        onChainStatus === PROPOSAL_STATUS.FINALIZED ? 'done' : 'aborted';
      return;
    }

    if (state.phase === 'jury') await this.stepJury(state);
    if (state.phase === 'llm') await this.stepLlm(state);
    if (state.phase === 'finalizing') await this.stepFinalize(state);
  }

  // ─── Jury phase ─────────────────────────────────────────────────────────

  private async stepJury(
    state: ProposalState & { resolverId: string },
  ): Promise<void> {
    const juryConfig = this.resolveJuryConfig(
      state.resolverKind,
      state.resolverConfig,
    );
    if (!juryConfig) {
      state.phase = 'llm';
      return;
    }

    const { judges, k } = juryConfig;
    const eligibleWorkers = this.juryWorkers.filter((w) =>
      judges.includes(w.suiAddress),
    );

    if (eligibleWorkers.length === 0) {
      console.warn(
        `[runtime] no eligible judge workers for proposal ${state.proposalId.slice(0, 12)}…`,
      );
      return;
    }

    // Fetch branch contents for evaluation.
    const [fromContent, intoContent] = await Promise.all([
      this.fetchBranchContent(state.treeId, state.fromBranch),
      this.fetchBranchContent(state.treeId, state.intoBranch),
    ]);

    // GAP-2: find competing proposals targeting the same intoBranch and pass
    // their content to the judge so it can vote "approve at most one".
    const competingContent = this.buildCompetingContent(state);

    // Have each unvoted eligible worker submit a vote.
    for (const worker of eligibleWorkers) {
      if (state.judgesVoted.has(worker.suiAddress)) continue;
      const result = await worker.vote(state, fromContent, intoContent, competingContent);
      state.judgesVoted.add(worker.suiAddress);
      state.voteLog.push({
        judge:    worker.suiAddress,
        verdict:  result.verdict,
        reasoning: result.reasoning,
        txDigest: result.txDigest,
      } satisfies VoteRecord);
    }

    // Check if we have enough votes to advance.
    if (state.judgesVoted.size >= k) {
      // Determine next phase: check if there's an LLM child.
      const hasLlm = this.hasLlmChild(state.resolverKind, state.resolverConfig);
      state.phase = hasLlm ? 'llm' : 'finalizing';
      console.log(`[runtime] jury quorum reached — moving to ${state.phase}`);
    }
  }

  private resolveJuryConfig(kind: number, config: Uint8Array) {
    if (kind === RESOLVER_KIND.JURY_RECONCILE) return decodeJuryConfig(config);
    if (kind === RESOLVER_KIND.SEQUENCE || kind === RESOLVER_KIND.AND) {
      const children = decodeChildren(config);
      const juryChild = children.find(
        (c) => c.kind === RESOLVER_KIND.JURY_RECONCILE,
      );
      return juryChild ? decodeJuryConfig(juryChild.config) : null;
    }
    return null;
  }

  private hasLlmChild(kind: number, config: Uint8Array): boolean {
    if (kind === RESOLVER_KIND.LLM_RECONCILE) return true;
    if (kind === RESOLVER_KIND.SEQUENCE || kind === RESOLVER_KIND.AND) {
      return decodeChildren(config).some(
        (c) => c.kind === RESOLVER_KIND.LLM_RECONCILE,
      );
    }
    return false;
  }

  // ─── LLM reconcile phase ────────────────────────────────────────────────

  private async stepLlm(
    state: ProposalState & { resolverId: string },
  ): Promise<void> {
    if (!this.llmWorker) {
      console.warn(
        '[runtime] LLM phase required but no llmWorker configured — skipping to finalizing',
      );
      state.phase = 'finalizing';
      return;
    }

    const llmConfig = this.resolveLlmConfig(
      state.resolverKind,
      state.resolverConfig,
    );
    // If a runner address is specified, verify this worker is authorised.
    if (llmConfig.runner && llmConfig.runner !== this.llmWorker.suiAddress) {
      console.warn(
        `[runtime] LLM runner mismatch — expected ${llmConfig.runner}`,
      );
      return;
    }

    const [fromContent, intoContent] = await Promise.all([
      this.fetchBranchContent(state.treeId, state.fromBranch),
      this.fetchBranchContent(state.treeId, state.intoBranch),
    ]);

    const resolvedNamespace = branchNamespace(state.treeId, state.intoBranch);
    const { resolvedBlobId } = await this.llmWorker.reconcile(
      state,
      fromContent,
      intoContent,
      resolvedNamespace,
    );

    state.resolvedNamespace = resolvedNamespace;
    state.resolvedBlobId = resolvedBlobId;
    state.phase = 'finalizing';
    console.log(`[runtime] LLM reconcile done — blob ${resolvedBlobId}`);
  }

  private resolveLlmConfig(kind: number, config: Uint8Array) {
    if (kind === RESOLVER_KIND.LLM_RECONCILE) return decodeLlmConfig(config);
    if (kind === RESOLVER_KIND.SEQUENCE || kind === RESOLVER_KIND.AND) {
      const children = decodeChildren(config);
      const llmChild = children.find(
        (c) => c.kind === RESOLVER_KIND.LLM_RECONCILE,
      );
      return llmChild ? decodeLlmConfig(llmChild.config) : {};
    }
    return {};
  }

  // ─── Finalize phase ─────────────────────────────────────────────────────

  private async stepFinalize(
    state: ProposalState & { resolverId: string },
  ): Promise<void> {
    // For LWW/UNION, resolve to the from_branch head; otherwise use LLM output.
    if (!state.resolvedNamespace || !state.resolvedBlobId) {
      // Resolve to from_branch head (LWW / no-LLM JURY).
      const head = await this.fetchBranchHead(state.treeId, state.fromBranch);
      state.resolvedNamespace = branchNamespace(state.treeId, state.intoBranch);
      state.resolvedBlobId = head.blobId;
    }

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.config.packageId}::resolver::finalize_merge`,
      arguments: [
        tx.object(state.treeId),
        tx.object(state.proposalId),
        tx.object(state.resolverId),
        tx.pure.vector('u8', Array.from(Buffer.from(state.resolvedNamespace))),
        tx.pure.vector(
          'u8',
          Array.from(Buffer.from(state.resolvedBlobId, 'utf8')),
        ),
        tx.object('0x6'), // Clock singleton
      ],
    });
    tx.setGasBudget(40_000_000);

    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: this.finalizer,
      options: { showEffects: true, showEvents: true },
    });
    if (result.effects?.status.status !== 'success') {
      throw new Error(`finalize_merge failed: ${result.effects?.status.error}`);
    }
    state.phase = 'done';
    console.log(
      `[runtime] ✓ finalized proposal ${state.proposalId.slice(0, 12)}… — tx ${result.digest}`,
    );

    // GAP-3: write rationale facts to the winning branch's into_branch (main)
    // and to any competing branches that are now going to lose.
    void this.writeRationaleWriteback(state).catch((err) =>
      console.warn('[runtime] rationale writeback failed:', err),
    );
  }

  // ─── Helpers ────────────────────────────────────────────────────────────

  private async fetchProposalStatus(proposalId: string): Promise<number> {
    const obj = await this.suiClient.getObject({
      id: proposalId,
      options: { showContent: true },
    });
    if (!obj.data?.content || obj.data.content.dataType !== 'moveObject')
      return -1;
    const fields = obj.data.content.fields as { status: number };
    return Number(fields.status);
  }

  private async fetchBranchContent(
    treeId: string,
    branch: string,
  ): Promise<string> {
    if (!this.config.memwal) return `[branch ${branch} — no memwal configured]`;
    const memwal = MemWal.create({
      key: this.config.memwal.delegateKey,
      accountId: this.config.memwal.accountId,
      serverUrl:
        this.config.memwal.serverUrl ??
        'https://relayer-staging.memory.walrus.xyz',
      namespace: branchNamespace(treeId, branch),
    });
    const result = await memwal.recall({ query: '*', limit: 20 });
    return result.results.map((r) => r.text).join('\n');
  }

  // ─── GAP-2: competing-proposal content builder ──────────────────────────

  private buildCompetingContent(
    current: ProposalState & { resolverId: string },
  ): string | undefined {
    const competitors: string[] = [];
    for (const [, state] of this.proposals) {
      if (state === current) continue;
      if (state.intoBranch !== current.intoBranch) continue;
      if (state.phase === 'done' || state.phase === 'aborted') continue;
      competitors.push(`Branch "${state.fromBranch}" (also proposing to merge into "${state.intoBranch}")`);
    }
    return competitors.length > 0 ? competitors.join('\n') : undefined;
  }

  // ─── GAP-3: rationale writeback ─────────────────────────────────────────

  private async writeRationaleWriteback(
    winner: ProposalState & { resolverId: string },
  ): Promise<void> {
    if (!this.config.memwal) return;

    const { voteLog, fromBranch, intoBranch, treeId } = winner;
    const approveCount = voteLog.filter((v) => v.verdict === 'approve').length;
    const totalCount   = voteLog.length || 1;
    const reasoningSummary = voteLog
      .filter((v) => v.reasoning && v.reasoning !== 'auto-approve (no LLM configured)')
      .map((v) => v.reasoning)
      .slice(0, 2)
      .join(' | ');

    // Write "decided" fact to the winning into_branch (main).
    const decidedFact =
      `decided: Use ${fromBranch} approach. ` +
      `Jury voted ${approveCount}-of-${totalCount}.` +
      (reasoningSummary ? ` Reasoning: ${reasoningSummary}` : '');
    await this.writeToBranch(treeId, intoBranch, decidedFact);

    // Find competing proposals targeting the same into_branch and write
    // "rejected" facts to their fromBranch, plus a pointer fact to main.
    for (const [, state] of this.proposals) {
      if (state === winner) continue;
      if (state.intoBranch !== intoBranch) continue;

      const rejectedFact =
        `rejected: ${intoBranch} merge denied — jury voted ${approveCount}-of-${totalCount} for ${fromBranch}. ` +
        `Lower upside / weaker evidence. ` +
        `Rejected path: ${state.fromBranch}@latest remains queryable for audit. ` +
        `Winning path: ${fromBranch}.` +
        (reasoningSummary ? ` Reasoning: ${reasoningSummary}` : '');
      await this.writeToBranch(treeId, state.fromBranch, rejectedFact);

      // Also write a pointer into main so recall on main mentions the loser.
      const pointerFact =
        `rejected-path: ${state.fromBranch} was not merged. ` +
        `Query branch ${state.fromBranch} for full audit trail.`;
      await this.writeToBranch(treeId, intoBranch, pointerFact);

      console.log(`[runtime] ✓ rejection rationale written to ${state.fromBranch}`);
    }
  }

  private async writeToBranch(
    treeId: string,
    branch: string,
    text: string,
  ): Promise<void> {
    if (!this.config.memwal) return;
    const memwal = MemWal.create({
      key:       this.config.memwal.delegateKey,
      accountId: this.config.memwal.accountId,
      serverUrl: this.config.memwal.serverUrl ?? 'https://relayer-staging.memory.walrus.xyz',
      namespace: branchNamespace(treeId, branch),
    });
    await memwal.remember(text);
  }

  private async fetchBranchHead(
    treeId: string,
    branch: string,
  ): Promise<{ commitId: string; blobId: string }> {
    // Walk the tree's branches table to find the head commit.
    const tree = await this.suiClient.getObject({
      id: treeId,
      options: { showContent: true },
    });
    if (!tree.data?.content || tree.data.content.dataType !== 'moveObject') {
      throw new Error(`Tree not found: ${treeId}`);
    }
    const treeFields = tree.data.content.fields as {
      branches: { fields: { id: { id: string } } };
    };
    const tableId = treeFields.branches.fields.id.id;

    const headField = await this.suiClient.getDynamicFieldObject({
      parentId: tableId,
      name: { type: '0x1::string::String', value: branch },
    });
    if (
      !headField.data?.content ||
      headField.data.content.dataType !== 'moveObject'
    ) {
      throw new Error(`Branch "${branch}" not found`);
    }
    const commitId = (headField.data.content.fields as { value: string }).value;

    const commitObj = await this.suiClient.getObject({
      id: commitId,
      options: { showContent: true },
    });
    if (
      !commitObj.data?.content ||
      commitObj.data.content.dataType !== 'moveObject'
    ) {
      throw new Error(`Commit not found: ${commitId}`);
    }
    const commitFields = commitObj.data.content.fields as {
      memwal_blob_id: number[] | string | undefined;
    };
    const rawBlobId = commitFields.memwal_blob_id ?? [];
    const blobId = Array.isArray(rawBlobId)
      ? Buffer.from(rawBlobId).toString('utf8')
      : String(rawBlobId);

    return { commitId, blobId };
  }
}

// ─── main ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  // Build config from environment variables.
  const config: RuntimeConfig = {
    rpcUrl: process.env['SUI_RPC_URL'] ?? 'https://fullnode.testnet.sui.io:443',
    packageId: process.env['MEMFORKS_PACKAGE_ID'] ?? '',
    treeId: process.env['MEMFORKS_TREE_ID'] ?? '',
    finalizerKey: process.env['FINALIZER_PRIVATE_KEY'] ?? '',
    judges: [],
    pollIntervalMs: 5_000,
  };

  if (!config.packageId || !config.treeId || !config.finalizerKey) {
    throw new Error(
      'MEMFORKS_PACKAGE_ID, MEMFORKS_TREE_ID, FINALIZER_PRIVATE_KEY must be set',
    );
  }

  // Load judges: JUDGE_0_KEY, JUDGE_1_KEY, … up to 16.
  for (let i = 0; i < 16; i++) {
    const key = process.env[`JUDGE_${i}_KEY`];
    if (!key) break;
    config.judges.push({
      privateKey: key,
      llm: process.env[`JUDGE_${i}_LLM_API_KEY`]
        ? {
            provider: (process.env[`JUDGE_${i}_LLM_PROVIDER`] ?? 'openai') as
              | 'openai'
              | 'anthropic',
            model: process.env[`JUDGE_${i}_LLM_MODEL`] ?? 'gpt-4o-mini',
            apiKey: process.env[`JUDGE_${i}_LLM_API_KEY`]!,
          }
        : undefined,
    });
  }

  // LLM runner.
  if (process.env['LLM_RUNNER_KEY'] && process.env['LLM_RUNNER_API_KEY']) {
    config.llmRunner = {
      privateKey: process.env['LLM_RUNNER_KEY'],
      llm: {
        provider: (process.env['LLM_RUNNER_PROVIDER'] ?? 'openai') as
          | 'openai'
          | 'anthropic',
        model: process.env['LLM_RUNNER_MODEL'] ?? 'gpt-4o',
        apiKey: process.env['LLM_RUNNER_API_KEY'],
      },
    };
  }

  // MemWal.
  if (process.env['MEMFORKS_MEMWAL_KEY'] && process.env['MEMWAL_ACCOUNT_ID']) {
    config.memwal = {
      delegateKey: process.env['MEMFORKS_MEMWAL_KEY'],
      accountId: process.env['MEMWAL_ACCOUNT_ID'],
      serverUrl: process.env['MEMWAL_SERVER_URL'],
    };
  }

  const runtime = new MergeProposalRuntime(config);
  await runtime.start();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
