/**
 * Jury worker — one instance per configured judge.
 *
 * When a MergeProposed event arrives the worker:
 *   1. Reads both branch heads from MemWal (or commit objects).
 *   2. Optionally consults an LLM to evaluate which branch is "better".
 *   3. Signs and submits a JURY_VOTE attestation via submit_attestation.
 *
 * The payload is a JSON object (CBOR-compatible) containing the vote and,
 * optionally, the judge's reasoning.  The on-chain Ed25519 sig covers the
 * raw payload bytes — no separate CBOR encoding is required for correctness
 * (SPEC §B.2 applies to the content, not the wire format of the sig check).
 */

import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import OpenAI from "openai";
import type { JudgeConfig, ProposalState } from "../types.js";
import { assertTxSuccess, type SuiGrpcClient } from "../sui.js";

type ProposalWithResolver = ProposalState & { resolverId: string };

const ATTEST_JURY_VOTE = 0x01;

export class JuryWorker {
  private readonly keypair: Ed25519Keypair;
  private readonly address: string;
  private readonly openai: OpenAI | undefined;

  constructor(
    private readonly config: JudgeConfig,
    private readonly suiClient: SuiGrpcClient,
    private readonly packageId: string,
  ) {
    const { secretKey } = decodeSuiPrivateKey(config.privateKey);
    this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
    this.address = this.keypair.toSuiAddress();

    if (config.llm?.provider === "openai") {
      this.openai = new OpenAI({ apiKey: config.llm.apiKey });
    }
  }

  get suiAddress(): string { return this.address; }

  /** Evaluate then submit a JURY_VOTE attestation for a single proposal. */
  async vote(
    state: ProposalWithResolver,
    fromContent: string,
    intoContent: string,
    competingContent?: string,
  ): Promise<{ txDigest: string; verdict: "approve" | "reject"; reasoning: string }> {
    const { verdict, reasoning } = await this.evaluate(
      state,
      fromContent,
      intoContent,
      competingContent,
    );
    const { txDigest } = await this.submitVote(state, verdict, reasoning);
    return { txDigest, verdict, reasoning };
  }

  /**
   * Submit a JURY_VOTE attestation with a pre-decided verdict. Used by the
   * contest path, where the verdict is derived from a single comparative
   * selection across all competing proposals.
   */
  async submitVote(
    state: ProposalWithResolver,
    verdict: "approve" | "reject",
    reasoning: string,
  ): Promise<{ txDigest: string }> {
    // Build CBOR-compatible JSON payload (deterministic key order).
    const payload = Buffer.from(JSON.stringify({
      proposal_id:        state.proposalId,
      from_branch:        state.fromBranch,
      into_branch:        state.intoBranch,
      vote:               verdict,
      reasoning,
      judge:              this.address,
      ts_ms:              Date.now(),
    }));

    // Sign the payload bytes (content binding — SPEC §5).
    const pubkeyBytes = Array.from(this.keypair.getPublicKey().toRawBytes());
    const sigBytes    = Array.from(await this.keypair.sign(payload));

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::resolver::submit_attestation`,
      arguments: [
        tx.object(state.proposalId),
        tx.object(state.resolverId),
        tx.pure.u8(ATTEST_JURY_VOTE),
        tx.pure.vector("u8", Array.from(payload)),
        tx.pure.vector("u8", pubkeyBytes),
        tx.pure.vector("u8", sigBytes),
      ],
    });
    tx.setGasBudget(25_000_000);

    const result = await this.suiClient.signAndExecuteTransaction({
      transaction: tx,
      signer: this.keypair,
      include: { effects: true },
    });
    const txDigest = assertTxSuccess(result, "JURY_VOTE");
    console.log(`  [judge ${this.address.slice(0, 10)}…] voted "${verdict}" on ${state.fromBranch} — tx ${txDigest}`);
    return { txDigest };
  }

  /**
   * Comparative contest selection: pick the single best branch among competing
   * proposals targeting the same into_branch. Returns the winning from_branch
   * name plus the judge's reasoning. With no LLM configured, defaults to the
   * first contestant (deterministic).
   */
  async voteContest(
    contestants: { fromBranch: string; content: string }[],
    intoBranch: string,
    intoContent: string,
  ): Promise<{ winner: string; reasoning: string }> {
    const fallback = contestants[0]?.fromBranch ?? "";
    if (!this.openai) {
      return { winner: fallback, reasoning: "auto-select first (no LLM configured)" };
    }

    const prompt = [
      `You are a neutral judge selecting the single best memory merge among competing proposals.`,
      ``,
      `Target branch "${intoBranch}" current content:`,
      intoContent || "(empty)",
      ``,
      `Competing proposals — choose exactly ONE winner:`,
      ...contestants.map(
        (c) => `\nBranch "${c.fromBranch}":\n${c.content || "(empty)"}`,
      ),
      ``,
      `Reply with a JSON object: {"winner":"<exact from_branch name>","reasoning":"..."}`,
    ].join("\n");

    const completion = await this.openai.chat.completions.create({
      model:       this.config.llm?.model ?? "gpt-4o-mini",
      temperature: 0,
      messages:    [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    try {
      const parsed = JSON.parse(raw) as { winner?: string; reasoning?: string };
      const winner = contestants.find((c) => c.fromBranch === parsed.winner)?.fromBranch ?? fallback;
      return { winner, reasoning: parsed.reasoning ?? "no reasoning provided" };
    } catch {
      return { winner: fallback, reasoning: raw };
    }
  }

  private async evaluate(
    state: ProposalWithResolver,
    fromContent: string,
    intoContent: string,
    competingContent?: string,
  ): Promise<{ verdict: "approve" | "reject"; reasoning: string }> {
    if (!this.openai) {
      // No LLM configured — auto-approve (useful for tests).
      return { verdict: "approve", reasoning: "auto-approve (no LLM configured)" };
    }

    const prompt = [
      `You are a neutral judge evaluating a memory merge proposal.`,
      ``,
      `FROM branch "${state.fromBranch}" proposes to merge into "${state.intoBranch}":`,
      fromContent,
      ``,
      `Current "${state.intoBranch}" content:`,
      intoContent,
      competingContent
        ? [``, `COMPETING proposal also targeting "${state.intoBranch}":`, competingContent, ``, `You must approve at most ONE competing proposal. If this branch is weaker, vote reject.`].join("\n")
        : "",
      ``,
      `Should this merge be approved? Reply with a JSON object: {"verdict":"approve"|"reject","reasoning":"..."}`,
    ].filter(Boolean).join("\n");

    const completion = await this.openai.chat.completions.create({
      model:       this.config.llm?.model ?? "gpt-4o-mini",
      temperature: 0,
      messages:    [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    try {
      const parsed = JSON.parse(raw) as { verdict?: string; reasoning?: string };
      const verdict = parsed.verdict === "reject" ? "reject" : "approve";
      const reasoning = parsed.reasoning ?? "no reasoning provided";
      return { verdict, reasoning };
    } catch {
      return { verdict: "approve", reasoning: raw };
    }
  }
}
