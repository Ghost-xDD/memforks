/**
 * LLM reconcile worker.
 *
 * Runs after the jury phase (if any) is complete.  Steps:
 *   1. Fetches both branch head payloads from MemWal.
 *   2. Calls the LLM with a reconciliation prompt.
 *   3. Stores the resolved content in MemWal → gets a blob_id.
 *   4. Signs + submits an LLM_RESOLVE attestation.
 *   5. Returns { resolvedNamespace, resolvedBlobId } for the finalizer.
 */

import { SuiClient } from "@mysten/sui/client";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Transaction } from "@mysten/sui/transactions";
import { MemWal } from "@mysten-incubation/memwal";
import OpenAI from "openai";
import type { ProposalState, RuntimeConfig } from "../types.js";

const ATTEST_LLM_RESOLVE = 0x04;

export class LlmWorker {
  private readonly keypair: Ed25519Keypair;
  private readonly address: string;
  private readonly openai: OpenAI;

  constructor(
    private readonly runnerCfg: NonNullable<RuntimeConfig["llmRunner"]>,
    private readonly memwalCfg: NonNullable<RuntimeConfig["memwal"]>,
    private readonly suiClient: SuiClient,
    private readonly packageId: string,
  ) {
    const { secretKey } = decodeSuiPrivateKey(runnerCfg.privateKey);
    this.keypair = Ed25519Keypair.fromSecretKey(secretKey);
    this.address = this.keypair.toSuiAddress();
    this.openai  = new OpenAI({ apiKey: runnerCfg.llm.apiKey });
  }

  get suiAddress(): string { return this.address; }

  /**
   * Reconcile the two branches and submit an LLM_RESOLVE attestation.
   * Returns the MemWal namespace + blob_id of the reconciled content.
   */
  async reconcile(
    state: ProposalState & { resolverId: string },
    fromContent: string,
    intoContent: string,
    resolvedNamespace: string,
  ): Promise<{ resolvedNamespace: string; resolvedBlobId: string }> {
    // 1. Prompt the LLM to merge both sets of facts.
    const prompt = [
      `You are reconciling two AI agent memory branches into a single coherent memory.`,
      ``,
      `Branch "${state.fromBranch}" (incoming):`,
      fromContent,
      ``,
      `Branch "${state.intoBranch}" (current):`,
      intoContent,
      ``,
      `Produce a merged memory that preserves all unique, accurate facts from both branches.`,
      `Where facts conflict, prefer the more specific or recent value and note the discrepancy.`,
      `Output only the merged memory as plain text.`,
    ].join("\n");

    const completion = await this.openai.chat.completions.create({
      model:       this.runnerCfg.llm.model,
      temperature: 0,
      messages:    [{ role: "user", content: prompt }],
    });
    const resolvedText = completion.choices[0]?.message?.content ?? intoContent;

    // 2. Store the resolved content in MemWal.
    const memwal = MemWal.create({
      key:       this.memwalCfg.delegateKey,
      accountId: this.memwalCfg.accountId,
      serverUrl: this.memwalCfg.serverUrl ?? "https://relayer.staging.memwal.ai",
      namespace: resolvedNamespace,
    });
    const memResult = await memwal.rememberAndWait(resolvedText);
    const resolvedBlobId = memResult.blob_id;

    // 3. Build LLM_RESOLVE attestation payload.
    const payload = Buffer.from(JSON.stringify({
      proposal_id:         state.proposalId,
      model:               this.runnerCfg.llm.model,
      resolved_namespace:  resolvedNamespace,
      resolved_blob_id:    resolvedBlobId,
      runner:              this.address,
      ts_ms:               Date.now(),
    }));

    // 4. Sign + submit.
    const pubkeyBytes = Array.from(this.keypair.getPublicKey().toRawBytes());
    const sigBytes    = Array.from(await this.keypair.sign(payload));

    const tx = new Transaction();
    tx.moveCall({
      target: `${this.packageId}::resolver::submit_attestation`,
      arguments: [
        tx.object(state.proposalId),
        tx.object(state.resolverId),
        tx.pure.u8(ATTEST_LLM_RESOLVE),
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
      throw new Error(`LLM_RESOLVE failed: ${result.effects?.status.error}`);
    }
    console.log(`  [llm-runner] submitted LLM_RESOLVE — tx ${result.digest}`);

    return { resolvedNamespace, resolvedBlobId };
  }
}
