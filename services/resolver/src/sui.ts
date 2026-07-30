/**
 * Local Sui gRPC / GraphQL helpers for the resolver runtime.
 * Duplicated from @memfork/core (this package must not depend on it).
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { bcs } from '@mysten/sui/bcs';
import type { SuiClientTypes } from '@mysten/sui/client';

export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

export const GRAPHQL_URLS: Record<string, string> = {
  mainnet: 'https://graphql.mainnet.sui.io/graphql',
  testnet: 'https://graphql.testnet.sui.io/graphql',
  devnet: 'https://graphql.devnet.sui.io/graphql',
};

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

/** Decode a `vector<u8>` dynamic-field value to UTF-8 (empty → ""). */
export function utf8FromVectorU8(valueBcs: Uint8Array): string {
  const bytes = bcs.vector(bcs.u8()).parse(valueBcs);
  return Buffer.from(bytes).toString('utf8');
}

/** Assert a Core API transaction result succeeded; return its digest. */
export function assertTxSuccess(
  result: SuiClientTypes.TransactionResult<{ effects: true }>,
  label: string,
): string {
  if (result.$kind === 'FailedTransaction' || !result.Transaction?.status.success) {
    const failed = result.FailedTransaction ?? result.Transaction;
    const err = failed?.status?.error;
    throw new Error(
      `${label} failed: ${err ? JSON.stringify(err) : 'unknown'}`,
    );
  }
  return result.Transaction.digest;
}

export function inferNetwork(rpcUrl: string, explicit?: string): SuiNetwork {
  if (explicit === 'mainnet' || explicit === 'testnet' || explicit === 'devnet' || explicit === 'localnet') {
    return explicit;
  }
  if (rpcUrl.includes('testnet')) return 'testnet';
  if (rpcUrl.includes('devnet')) return 'devnet';
  if (rpcUrl.includes('127.0.0.1') || rpcUrl.includes('localhost')) return 'localnet';
  return 'mainnet';
}

export { SuiGrpcClient };
export type { SuiClientTypes };
