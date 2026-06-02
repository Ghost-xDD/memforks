/**
 * withMemForks — Vercel AI SDK LanguageModelMiddleware
 *
 * Wraps any Vercel AI SDK language model with branch-aware, on-chain memory:
 *
 *   BEFORE generating:
 *     1. Calls memfork recall to fetch semantically relevant facts for the
 *        current branch and injects them as a system-level context block.
 *
 *   AFTER generating:
 *     2. Calls memfork commit to anchor the key decisions from the response
 *        on-chain with full provenance.
 *
 * Usage:
 *
 *   import { withMemForks } from "@memfork/vercel-ai";
 *   import { generateText } from "ai";
 *   import { openai } from "@ai-sdk/openai";
 *
 *   const model = withMemForks(openai("gpt-4o"), {
 *     treeId:  process.env.MEMFORK_TREE_ID!,
 *     signer:  process.env.MEMFORK_PRIVATE_KEY!,
 *     memwal:  { accountId: process.env.MEMFORK_MEMWAL_ACCOUNT!, delegateKey: process.env.MEMFORK_MEMWAL_KEY! },
 *     branch:  "feature/my-feature",  // default: "main"
 *   });
 *
 *   const { text } = await generateText({ model, messages });
 *
 * Or use the config layer (reads ~/.memfork/credentials.json automatically):
 *
 *   import { withMemForks } from "@memfork/vercel-ai";
 *   import { resolveConfig, toClientConfig } from "@memfork/cli";
 *
 *   const model = withMemForks(openai("gpt-4o"), {
 *     ...toClientConfig(resolveConfig()),
 *     branch: "feature/my-feature",
 *   });
 */

import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import type { LanguageModelV1 } from "ai";
import { MemForksClient, type MemForksClientConfig } from "@memfork/core";

export interface MemForksMiddlewareOptions extends MemForksClientConfig {
  /** Git branch name to scope memory to. Default: "main". */
  branch?: string;

  /**
   * Maximum number of recalled facts to inject as context.
   * Default: 5. Set to 0 to disable recall injection.
   */
  recallLimit?: number;

  /**
   * Whether to commit facts after generating.
   * Default: true. Set to false for read-only / recall-only mode.
   */
  autoCommit?: boolean;

  /**
   * Semantic distance threshold below which recalled facts are included.
   * Default: 0.4. Lower = stricter relevance.
   */
  recallThreshold?: number;

  /**
   * Custom function to extract a branch name from the request context.
   * Useful when the branch varies per request (e.g. per-user or per-thread).
   * If provided, overrides the static `branch` option.
   */
  branchFromContext?: (params: { messages: unknown[] }) => string;
}

/**
 * Wraps a Vercel AI SDK language model with MemForks memory middleware.
 * Returns a LanguageModelV1 that can be passed directly to generateText,
 * streamText, generateObject, etc.
 */
export function withMemForks(
  model:   LanguageModelV1,
  options: MemForksMiddlewareOptions,
): LanguageModelV1 {
  return wrapLanguageModel({
    model,
    middleware: createMemForksMiddleware(options),
  });
}

// ─── Middleware implementation ────────────────────────────────────────────────

function createMemForksMiddleware(
  options: MemForksMiddlewareOptions,
): LanguageModelMiddleware {
  const {
    branch: staticBranch = "main",
    recallLimit     = 5,
    autoCommit      = true,
    recallThreshold = 0.4,
    branchFromContext,
    ...clientConfig
  } = options;

  // Lazily initialise the client — avoid async work at middleware creation time.
  let clientPromise: Promise<MemForksClient> | null = null;
  function getClient(): Promise<MemForksClient> {
    if (!clientPromise) {
      clientPromise = MemForksClient.connect(clientConfig);
    }
    return clientPromise;
  }

  return {
    // ── Before generate: inject recalled facts into the prompt ──────────────
    async transformParams({ params }) {
      if (recallLimit === 0) return params;

      const branch = branchFromContext
        ? branchFromContext({ messages: params.prompt })
        : staticBranch;

      let recalledContext = "";
      try {
        const client  = await getClient();
        // Build a query from the last user message, if available.
        const query = extractLastUserMessage(params.prompt) ?? branch;
        const facts  = await client.recall(branch, query, recallLimit);

        const relevant = facts.filter(
          (f) => typeof f.distance !== "number" || f.distance < recallThreshold,
        );

        if (relevant.length > 0) {
          recalledContext = [
            "--- MemForks memory (branch: " + branch + ") ---",
            ...relevant.map((f, i) => `[${i + 1}] ${String(f.text ?? f.content ?? "")}`),
            "--- end of recalled context ---",
          ].join("\n");
        }
      } catch {
        // Recall failures are non-fatal — continue without context.
      }

      if (!recalledContext) return params;

      // Prepend to the system prompt (or create one).
      const existingSystem = params.prompt.find((m) => m.role === "system");
      const newPrompt = params.prompt.filter((m) => m.role !== "system");

      const systemContent = existingSystem
        ? existingSystem.content + "\n\n" + recalledContext
        : recalledContext;

      return {
        ...params,
        prompt: [
          { role: "system" as const, content: systemContent },
          ...newPrompt,
        ],
      };
    },

    // ── After generate: commit key decisions on-chain ────────────────────────
    async wrapGenerate({ doGenerate, params }) {
      const result = await doGenerate();

      if (autoCommit && result.text) {
        const branch = branchFromContext
          ? branchFromContext({ messages: params.prompt })
          : staticBranch;

        setImmediate(async () => {
          try {
            const client = await getClient();
            const query  = extractLastUserMessage(params.prompt) ?? "agent turn";
            await client.commit(branch, {
              message:  `auto: ${query.slice(0, 80)}`,
              facts:    [result.text!.slice(0, 1000)],
              autoExtract: true,
            });
          } catch {
            // Commit failures are fire-and-forget — never break the response.
          }
        });
      }

      return result;
    },

    // ── Stream variant: commit after stream completes ─────────────────────────
    async wrapStream({ doStream, params }) {
      const { stream, ...rest } = await doStream();

      if (!autoCommit) return { stream, ...rest };

      const branch = branchFromContext
        ? branchFromContext({ messages: params.prompt })
        : staticBranch;

      // Buffer the streamed text, commit once the stream closes.
      let accumulated = "";
      const wrappedStream = new ReadableStream({
        async start(controller) {
          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              // Accumulate text delta parts.
              if (value.type === "text-delta") {
                accumulated += value.textDelta;
              }
              controller.enqueue(value);
            }
            controller.close();
          } catch (e) {
            controller.error(e);
          }

          // Fire-and-forget commit after stream completes.
          if (accumulated) {
            setImmediate(async () => {
              try {
                const client = await getClient();
                const query  = extractLastUserMessage(params.prompt) ?? "agent turn";
                await client.commit(branch, {
                  message:  `auto: ${query.slice(0, 80)}`,
                  facts:    [accumulated.slice(0, 1000)],
                  autoExtract: true,
                });
              } catch { /* non-fatal */ }
            });
          }
        },
      });

      return { stream: wrappedStream as typeof stream, ...rest };
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractLastUserMessage(
  prompt: Array<{ role: string; content: unknown }>,
): string | null {
  const userMessages = prompt.filter((m) => m.role === "user");
  const last = userMessages.at(-1);
  if (!last) return null;

  // Handle both string content and array-of-parts content.
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) {
    const textParts = (last.content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join(" ");
    return textParts || null;
  }
  return null;
}
