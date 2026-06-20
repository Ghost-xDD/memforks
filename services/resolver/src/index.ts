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

/**
 * Decode the verdict ("approve" | "reject") from an on-chain attestation
 * payload. The payload is the JSON the jury worker signed:
 * { proposal_id, from_branch, into_branch, vote, reasoning, judge, ts_ms }.
 * Sui may return the byte vector as a number[] or a hex string.
 */
function decodeVerdict(payload: number[] | string | undefined): 'approve' | 'reject' | null {
  if (!payload) return null;
  try {
    let bytes: Uint8Array;
    if (Array.isArray(payload)) {
      bytes = new Uint8Array(payload);
    } else {
      const hex = payload.startsWith('0x') ? payload.slice(2) : payload;
      bytes = new Uint8Array(hex.match(/.{1,2}/g)?.map((b) => parseInt(b, 16)) ?? []);
    }
    const decoded = JSON.parse(new TextDecoder().decode(bytes)) as { vote?: string };
    if (decoded.vote === 'reject') return 'reject';
    if (decoded.vote === 'approve') return 'approve';
    return null;
  } catch {
    return null;
  }
}

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
      if (
        this.config.resolverIdFilter &&
        fields.resolver_id !== this.config.resolverIdFilter
      ) {
        console.log(
          `[runtime] skip ${fields.proposal_id.slice(0, 12)}… — resolver ${fields.resolver_id.slice(0, 10)}… ≠ ours`,
        );
        continue;
      }

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

    // Re-hydrate votes already cast on-chain (handles restarts gracefully).
    // The AttestationSubmitted event does NOT carry the vote payload, so read
    // the proposal object's attestations vector directly — each entry holds the
    // signed JSON payload containing the verdict.
    const judgesVoted = new Set<string>();
    const voteLog: VoteRecord[] = [];
    try {
      const propObj = await this.suiClient.getObject({
        id: proposalId,
        options: { showContent: true },
      });
      if (propObj.data?.content?.dataType === 'moveObject') {
        const pf = propObj.data.content.fields as {
          attestations?: Array<{
            fields?: { signer: string; kind: number; payload: number[] | string };
          } | { signer: string; kind: number; payload: number[] | string }>;
        };
        for (const raw of pf.attestations ?? []) {
          // Sui may wrap struct entries in a `fields` envelope.
          const a = ('fields' in raw ? raw.fields : raw) as {
            signer: string; kind: number; payload: number[] | string;
          };
          if (!a?.signer) continue;
          judgesVoted.add(a.signer);
          const verdict = decodeVerdict(a.payload);
          if (verdict) {
            voteLog.push({
              judge:     a.signer,
              verdict,
              reasoning: '(recovered from chain on restart)',
              txDigest:  '',
            });
          }
        }
      }
    } catch {
      // Attestation read failed — proceed without pre-hydration; worst case re-votes.
    }

    const juryConfig = kind === RESOLVER_KIND.JURY_RECONCILE ? decodeJuryConfig(config) : null;
    const hasLlm = this.hasLlmChild(kind, config);
    let phase: ProposalState['phase'];

    if (juryConfig != null) {
      const approves = voteLog.filter((v) => v.verdict === 'approve').length;
      const rejects  = voteLog.filter((v) => v.verdict === 'reject').length;
      const { k } = juryConfig;
      const n = juryConfig.judges.length;

      if (approves >= k) {
        phase = hasLlm ? 'llm' : 'finalizing';
        console.log(
          `[runtime] proposal ${proposalId.slice(0, 12)}… already approved (${approves}/${n}) — resuming at ${phase}`,
        );
      } else if (rejects > n - k) {
        phase = 'aborting';
        console.log(
          `[runtime] proposal ${proposalId.slice(0, 12)}… already rejected (${rejects}/${n}) — resuming at aborting`,
        );
      } else {
        phase = this.initialPhase(kind);
        if (judgesVoted.size > 0) {
          console.log(
            `[runtime] proposal ${proposalId.slice(0, 12)}… has ${approves} approve / ${rejects} reject — resuming jury`,
          );
        }
      }
    } else {
      phase = this.initialPhase(kind);
    }

    this.proposals.set(proposalId, {
      proposalId,
      treeId,
      fromBranch,
      intoBranch,
      resolverId,
      resolverKind: kind,
      resolverConfig: config,
      phase,
      judgesVoted,
      voteLog,
      firstSeenMs: Date.now(),
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

    if (state.phase === 'jury')      await this.stepJury(state);
    if (state.phase === 'llm')       await this.stepLlm(state);
    if (state.phase === 'finalizing') await this.stepFinalize(state);
    if (state.phase === 'aborting')   await this.stepAbort(state);
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

    const { judges } = juryConfig;
    const eligibleWorkers = this.juryWorkers.filter((w) =>
      judges.includes(w.suiAddress),
    );

    if (eligibleWorkers.length === 0) {
      console.warn(
        `[runtime] no eligible judge workers for proposal ${state.proposalId.slice(0, 12)}…`,
      );
      return;
    }

    // Collection window: wait briefly before the first vote so any competing
    // sibling proposals (same into_branch) have time to arrive. Without this, a
    // lone proposal would be voted/finalized before its rival lands, and the two
    // would never be arbitrated as one contest. The wait applies once per
    // proposal, keyed off when it was first seen.
    const windowMs = this.config.contestWindowMs ?? 8_000;
    if (state.judgesVoted.size === 0 && Date.now() - state.firstSeenMs < windowMs) {
      return; // still collecting competitors
    }

    // A contest is 2+ pending proposals targeting the same into_branch.
    // Competing strategies must be arbitrated as ONE comparative decision
    // (one winner, rest aborted), not finalized independently.
    const contestants = this.contestantsFor(state);

    if (contestants.length >= 2) {
      await this.runContestVoting(contestants, eligibleWorkers);
    } else {
      await this.runSoloVoting(state, eligibleWorkers);
    }

    this.applyJuryQuorum(state, juryConfig);
  }

  /** Pending jury-phase proposals targeting the same into_branch (incl. `state`). */
  private contestantsFor(
    state: ProposalState & { resolverId: string },
  ): Array<ProposalState & { resolverId: string }> {
    const out: Array<ProposalState & { resolverId: string }> = [];
    for (const [, s] of this.proposals) {
      if (s.treeId !== state.treeId) continue;
      if (s.intoBranch !== state.intoBranch) continue;
      if (s.phase !== 'jury') continue;
      out.push(s);
    }
    return out;
  }

  /** Single-proposal jury voting (no competitors). */
  private async runSoloVoting(
    state: ProposalState & { resolverId: string },
    eligibleWorkers: JuryWorker[],
  ): Promise<void> {
    const [fromContent, intoContent] = await Promise.all([
      this.fetchBranchContent(state.treeId, state.fromBranch),
      this.fetchBranchContent(state.treeId, state.intoBranch),
    ]);

    for (const worker of eligibleWorkers) {
      if (state.judgesVoted.has(worker.suiAddress)) continue;
      const result = await worker.vote(state, fromContent, intoContent, undefined);
      state.judgesVoted.add(worker.suiAddress);
      state.voteLog.push({
        judge:     worker.suiAddress,
        verdict:   result.verdict,
        reasoning: result.reasoning,
        txDigest:  result.txDigest,
      } satisfies VoteRecord);
    }
  }

  /**
   * Comparative contest voting: each judge picks the single best branch among
   * the contestants, then submits an `approve` attestation for the winner and
   * `reject` for the rest. The existing quorum logic then finalizes the winner
   * and aborts the losers.
   */
  private async runContestVoting(
    contestants: Array<ProposalState & { resolverId: string }>,
    eligibleWorkers: JuryWorker[],
  ): Promise<void> {
    const intoBranch  = contestants[0]!.intoBranch;
    const treeId      = contestants[0]!.treeId;
    const intoContent = await this.fetchBranchContent(treeId, intoBranch);

    // Fetch each contestant's branch content once.
    const contentByBranch = new Map<string, string>();
    for (const c of contestants) {
      contentByBranch.set(c.fromBranch, await this.fetchBranchContent(treeId, c.fromBranch));
    }

    for (const worker of eligibleWorkers) {
      // Skip judges who already voted across the contest.
      if (contestants.every((c) => c.judgesVoted.has(worker.suiAddress))) continue;

      const { winner, reasoning } = await worker.voteContest(
        contestants.map((c) => ({
          fromBranch: c.fromBranch,
          content:    contentByBranch.get(c.fromBranch) ?? '',
        })),
        intoBranch,
        intoContent,
      );

      console.log(
        `  [judge ${worker.suiAddress.slice(0, 10)}…] contest pick: ${winner}`,
      );

      for (const c of contestants) {
        if (c.judgesVoted.has(worker.suiAddress)) continue;
        const verdict: 'approve' | 'reject' =
          c.fromBranch === winner ? 'approve' : 'reject';
        const { txDigest } = await worker.submitVote(c, verdict, reasoning);
        c.judgesVoted.add(worker.suiAddress);
        c.voteLog.push({
          judge:     worker.suiAddress,
          verdict,
          reasoning,
          txDigest,
        } satisfies VoteRecord);
      }
    }
  }

  /** Advance a proposal's phase based on its accumulated approve/reject votes. */
  private applyJuryQuorum(
    state: ProposalState & { resolverId: string },
    juryConfig: { judges: string[]; k: number },
  ): void {
    const approves = state.voteLog.filter((v) => v.verdict === 'approve').length;
    const rejects  = state.voteLog.filter((v) => v.verdict === 'reject').length;
    const k = juryConfig.k;
    const n = juryConfig.judges.length;

    if (approves >= k) {
      const hasLlm = this.hasLlmChild(state.resolverKind, state.resolverConfig);
      state.phase = hasLlm ? 'llm' : 'finalizing';
      console.log(`[runtime] jury approved ${state.fromBranch} (${approves}/${n}) — moving to ${state.phase}`);
    } else if (rejects > n - k) {
      state.phase = 'aborting';
      console.log(`[runtime] jury rejected ${state.fromBranch} (${rejects}/${n}, need ${k}) — aborting`);
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

  // ─── Abort phase ────────────────────────────────────────────────────────

  private async stepAbort(
    state: ProposalState & { resolverId: string },
  ): Promise<void> {
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.config.packageId}::resolver::abort_merge`,
      arguments: [
        tx.object(state.treeId),
        tx.object(state.proposalId),
      ],
    });
    tx.setGasBudget(10_000_000);

    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: this.finalizer,
      options: { showEffects: true },
    });
    if (result.effects?.status.status !== 'success') {
      throw new Error(`abort_merge failed: ${result.effects?.status.error}`);
    }
    state.phase = 'aborted';
    console.log(
      `[runtime] ✗ aborted proposal ${state.proposalId.slice(0, 12)}… — tx ${result.digest}`,
    );

    // Write rejection rationale to the losing branch.
    void this.writeRejectionRationale(state).catch((err) =>
      console.warn('[runtime] rejection rationale writeback failed:', err),
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

  // ─── GAP-3: rationale writeback ─────────────────────────────────────────

  private async writeRationaleWriteback(
    winner: ProposalState & { resolverId: string },
  ): Promise<void> {
    if (!this.config.memwal) return;

    const { voteLog, fromBranch, intoBranch, treeId } = winner;
    const approveCount = voteLog.filter((v) => v.verdict === 'approve').length;
    const totalCount   = voteLog.length || 1;
    const reasoningSummary = [
      ...new Set(
        voteLog
          .filter((v) => v.reasoning && v.reasoning !== 'auto-approve (no LLM configured)')
          .map((v) => v.reasoning!.trim()),
      ),
    ]
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

  private async writeRejectionRationale(
    state: ProposalState & { resolverId: string },
  ): Promise<void> {
    if (!this.config.memwal) return;

    const { voteLog, fromBranch, intoBranch, treeId } = state;
    const approveCount = voteLog.filter((v) => v.verdict === 'approve').length;
    const rejectCount  = voteLog.filter((v) => v.verdict === 'reject').length;
    const reasoningSummary = [
      ...new Set(
        voteLog
          .filter((v) => v.verdict === 'reject' && v.reasoning && v.reasoning !== 'auto-approve (no LLM configured)')
          .map((v) => v.reasoning!.trim()),
      ),
    ]
      .slice(0, 2)
      .join(' | ');

    const rejectedFact =
      `rejected: ${fromBranch} → ${intoBranch} merge denied by jury vote ` +
      `(${approveCount} approve, ${rejectCount} reject).` +
      (reasoningSummary ? ` Reasoning: ${reasoningSummary}` : '');

    await this.writeToBranch(treeId, fromBranch, rejectedFact);
    console.log(`[runtime] ✓ rejection rationale written to ${fromBranch}`);
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
    const rawValue = (headField.data.content.fields as { value: unknown }).value;

    // The branches table value IS the blob ID — stored as a UTF-8 byte vector.
    // It is NOT a Sui object ID. Decode the bytes to get the MemWal blob ID string.
    let blobId = '';
    if (Array.isArray(rawValue) && rawValue.length > 0) {
      blobId = Buffer.from(rawValue as number[]).toString('utf8');
    } else if (typeof rawValue === 'string' && rawValue.length > 0) {
      blobId = rawValue;
    }
    // else: branch has no committed head (empty / null) → blobId stays ''

    if (!blobId) {
      console.log(`[runtime] branch "${branch}" has no committed head — using empty blobId`);
    }

    return { commitId: '', blobId };
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
    contestWindowMs: process.env['MEMFORK_CONTEST_WINDOW_MS']
      ? Number(process.env['MEMFORK_CONTEST_WINDOW_MS'])
      : 8_000,
    resolverIdFilter: process.env['MEMFORK_RESOLVER_ID'] || undefined,
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
