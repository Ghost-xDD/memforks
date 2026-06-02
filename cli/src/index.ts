/**
 * @memfork/cli — library exports
 *
 * Import the config API from here:
 *   import { resolveConfig, toClientConfig } from "@memfork/cli"
 *
 * The CLI binary entry point is src/cli.ts → dist/cli.js
 */

export {
  resolveConfig,
  toClientConfig,
  readProjectConfig,
  writeProjectConfig,
  readCredentials,
  writeCredentials,
  upsertCredential,
  setDefaultTree,
  projectConfigPath,
  credentialsPath,
  ConfigError,
} from "./config.js";
