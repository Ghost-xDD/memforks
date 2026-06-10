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

import { wrapLanguageModel, type LanguageModelV1Middleware } from "ai";
import type { LanguageModelV1 } from "ai";
import { MemForksClient, type MemForksClientConfig } from "@memfork/core";

export interface MemForksMiddlewareOptions extends Partial<MemForksClientConfig> {
  /**
   * Git branch name to scope memory to. Default: "main".
   * Overridden by `branchFromContext` when provided.
   */
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
   * Derive the branch name dynamically from the request context.
   * Supports async — useful for per-user branches resolved from a database.
   * Overrides the static `branch` option when provided.
   *
   * @example Per-user branches
   * branchFromContext: async ({ messages }) => {
   *   const userId = await getUserIdFromSession();
   *   return `user/${userId}`;
   * }
   */
  branchFromContext?: (params: { messages: unknown[] }) => string | Promise<string>;
}

/**
 * Wraps a Vercel AI SDK language model with MemForks memory middleware.
 * Returns a LanguageModelV1 that can be passed directly to generateText,
 * streamText, generateObject, etc.
 *
 * All config fields are optional. When omitted the client auto-resolves from:
 *   1. `.memfork/config.json`  (project-local, safe to commit)
 *   2. `~/.memfork/credentials.json`  (user-local secrets — local dev only)
 *   3. `MEMFORK_*` environment variables  (recommended for production)
 *
 * @example Zero-config
 * const model = withMemForks(openai("gpt-4o"));
 *
 * @example Per-user branches (async resolver)
 * const model = withMemForks(openai("gpt-4o"), {
 *   branchFromContext: async ({ messages }) => `user/${await resolveUserId()}`,
 * });
 */
export function withMemForks(
  model:   LanguageModelV1,
  options: MemForksMiddlewareOptions = {},
): LanguageModelV1 {
  return wrapLanguageModel({
    model,
    middleware: createMemForksMiddleware(options),
  });
}

// ─── Middleware implementation ────────────────────────────────────────────────

function createMemForksMiddleware(
  options: MemForksMiddlewareOptions,
): LanguageModelV1Middleware {
  const {
    branch: staticBranch = "main",
    recallLimit     = 5,
    autoCommit      = true,
    recallThreshold = 0.4,
    branchFromContext,
    // Strip MemForksMiddlewareOptions-only keys before passing to connect().
    // Only forward fields that are explicitly set to avoid suppressing auto-resolve.
    treeId, signer, memwal, network, rpcUrl, packageId, sponsorUrl,
  } = options;

  // Lazily initialise the client — avoid async work at middleware creation time.
  let clientPromise: Promise<MemForksClient> | null = null;
  function getClient(): Promise<MemForksClient> {
    if (!clientPromise) {
      // Build a partial config with only the fields that were explicitly provided.
      // MemForksClient.connect() auto-resolves any missing fields from
      // config files and MEMFORK_* env vars. Passing undefined would suppress that.
      const partial: Partial<MemForksClientConfig> = {};
      if (treeId)     partial.treeId     = treeId;
      if (signer)     partial.signer     = signer;
      if (memwal)     partial.memwal     = memwal;
      if (network)    partial.network    = network;
      if (rpcUrl)     partial.rpcUrl     = rpcUrl;
      if (packageId)  partial.packageId  = packageId;
      if (sponsorUrl) partial.sponsorUrl = sponsorUrl;

      const connectPromise = Object.keys(partial).length > 0
        ? MemForksClient.connect(partial as MemForksClientConfig)
        : MemForksClient.connect();

      clientPromise = connectPromise.catch((err) => {
        throw new Error(
          "MemForks: could not resolve config. " +
          "Run `memfork init` locally, or set MEMFORK_TREE_ID, " +
          "MEMFORK_PRIVATE_KEY, MEMFORK_MEMWAL_ACCOUNT, and MEMFORK_MEMWAL_KEY " +
          "environment variables in production.\n" +
          `Cause: ${String(err)}`,
        );
      });
    }
    return clientPromise;
  }

  // Cache resolved branch per-request. The prompt array is a unique object
  // per AI SDK invocation, so it works as a WeakMap key. This ensures
  // branchFromContext (which may be async / DB-backed) is called only once
  // per generateText / streamText call even though transformParams,
  // wrapGenerate, and wrapStream all need the same branch.
  const branchCache = new WeakMap<object, Promise<string>>();

  function resolveBranch(messages: unknown[]): Promise<string> {
    const key = messages as object;
    if (!branchCache.has(key)) {
      const p = branchFromContext
        ? Promise.resolve(branchFromContext({ messages }))
        : Promise.resolve(staticBranch);
      branchCache.set(key, p);
    }
    return branchCache.get(key)!;
  }

  return {
    // ── Before generate: inject recalled facts into the prompt ──────────────
    async transformParams({ params }) {
      if (recallLimit === 0) return params;

      const branch = await resolveBranch(params.prompt);

      let recalledContext = "";
      try {
        const client = await getClient();
        const query  = extractLastUserMessage(params.prompt) ?? branch;
        const facts  = await client.recall(query, { branch, limit: recallLimit });

        const relevant = facts.filter(
          (f) => typeof f.distance !== "number" || f.distance < recallThreshold,
        );

        if (relevant.length > 0) {
          recalledContext = [
            "--- MemForks memory (branch: " + branch + ") ---",
            ...relevant.map((f, i) => `[${i + 1}] ${String(f.text ?? "")}`),
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
        const branch = await resolveBranch(params.prompt);

        setImmediate(async () => {
          try {
            const client = await getClient();
            const query  = extractLastUserMessage(params.prompt) ?? "agent turn";
            await client.commit(branch, {
              message: `auto: ${query.slice(0, 80)}`,
              facts:   [result.text!.slice(0, 1000)],
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

      const branch = await resolveBranch(params.prompt);

      // Buffer the streamed text, commit once the stream closes.
      let accumulated = "";
      const wrappedStream = new ReadableStream({
        async start(controller) {
          const reader = stream.getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value.type === "text-delta") accumulated += value.textDelta;
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
                  message: `auto: ${query.slice(0, 80)}`,
                  facts:   [accumulated.slice(0, 1000)],
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
