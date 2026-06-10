/**
 * createMemForksModel — convenience factory that combines withMemForks with
 * automatic config resolution from ~/.memfork/credentials.json.
 *
 * Usage (when @memfork/cli is available):
 *
 *   import { createMemForksModel } from "@memfork/vercel-ai";
 *   import { openai } from "@ai-sdk/openai";
 *
 *   const model = await createMemForksModel(openai("gpt-4o"), {
 *     branch: "feature/my-feature",
 *   });
 */

import type { LanguageModelV1 } from "ai";
import { withMemForks, type MemForksMiddlewareOptions } from "./middleware.js";

type ModelOnlyOptions = Omit<
  MemForksMiddlewareOptions,
  "treeId" | "signer" | "network" | "rpcUrl" | "packageId" | "memwal"
>;

/**
 * Creates a MemForks-wrapped model using config auto-resolved from
 * ~/.memfork/credentials.json and .memfork/config.json.
 *
 * Requires @memfork/cli to be installed in the same project.
 */
export async function createMemForksModel(
  model:   LanguageModelV1,
  options: ModelOnlyOptions = {},
): Promise<LanguageModelV1> {
  // Dynamically import @memfork/cli — avoids a hard dependency.
  let clientConfig: MemForksMiddlewareOptions;
  try {
    const { resolveConfig, toClientConfig } = await import("@memfork/cli");
    clientConfig = {
      ...toClientConfig(resolveConfig()),
      ...options,
    } as MemForksMiddlewareOptions;
  } catch {
    throw new Error(
      "createMemForksModel requires @memfork/cli to be installed and configured.\n" +
      "Run: npm install @memfork/cli && memfork init",
    );
  }

  return withMemForks(model, clientConfig);
}
