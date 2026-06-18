/**
 * Artifact storage for MemForks — direct Walrus blob writes/reads.
 *
 * Design (see docs/architecture/artifacts.md):
 *   - Artifacts are opt-in, disabled by default (requires WAL + SUI funding).
 *   - Writes: @mysten/walrus SDK via SuiGrpcClient.
 *   - Reads:  public Walrus HTTP aggregator (free, no auth).
 *   - Each artifact is a standalone Walrus blob; the commit payload stores only
 *     an ArtifactRef so large files never pollute MemWal / the recall index.
 *
 * Error handling strategy:
 *   - Retryable SDK errors (epoch boundary) are auto-retried up to 3 times.
 *   - All other errors are classified and re-thrown as ArtifactStorageError
 *     with a clear, actionable message instead of a raw SDK stacktrace.
 */

import { createHash } from 'node:crypto';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  walrus,
  RetryableWalrusClientError,
  BehindCurrentEpochError,
  NotEnoughBlobConfirmationsError,
  NotEnoughSliversReceivedError,
  InconsistentBlobError,
  BlobBlockedError,
  ConnectionError,
  ConnectionTimeoutError,
  RateLimitError,
  InternalServerError as WalrusInternalServerError,
} from '@mysten/walrus';
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
  /**
   * Machine-readable reason code so callers can branch on it.
   *   'disabled'       — artifacts.enabled = false
   *   'too_large'      — file exceeds maxBytes
   *   'empty_file'     — zero-byte file
   *   'invalid_path'   — bad path string
   *   'insufficient_wal' — not enough WAL tokens
   *   'insufficient_sui' — not enough SUI for gas
   *   'epoch_change'   — auto-retry exhausted on epoch boundary
   *   'not_enough_confirmations' — Walrus couldn't confirm enough nodes
   *   'network'        — connectivity / timeout
   *   'rate_limit'     — Walrus rate limit
   *   'blob_blocked'   — blob flagged by storage nodes
   *   'corrupted'      — incorrect encoding detected
   *   'not_found'      — blob ID doesn't exist or has expired
   *   'integrity'      — sha256 mismatch on read
   *   'unknown'        — unclassified error
   */
  readonly reason: string;
  constructor(message: string, reason: string = 'unknown') {
    super(message);
    this.name  = 'ArtifactStorageError';
    this.reason = reason;
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

// ─── Walrus client — cached per (network, relayUrl) ──────────────────────────
//
// The Walrus SDK initializes a WASM module on first use; re-creating the
// client for every upload would pay that cost each time. We cache one
// instance per unique (network, uploadRelayUrl) combination.

type WalrusExtended = {
  walrus: {
    writeBlob(opts: {
      blob:      Uint8Array;
      deletable: boolean;
      epochs:    number;
      signer:    Ed25519Keypair;
    }): Promise<{ blobId: string }>;
    /** Reset internal caches after a RetryableWalrusClientError. */
    reset(): void;
  };
};

const walrusClientCache = new Map<string, WalrusExtended>();

function getWalrusClient(
  network: 'mainnet' | 'testnet',
  uploadRelayUrl?: string,
): WalrusExtended {
  const key = `${network}:${uploadRelayUrl ?? ''}`;
  const cached = walrusClientCache.get(key);
  if (cached) return cached;

  const grpc = new SuiGrpcClient({
    network,
    baseUrl: SUI_GRPC_RPC[network] ?? SUI_GRPC_RPC['mainnet']!,
  });

  const walrusOpts: Parameters<typeof walrus>[0] = {};
  if (uploadRelayUrl) {
    walrusOpts.uploadRelay = { host: uploadRelayUrl };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = grpc.$extend(walrus(walrusOpts) as any) as unknown as WalrusExtended;
  walrusClientCache.set(key, client);
  return client;
}

/** Evict a cached client (e.g. after an unrecoverable error). */
function evictWalrusClient(network: 'mainnet' | 'testnet', uploadRelayUrl?: string): void {
  walrusClientCache.delete(`${network}:${uploadRelayUrl ?? ''}`);
}

// ─── SHA-256 helper ───────────────────────────────────────────────────────────

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ─── Error classifier ─────────────────────────────────────────────────────────

/**
 * Map a raw SDK/network error to an ArtifactStorageError with a clear,
 * actionable message. Never surfaces raw Sui/Walrus stacktraces to users.
 */
function classifyWriteError(err: unknown, path: string): ArtifactStorageError {
  // ── Retryable epoch boundary ─────────────────────────────────────────────
  if (err instanceof BehindCurrentEpochError) {
    return new ArtifactStorageError(
      `Artifact upload for "${path}" failed because the Walrus client is behind the current epoch. ` +
      'This is transient — retrying automatically.',
      'epoch_change',
    );
  }
  if (err instanceof RetryableWalrusClientError) {
    return new ArtifactStorageError(
      `Artifact upload for "${path}" hit a transient Walrus error (${err.constructor.name}). ` +
      'Retrying automatically.',
      'epoch_change',
    );
  }

  // ── Quorum failures ───────────────────────────────────────────────────────
  if (err instanceof NotEnoughBlobConfirmationsError || err instanceof NotEnoughSliversReceivedError) {
    return new ArtifactStorageError(
      `Walrus couldn't get confirmations from enough storage nodes for "${path}". ` +
      'The network may be experiencing high load. Try again in a few minutes.',
      'not_enough_confirmations',
    );
  }

  // ── Permanent data errors ──────────────────────────────────────────────────
  if (err instanceof InconsistentBlobError) {
    return new ArtifactStorageError(
      `Walrus detected an encoding inconsistency for "${path}". ` +
      'This is likely a Walrus SDK bug — please report it.',
      'corrupted',
    );
  }

  if (err instanceof BlobBlockedError) {
    return new ArtifactStorageError(
      `Artifact "${path}" was blocked by a quorum of Walrus storage nodes. ` +
      'The content may violate storage policies.',
      'blob_blocked',
    );
  }

  // ── Network/transport ─────────────────────────────────────────────────────
  if (err instanceof ConnectionTimeoutError) {
    return new ArtifactStorageError(
      `Connection to Walrus storage nodes timed out while uploading "${path}". ` +
      'Check your network connection and try again.',
      'network',
    );
  }

  if (err instanceof ConnectionError) {
    return new ArtifactStorageError(
      `Could not connect to Walrus storage nodes while uploading "${path}". ` +
      'Check your network connection and try again.',
      'network',
    );
  }

  if (err instanceof RateLimitError) {
    return new ArtifactStorageError(
      `Walrus rate limit reached while uploading "${path}". ` +
      'Wait a moment and try again.',
      'rate_limit',
    );
  }

  if (err instanceof WalrusInternalServerError) {
    return new ArtifactStorageError(
      `A Walrus storage node returned an internal error for "${path}". ` +
      'This is usually transient — try again.',
      'network',
    );
  }

  // ── Sui transaction failures (insufficient funds) ─────────────────────────
  // These arrive as generic Errors from the Sui transaction execution layer.
  const msg = String(err).toLowerCase();

  const walFundMessages = [
    'insufficient',
    'not enough balance',
    'balance too low',
    'insufficient coin balance',
    'wal',
  ];
  const suiGasMessages = [
    'insufficient gas',
    'gas budget',
    'gas balance',
    'out of gas',
  ];

  if (suiGasMessages.some((s) => msg.includes(s))) {
    return new ArtifactStorageError(
      `Not enough SUI to pay gas for artifact upload of "${path}".\n` +
      '  Run: memfork doctor  to check your SUI balance.\n' +
      '  Gas is sponsored for MemForks operations but NOT for Walrus artifact writes.\n' +
      '  Send some SUI to your signer address to proceed.',
      'insufficient_sui',
    );
  }

  // Check for WAL-related balance errors; ensure they mention balance/funds
  // so we don't mis-classify unrelated "wal" substring matches.
  if (
    walFundMessages.slice(0, 4).some((s) => msg.includes(s)) ||
    (msg.includes('wal') && msg.includes('balance'))
  ) {
    return new ArtifactStorageError(
      `Not enough WAL tokens to pay for Walrus storage of "${path}".\n` +
      '  Each epoch of storage costs WAL. Check your balance with: memfork doctor\n' +
      '  Get WAL on testnet:   walrus get-wal\n' +
      '  Get WAL on mainnet:   buy WAL on a DEX (e.g. Cetus) and send to your signer address.',
      'insufficient_wal',
    );
  }

  // Timeout-like errors from fetch/Node internals
  if (msg.includes('timeout') || msg.includes('etimedout') || msg.includes('econnrefused') || msg.includes('enotfound')) {
    return new ArtifactStorageError(
      `Network error while uploading "${path}": ${String(err)}\n` +
      '  Check your internet connection or set artifacts.uploadRelayUrl to use an upload relay.',
      'network',
    );
  }

  // Fallback: include the raw message but in a structured way.
  return new ArtifactStorageError(
    `Walrus write failed for "${path}".\n` +
    `  Cause: ${String(err)}\n` +
    '  Run: memfork doctor  to verify SUI and WAL balances.',
    'unknown',
  );
}

// ─── Write ────────────────────────────────────────────────────────────────────

const MAX_RETRIES = 3;

/**
 * Upload a single artifact blob to Walrus. Returns an ArtifactRef on success.
 *
 * Throws `ArtifactStorageError` (with a `.reason` code) on any failure.
 * Retryable Walrus SDK errors (epoch boundary, transient node failures) are
 * automatically retried up to MAX_RETRIES times before throwing.
 *
 * Upload-before-commit: call this before `client.commit()` so the DAG
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

  // ── Guard: feature disabled ────────────────────────────────────────────────
  if (!config.enabled) {
    throw new ArtifactStorageError(
      'Artifact storage is disabled.\n' +
      '  Add this to .memfork/config.json to enable:\n' +
      '    "artifacts": { "enabled": true }\n' +
      '  Then fund your signer keypair with WAL tokens (and SUI for gas).\n' +
      '  See docs/architecture/artifacts.md for setup instructions.',
      'disabled',
    );
  }

  // ── Guard: empty file ──────────────────────────────────────────────────────
  if (bytes.length === 0) {
    throw new ArtifactStorageError(
      `Artifact "${path}" is empty (0 bytes). Walrus does not accept empty blobs.`,
      'empty_file',
    );
  }

  // ── Guard: file too large ──────────────────────────────────────────────────
  if (bytes.length > config.maxBytes) {
    const sizeMiB = (bytes.length / (1024 * 1024)).toFixed(1);
    const limitMiB = (config.maxBytes / (1024 * 1024)).toFixed(0);
    throw new ArtifactStorageError(
      `Artifact "${path}" is ${sizeMiB} MiB, exceeding the ${limitMiB} MiB limit.\n` +
      '  Increase artifacts.maxBytes in .memfork/config.json or set\n' +
      '  MEMFORK_ARTIFACTS_MAX_BYTES=<bytes> to raise the limit.',
      'too_large',
    );
  }

  // ── Guard: path sanity ─────────────────────────────────────────────────────
  if (!path || path.includes('\0') || path.length > 255) {
    throw new ArtifactStorageError(
      `Invalid artifact path "${path}". Must be non-empty, ≤255 chars, and contain no null bytes.`,
      'invalid_path',
    );
  }

  const hash   = sha256Hex(bytes);
  const epochs = epochsOverride ?? config.epochs;

  // ── Upload with auto-retry for transient epoch-boundary errors ─────────────
  let lastErr: ArtifactStorageError | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const walrusClient = getWalrusClient(network, config.uploadRelayUrl);
    try {
      const result = await walrusClient.walrus.writeBlob({
        blob:      bytes,
        deletable: false,
        epochs,
        signer:    keypair,
      });

      return {
        path,
        blobId: result.blobId,
        sha256: hash,
        size:   bytes.length,
        ...(mime !== undefined ? { mime } : {}),
        epochs,
      } as ArtifactRef;

    } catch (err) {
      const classified = classifyWriteError(err, path);

      // Retryable (epoch change): reset the cached client and try again.
      if (classified.reason === 'epoch_change' && attempt < MAX_RETRIES) {
        walrusClient.walrus.reset();
        // Evict cache so next attempt builds a fresh client with current epoch data.
        evictWalrusClient(network, config.uploadRelayUrl);
        const backoffMs = 1000 * attempt;
        await new Promise((r) => setTimeout(r, backoffMs));
        lastErr = classified;
        continue;
      }

      // Non-retryable (or retries exhausted): throw immediately.
      if (classified.reason === 'epoch_change') {
        throw new ArtifactStorageError(
          `Artifact upload for "${path}" failed after ${MAX_RETRIES} retries due to an ongoing Walrus epoch change.\n` +
          '  The network is reconfiguring. Wait a minute and try again.',
          'epoch_change',
        );
      }

      throw classified;
    }
  }

  // Should be unreachable, but satisfies the TypeScript exhaustion check.
  throw lastErr ?? new ArtifactStorageError(`Upload failed for "${path}".`, 'unknown');
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * Fetch an artifact by its blob ID from the public Walrus aggregator.
 *
 * When `ref.sha256` is non-empty, bytes are verified and an
 * ArtifactStorageError('integrity') is thrown on mismatch.
 * Pass an empty sha256 to skip verification.
 *
 * Retries up to 2 times on 404 with backoff to handle CDN read-after-write lag.
 * After that, surfaces "expired or not found" rather than a raw HTTP status.
 *
 * Reads are free and require no credentials.
 */
export async function getArtifact(
  ref: Pick<ArtifactRef, 'blobId' | 'sha256'>,
  network: 'mainnet' | 'testnet' = 'mainnet',
): Promise<Uint8Array> {
  const base = WALRUS_AGGREGATOR[network] ?? WALRUS_AGGREGATOR['mainnet']!;
  const url  = `${base}/v1/blobs/${ref.blobId}`;

  const fetchWithRetry = async (attempt: number): Promise<Response> => {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (err) {
      throw new ArtifactStorageError(
        `Could not reach Walrus aggregator at ${base}.\n` +
        `  Cause: ${String(err)}\n` +
        '  Check your network connection.',
        'network',
      );
    }
    if (res.status === 404 && attempt <= 2) {
      // CDN may briefly cache 404 right after an upload — wait and retry.
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return fetchWithRetry(attempt + 1);
    }
    return res;
  };

  const res = await fetchWithRetry(1);

  if (res.status === 404) {
    throw new ArtifactStorageError(
      `Artifact not found: ${ref.blobId}\n` +
      '  Possible causes:\n' +
      '   • The blob ID is incorrect.\n' +
      '   • The artifact storage epochs have expired and the blob was deleted.\n' +
      '     When writing, use a higher --epochs value or a permanent (deletable: false) blob.\n' +
      `   • Try the Walrus aggregator directly: ${url}`,
      'not_found',
    );
  }

  if (res.status === 451) {
    throw new ArtifactStorageError(
      `Artifact ${ref.blobId} is legally unavailable (HTTP 451) in this region.`,
      'blob_blocked',
    );
  }

  if (!res.ok) {
    throw new ArtifactStorageError(
      `Walrus aggregator returned HTTP ${res.status} for blob ${ref.blobId}.`,
      'network',
    );
  }

  const bytes = new Uint8Array(await res.arrayBuffer());

  // Integrity check is opt-in: only enforced when a digest is supplied.
  if (ref.sha256) {
    const got = sha256Hex(bytes);
    if (got !== ref.sha256) {
      throw new ArtifactStorageError(
        `Integrity check failed for blob ${ref.blobId}.\n` +
        `  Expected sha256: ${ref.sha256}\n` +
        `  Got:             ${got}\n` +
        '  The blob may have been tampered with or the wrong blob ID was used.',
        'integrity',
      );
    }
  }

  return bytes;
}
