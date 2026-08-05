/**
 * Sui gRPC helpers for @memfork/core.
 *
 * Public Foundation fullnodes disabled JSON-RPC the week of 2026-07-27.
 * All chain reads/writes go through SuiGrpcClient.
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';
import type { SuiClientTypes } from '@mysten/sui/client';

export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

const GRPC_URLS: Record<SuiNetwork, string> = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
  devnet: 'https://fullnode.devnet.sui.io:443',
  localnet: 'http://127.0.0.1:9000',
};

export function grpcUrlForNetwork(network: string | undefined): string {
  const n = (network ?? 'mainnet') as SuiNetwork;
  return GRPC_URLS[n] ?? GRPC_URLS.mainnet;
}

export function createSuiClient(opts: {
  network: string;
  rpcUrl?: string;
}): SuiGrpcClient {
  const network = opts.network as SuiClientTypes.Network;
  return new SuiGrpcClient({
    network,
    baseUrl: opts.rpcUrl ?? grpcUrlForNetwork(opts.network),
  });
}

/** Compatible shape for code that previously scanned JSON-RPC objectChanges. */
export interface CreatedObjectChange {
  type: 'created';
  objectId: string;
  objectType: string;
}

export interface ExecutedTx {
  digest: string;
  objectChanges: CreatedObjectChange[];
}

/**
 * Unwrap a Core API TransactionResult into digest + created objects.
 * Throws if the transaction failed.
 */
export function unwrapExecutedTx(
  result: SuiClientTypes.TransactionResult<{
    effects: true;
    objectTypes: true;
  }>,
): ExecutedTx {
  if (result.$kind === 'FailedTransaction') {
    const err = result.FailedTransaction.status.error;
    throw new Error(
      `Transaction failed: ${err ? JSON.stringify(err) : 'unknown'}`,
    );
  }
  const tx = result.Transaction;
  if (!tx.status.success) {
    throw new Error(
      `Transaction failed: ${tx.status.error ? JSON.stringify(tx.status.error) : 'unknown'}`,
    );
  }
  const types = tx.objectTypes ?? {};
  const objectChanges: CreatedObjectChange[] = (tx.effects?.changedObjects ?? [])
    .filter((c) => c.idOperation === 'Created')
    .map((c) => ({
      type: 'created' as const,
      objectId: c.objectId,
      objectType: types[c.objectId] ?? '',
    }));
  return { digest: tx.digest, objectChanges };
}

/**
 * Extract a Table / UID object id from Move JSON.
 * gRPC flattens UIDs to `{ id: "0x…" }`; JSON-RPC nested them as
 * `{ fields: { id: { id: "0x…" } } }`. Accept both.
 */
export function tableIdFromField(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.id === 'string') return o.id;
  const fields = o.fields as Record<string, unknown> | undefined;
  if (!fields) return undefined;
  const idWrap = fields.id;
  if (typeof idWrap === 'string') return idWrap;
  if (idWrap && typeof idWrap === 'object') {
    const nested = (idWrap as { id?: string }).id;
    if (typeof nested === 'string') return nested;
  }
  return undefined;
}

/** BCS name for a `0x1::string::String` dynamic field key. */
export function stringFieldName(value: string): SuiClientTypes.DynamicFieldName {
  return {
    type: '0x1::string::String',
    bcs: bcs.string().serialize(value).toBytes(),
  };
}

/** BCS name for an `address` dynamic field key (e.g. MemWal AccountRegistry.accounts). */
export function addressFieldName(
  address: string,
): SuiClientTypes.DynamicFieldName {
  return {
    type: 'address',
    bcs: bcs.Address.serialize(address).toBytes(),
  };
}

/** Decode a fixed 32-byte Address / ObjectID dynamic-field value to `0x…`. */
export function addressFromBcs(valueBcs: Uint8Array): string {
  const bytes =
    valueBcs.length === 32 ? valueBcs : bcs.Address.parse(valueBcs);
  return `0x${Buffer.from(bytes).toString('hex')}`;
}

/** Decode a `vector<u8>` dynamic-field value to UTF-8 (empty → ""). */
export function utf8FromVectorU8(valueBcs: Uint8Array): string {
  const bytes = bcs.vector(bcs.u8()).parse(valueBcs);
  return Buffer.from(bytes).toString('utf8');
}

export { SuiGrpcClient };
export type { SuiClientTypes };
