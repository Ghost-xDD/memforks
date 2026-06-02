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

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import OpenAI from "openai";
import type { JudgeConfig, ProposalState } from "../types.js";

const ATTEST_JURY_VOTE = 0x01;

export class JuryWorker {
  private readonly keypair: Ed25519Keypair;
  private readonly address: string;
  private readonly openai: OpenAI | undefined;

  constructor(
    private readonly config: JudgeConfig,
    private readonly suiClient: SuiClient,
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

  /** Submit a JURY_VOTE attestation for the given proposal. */
  async vote(
    state: ProposalState,
    fromContent: string,
    intoContent: string,
  ): Promise<string> {
    // 1. Evaluate (with LLM if configured, otherwise auto-approve).
    const { verdict, reasoning } = await this.evaluate(
      state,
      fromContent,
      intoContent,
    );

    // 2. Build CBOR-compatible JSON payload (deterministic key order).
    const payload = Buffer.from(JSON.stringify({
      proposal_id:        state.proposalId,
      from_branch:        state.fromBranch,
      into_branch:        state.intoBranch,
      vote:               verdict,
      reasoning,
      judge:              this.address,
      ts_ms:              Date.now(),
    }));

    // 3. Sign the payload bytes (content binding — SPEC §5).
    const pubkeyBytes = Array.from(this.keypair.getPublicKey().toRawBytes());
    const sigBytes    = Array.from(await this.keypair.sign(payload));

    // 4. Submit on-chain.
    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::resolver::submit_attestation`,
      arguments: [
        tx.object(state.proposalId),
        // ResolverRef is looked up by the caller via state.resolverConfig;
        // the object ID must be passed — we get it from ProposalState.resolverId.
        tx.object((state as ProposalState & { resolverId: string }).resolverId),
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
      options: { showEffects: true },
    });
    if (result.effects?.status.status !== "success") {
      throw new Error(`JURY_VOTE failed: ${result.effects?.status.error}`);
    }
    console.log(`  [judge ${this.address.slice(0, 10)}…] voted "${verdict}" — tx ${result.digest}`);
    return result.digest;
  }

  private async evaluate(
    state: ProposalState,
    fromContent: string,
    intoContent: string,
  ): Promise<{ verdict: "approve" | "reject"; reasoning: string }> {
    if (!this.openai) {
      // No LLM configured — auto-approve (useful for tests).
      return { verdict: "approve", reasoning: "auto-approve (no LLM configured)" };
    }

    const prompt = [
      `You are a neutral judge evaluating a memory merge proposal.`,
      ``,
      `FROM branch "${state.fromBranch}" content:`,
      fromContent,
      ``,
      `INTO branch "${state.intoBranch}" current content:`,
      intoContent,
      ``,
      `Should this merge be approved? Reply with a JSON object: {"verdict":"approve"|"reject","reasoning":"..."}`,
    ].join("\n");

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
