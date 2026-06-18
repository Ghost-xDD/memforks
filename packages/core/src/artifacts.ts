/**
 * Artifact storage for MemForks — direct Walrus blob writes/reads.
 *
 * Design (see docs/architecture/artifacts.md):
 *   - Artifacts are opt-in, disabled by default (requires WAL + SUI funding).
 *   - Writes: @mysten/walrus SDK via SuiGrpcClient (only supported mainnet path).
 *   - Reads: public Walrus HTTP aggregator (free, no auth).
 *   - Each artifact is a standalone Walrus blob; the commit payload stores only
 *     an ArtifactRef so large files never pollute MemWal / the recall index.
 */

import { createHash } from 'node:crypto';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { walrus } from '@mysten/walrus';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { ArtifactRef } from './types.js';

// ─── Config ───────────────────────────────────────────────────────────────────

export interface ArtifactConfig {
  enabled: boolean;
  /** Walrus storage epochs. Default: 12 (~one quarter at ~1 epoch/week). */
  epochs: number;
  /** Max artifact size in bytes. Default: 10 MiB. */
  maxBytes: number;
  /** Optional Walrus upload relay URL (reduces write requests from ~2200 to ~1). */
  uploadRelayUrl?: string;
}

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
  enabled:  false,
  epochs:   12,
  maxBytes: 10 * 1024 * 1024,
};

// ─── Error ────────────────────────────────────────────────────────────────────

export class ArtifactStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactStorageError';
  }
}

// ─── Network constants ────────────────────────────────────────────────────────

const WALRUS_AGGREGATOR: Record<string, string> = {
  mainnet: 'https://aggregator.walrus-mainnet.walrus.space',
  testnet: 'https://aggregator.walrus-testnet.walrus.space',
};

const SUI_GRPC_RPC: Record<string, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
};

// ─── Walrus client factory ────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WalrusExtended = { walrus: { writeBlob(opts: { blob: Uint8Array; deletable: boolean; epochs: number; signer: Ed25519Keypair }): Promise<{ blobId: string }> } };

function makeWalrusClient(
  network: 'mainnet' | 'testnet',
  uploadRelayUrl?: string,
): WalrusExtended {
  const grpc = new SuiGrpcClient({
    network,
    baseUrl: SUI_GRPC_RPC[network] ?? SUI_GRPC_RPC['mainnet']!,
  });

  const walrusOpts: Parameters<typeof walrus>[0] = {};
  if (uploadRelayUrl) {
    walrusOpts.uploadRelay = { host: uploadRelayUrl };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return grpc.$extend(walrus(walrusOpts) as any) as unknown as WalrusExtended;
}

// ─── SHA-256 helper ───────────────────────────────────────────────────────────

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Upload a single artifact blob to Walrus.
 *
 * Throws `ArtifactStorageError` if artifacts are disabled, bytes exceed
 * `maxBytes`, or the Walrus write fails.
 *
 * Upload-before-commit: always call this before `client.commit()` so the DAG
 * never references a blob that wasn't successfully written.
 */
export async function putArtifact(
  bytes: Uint8Array,
  opts: {
    path: string;
    mime?: string;
    config: ArtifactConfig;
    network: 'mainnet' | 'testnet';
    keypair: Ed25519Keypair;
    epochsOverride?: number;
  },
): Promise<ArtifactRef> {
  const { path, mime, config, network, keypair, epochsOverride } = opts;

  if (!config.enabled) {
    throw new ArtifactStorageError(
      'Artifact storage is disabled. ' +
      'Set artifacts.enabled = true in .memfork/config.json and fund your signer keypair with WAL on mainnet. ' +
      'See docs/architecture/artifacts.md.',
    );
  }

  if (bytes.length > config.maxBytes) {
    throw new ArtifactStorageError(
      `Artifact "${path}" is ${bytes.length} bytes, exceeding the limit of ${config.maxBytes} bytes. ` +
      'Increase artifacts.maxBytes in .memfork/config.json or MEMFORK_ARTIFACTS_MAX_BYTES.',
    );
  }

  const hash   = sha256Hex(bytes);
  const epochs = epochsOverride ?? config.epochs;

  const walrusClient = makeWalrusClient(network, config.uploadRelayUrl);

  let blobId: string;
  try {
    const result = await walrusClient.walrus.writeBlob({
      blob:      bytes,
      deletable: false,
      epochs,
      signer:    keypair,
    });
    blobId = result.blobId;
  } catch (err) {
    throw new ArtifactStorageError(
      `Walrus write failed for "${path}": ${String(err)}\n` +
      'Ensure your keypair holds SUI (gas) and WAL (storage) on mainnet.',
    );
  }

  return {
    path,
    blobId,
    sha256: hash,
    size:   bytes.length,
    ...(mime !== undefined ? { mime } : {}),
    epochs,
  } as ArtifactRef;
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Fetch an artifact by its ArtifactRef from the public Walrus aggregator.
 * Verifies SHA-256 integrity on every read.
 *
 * Reads are free and require no credentials.
 * Retries once with backoff to handle CDN read-after-write 404s.
 */
export async function getArtifact(
  ref: Pick<ArtifactRef, 'blobId' | 'sha256'>,
  network: 'mainnet' | 'testnet' = 'mainnet',
): Promise<Uint8Array> {
  const base = WALRUS_AGGREGATOR[network] ?? WALRUS_AGGREGATOR['mainnet']!;
  const url  = `${base}/v1/blobs/${ref.blobId}`;

  const fetchWithRetry = async (attempt: number): Promise<Response> => {
    const res = await fetch(url);
    if (res.status === 404 && attempt < 2) {
      // CDN may briefly cache 404 right after upload — retry after backoff.
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return fetchWithRetry(attempt + 1);
    }
    return res;
  };

  const res = await fetchWithRetry(1);

  if (!res.ok) {
    throw new ArtifactStorageError(
      `Could not fetch artifact ${ref.blobId}: HTTP ${res.status}`,
    );
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  const got   = sha256Hex(bytes);

  if (got !== ref.sha256) {
    throw new ArtifactStorageError(
      `Artifact integrity check failed for blob ${ref.blobId}. ` +
      `Expected sha256 ${ref.sha256}, got ${got}.`,
    );
  }

  return bytes;
}
