import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import { canonicalJson, sha256Json } from '../../src/domain/json.ts';
import { IdentityCrypto, randomToken } from '../../src/worker/identity/crypto.ts';
import { ErasureLedger, objects, DAY } from '../../src/worker/recovery/ledger.ts';
import { readingAccount, readingBindings } from './reading-client.ts';
import { IDENTITY_SECRETS } from './identity.ts';
import { snapshot } from './snapshot.ts';

export const cleanupBindings = () => ({ ...readingBindings, RESTORE_MODE: 'offline' as const });
export const cleanupLedger = () =>
  new ErasureLedger(env.RECOVERY, new IdentityCrypto(IDENTITY_SECRETS));
/** Actual local D1 row snapshots in a separate test-owned store; no journal bodies enter R2. */
export function localBackup() {
  const snapshots = new Map<string, Awaited<ReturnType<typeof snapshot>>>();
  return {
    snapshots,
    async capture(db: D1Database, epoch: number) {
      const saved = await snapshot(db),
        digest = await sha256Json(saved);
      const state = saved.find((t) => t.name === 'system_state')!.rows[0]!;
      expect(state.recovery_epoch).toBe(epoch);
      snapshots.set(digest, saved);
      return digest;
    },
    async verify(digest: string, epoch: number) {
      const saved = snapshots.get(digest);
      return (
        !!saved &&
        saved.find((t) => t.name === 'system_state')?.rows[0]?.recovery_epoch === epoch &&
        (await sha256Json(saved)) === digest
      );
    },
  };
}
/** Reconstruct a historical synthetic proof with the same real erased target and receipt. */
export async function historicalDeletion(scope: 'session' | 'account' = 'session', days = 50) {
  const account = await readingAccount(),
    reading = await account.client.create();
  const before = await snapshot(env.DB);
  const proof = { receiptId: crypto.randomUUID(), receiptToken: randomToken() };
  const response = await account.client.request(
    scope === 'account' ? '/account' : `/sessions/${reading.started.sessionId}`,
    proof,
    { method: 'DELETE', revision: 1 },
  );
  expect(response.status).toBe(202);
  const ledger = cleanupLedger(),
    original = await ledger.load(proof.receiptId);
  for (const o of await objects(env.RECOVERY, `erasures/v1/${proof.receiptId}/`))
    await env.RECOVERY.delete(o.key);
  const at = Date.now() - days * DAY;
  await ledger.putIntent(
    await ledger.create(
      original.target,
      proof.receiptId,
      await ledger.token(proof.receiptId, proof.receiptToken),
      at,
    ),
  );
  const chain = await ledger.load(proof.receiptId),
    pass = await ledger.begin(chain, at);
  const complete = await ledger.finish(chain, pass, at);
  await env.DB.prepare(
    'UPDATE deletion_jobs SET created_at=?,completed_at=?,backup_expires_by=? WHERE id=?',
  )
    .bind(at, at, Date.parse(complete.backupExpiresBy), proof.receiptId)
    .run();
  return { ...account, ...reading, proof, before };
}
export async function historicalCheckpoints(owner: string, days = 50) {
  const crypt = new IdentityCrypto(IDENTITY_SECRETS);
  const operations = (
    await env.DB.prepare('SELECT * FROM security_operations WHERE owner_id=? ORDER BY epoch')
      .bind(owner)
      .all<{ id: string; epoch: number; snapshot_enc: string; ledger_key: string }>()
  ).results;
  for (const op of operations) {
    const value = await crypt.openCheckpoint(owner, op.epoch, op.id, op.snapshot_enc);
    value.createdAt = new Date(
      Date.now() - (days + operations.length - op.epoch) * DAY,
    ).toISOString();
    const raw = await crypt.sealCheckpoint(value);
    await env.RECOVERY.put(op.ledger_key, raw);
    await env.DB.prepare('UPDATE security_operations SET snapshot_enc=?,applied_at=? WHERE id=?')
      .bind(raw, Date.parse(value.createdAt), op.id)
      .run();
  }
  return operations;
}

/** Build many historical signed passes in linear time; production ledger.load verifies them. */
export async function historicalPasses(id: string, count: number) {
  const ledger = cleanupLedger(),
    chain = await ledger.load(id),
    crypt = ledger.crypt;
  let previous = chain.completion!;
  const intentSha256 = await sha256Json(chain.intent);
  for (let revision = chain.passes.length + 1; revision <= count; revision++) {
    const startFields = {
      v: 1 as const,
      jobId: id,
      revision,
      intentSha256,
      previousCompletionSha256: await sha256Json(previous),
      startedAt: previous.erasedAt,
      hmacKeyId: crypt.secrets.keyId,
    };
    const start = {
      ...startFields,
      operationMac: await crypt.hash('erasure-pass.v1', [crypt.secrets.environment, startFields]),
    };
    const { operationMac: _oldMac, ...oldFields } = previous;
    const fields = { ...oldFields, revision, passSha256: await sha256Json(start) };
    previous = {
      ...fields,
      operationMac: await crypt.hash('erasure-completion.v1', [crypt.secrets.environment, fields]),
    };
    await env.RECOVERY.put(`erasures/v1/${id}/passes/${revision}/start.json`, canonicalJson(start));
    await env.RECOVERY.put(
      `erasures/v1/${id}/passes/${revision}/complete.json`,
      canonicalJson(previous),
    );
  }
}
