import type { ProviderReceipt } from '../../contracts/index.ts';
import { DB_NOW, statement as q } from '../db/core.ts';

/** Content-free receipt projection. A late receipt may update an existing row, never recreate it. */
export function providerReceiptStatements(
  db: D1Database,
  dispatchId: string,
  ownerId: string,
  receipt: ProviderReceipt | null,
): D1PreparedStatement[] {
  if (!receipt) return [];
  const { usage } = receipt;
  return [
    q(
      db,
      `UPDATE provider_dispatches SET returned_model=?,input_tokens=?,output_tokens=?,duration_ms=?,cached_input_tokens=?,cache_write_tokens=?,reasoning_tokens=?,service_tier=?,received_at=coalesce(received_at,${DB_NOW}) WHERE id=? AND owner_id=? AND input_tokens IS NULL`,
      receipt.returnedModel,
      usage.inputTokens,
      usage.outputTokens,
      receipt.durationMs,
      usage.cachedInputTokens,
      usage.cacheWriteTokens,
      usage.reasoningTokens,
      receipt.serviceTier,
      dispatchId,
      ownerId,
    ),
    q(db, 'UPDATE accounts SET data_revision=data_revision+1 WHERE id=? AND changes()=1', ownerId),
  ];
}
