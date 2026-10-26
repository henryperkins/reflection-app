import type { Env } from '../index.ts';
import type { Checkpoint, IdentitySecrets } from '../identity/crypto.ts';
import { assertion } from '../identity/checkpoint.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { sha256Json } from '../../domain/json.ts';
import { recoveryExclusive } from './coordination.ts';
import {
  CleanupJournal,
  CLEANUP_LIMIT,
  type LoadedCleanup,
  type PendingCleanup,
} from './cleanup-state.ts';
import { DAY, erasureJobIds, type Chain, type Target } from './ledger.ts';
import { OfflineRestore } from './restore.ts';

export interface CleanupBackup {
  /** Capture actual offline D1 state in separate trusted local storage and return its SHA-256. */
  capture(db: D1Database, epoch: number): Promise<string>;
  /** Re-read and authenticate the captured snapshot, including its recovery epoch. */
  verify(sha256: string, epoch: number): Promise<boolean>;
}
type Entry = { key: string; etag: string; size: number };
type Group = { objects: Entry[]; jobs: string[]; operations: string[] };
const rows = (inventory: Awaited<ReturnType<OfflineRestore['inventory']>>) =>
  [...inventory.erasures, ...inventory.identity].sort((a, b) => a.key.localeCompare(b.key));

/** Trusted synthetic operator only. Never imported by HTTP or scheduled handlers. */
export class OfflineCleanup {
  readonly restore: OfflineRestore;
  readonly journal: CleanupJournal;
  constructor(
    readonly env: Env,
    readonly backup: CleanupBackup,
    retainedKeys: IdentitySecrets[] = [],
  ) {
    this.restore = new OfflineRestore(env, { retainedKeys });
    this.journal = new CleanupJournal(this.restore.erasure.ledger);
  }
  async run() {
    return recoveryExclusive(this.restore.base.identity.crypt.secrets.environment, async () => {
      await this.restore.fence();
      const previous = await this.journal.read();
      const currentEpoch =
        (await q(this.env.DB, 'SELECT recovery_epoch FROM system_state WHERE id=1').first<number>(
          'recovery_epoch',
        )) ?? 0;
      if (previous?.value.phase === 'pending') return this.resume(previous);
      if (previous ? currentEpoch < previous.value.epoch : currentEpoch > 0)
        throw new Error('Recovery epoch or independent cleanup receipt is missing');
      const inventory = await this.restore.inventory();
      const groups = await this.candidates(inventory);
      const selected: Group[] = [];
      let count = 0;
      for (const group of groups) {
        if (count + group.objects.length > CLEANUP_LIMIT) continue;
        selected.push(group);
        count += group.objects.length;
      }
      if (!count) {
        await this.onlineFence();
        return { status: 'complete' as const, purgedObjects: 0, recoveryEpoch: currentEpoch };
      }
      const candidates = selected.flatMap((g) => g.objects);
      const chosen = new Set(candidates.map((o) => o.key));
      const retained = rows(inventory).filter((o) => !chosen.has(o.key));
      if ((await sha256Json(inventory)) !== (await sha256Json(await this.restore.inventory())))
        throw new Error('Recovery inventory changed');
      const epoch = currentEpoch + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error('Recovery epoch exhausted');
      const jobs = selected.flatMap((g) => g.jobs),
        operations = selected.flatMap((g) => g.operations);
      // Keep an undo image only until the independent pending plan is durable. A failed capture
      // or CAS must not strand a database epoch whose receipt was never published.
      const undo: D1PreparedStatement[] = [];
      const remove: D1PreparedStatement[] = [
        assertion(
          this.env.DB,
          'EXISTS(SELECT 1 FROM system_state WHERE id=1 AND restore_in_progress=1 AND recovery_epoch=?)',
          currentEpoch,
        ),
      ];
      for (const [table, ids] of [
        ['deletion_jobs', jobs],
        ['security_operations', operations],
      ] as const) {
        for (const id of new Set(ids)) {
          const value = await q(this.env.DB, `SELECT * FROM ${table} WHERE id=?`, id).first<
            Record<string, string | number | null>
          >();
          if (!value) continue;
          const columns = Object.keys(value);
          undo.push(
            q(
              this.env.DB,
              `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
              ...columns.map((c) => value[c]!),
            ),
          );
          remove.push(q(this.env.DB, `DELETE FROM ${table} WHERE id=?`, id));
        }
      }
      remove.push(q(this.env.DB, 'UPDATE system_state SET recovery_epoch=? WHERE id=1', epoch));
      await this.env.DB.batch(remove);
      let pending: LoadedCleanup;
      try {
        const digest = await this.backup.capture(this.env.DB, epoch);
        if (!/^[a-f0-9]{64}$/.test(digest) || !(await this.backup.verify(digest, epoch)))
          throw new Error('Fresh backup verification failed');
        if ((await sha256Json(inventory)) !== (await sha256Json(await this.restore.inventory())))
          throw new Error('Recovery inventory changed before purge');
        pending = await this.journal.write(
          {
            phase: 'pending',
            epoch,
            backupSha256: digest,
            retainedInventorySha256: await sha256Json(retained),
            objects: candidates.map(({ key, etag }) => ({ key, etag })),
          },
          previous,
        );
      } catch (error) {
        // A lost PUT response may still have published the plan. Never roll back across it.
        const observed = await this.journal.read();
        if ((observed?.etag ?? null) === (previous?.etag ?? null))
          await this.env.DB.batch([
            assertion(
              this.env.DB,
              'EXISTS(SELECT 1 FROM system_state WHERE id=1 AND restore_in_progress=1 AND recovery_epoch=?)',
              epoch,
            ),
            ...undo,
            q(this.env.DB, 'UPDATE system_state SET recovery_epoch=? WHERE id=1', currentEpoch),
          ]);
        throw error;
      }
      return this.resume(pending);
    });
  }
  private async onlineFence() {
    // The separate RESTORE_MODE=offline binding remains. Generation stays globally disabled.
    await q(this.env.DB, 'UPDATE system_state SET restore_in_progress=0 WHERE id=1').run();
  }
  private async resume(loaded: LoadedCleanup) {
    if (loaded.value.phase !== 'pending') throw new Error('Missing pending cleanup plan');
    const plan: PendingCleanup = loaded.value;
    const epoch = await q(
      this.env.DB,
      'SELECT recovery_epoch FROM system_state WHERE id=1',
    ).first<number>('recovery_epoch');
    if (epoch !== plan.epoch) throw new Error('Cleanup database epoch mismatch');
    if (!(await this.backup.verify(plan.backupSha256, plan.epoch)))
      throw new Error('Cleanup backup unavailable');
    const expected = new Map(plan.objects.map((o) => [o.key, o.etag]));
    const inventory = rows(await this.restore.inventory());
    if (
      (await sha256Json(inventory.filter((o) => !expected.has(o.key)))) !==
      plan.retainedInventorySha256
    )
      throw new Error('Retained recovery inventory changed');
    for (const item of inventory)
      if (expected.has(item.key) && expected.get(item.key) !== item.etag)
        throw new Error('Planned recovery object changed');
    for (const item of plan.objects) {
      const current = await this.env.RECOVERY!.head(item.key);
      if (!current) continue; // Absence is allowed only under this already-durable pending plan.
      if (current.etag !== item.etag) throw new Error('Planned recovery object changed');
      await this.env.RECOVERY!.delete(item.key);
      if (await this.env.RECOVERY!.head(item.key)) throw new Error('Recovery deletion unavailable');
    }
    if ((await sha256Json(rows(await this.restore.inventory()))) !== plan.retainedInventorySha256)
      throw new Error('Recovery inventory changed during purge');
    await this.journal.write(
      {
        phase: 'complete',
        epoch: plan.epoch,
        backupSha256: plan.backupSha256,
        purgedObjects: plan.objects.length,
      },
      loaded,
    );
    await this.onlineFence();
    return {
      status: 'complete' as const,
      purgedObjects: plan.objects.length,
      recoveryEpoch: plan.epoch,
    };
  }
  private async candidates(inventory: Awaited<ReturnType<OfflineRestore['inventory']>>) {
    const db = this.env.DB;
    if (
      await q(
        db,
        "SELECT 1 FROM security_operations WHERE state!='applied' UNION ALL SELECT 1 FROM deletion_jobs WHERE state!='complete' UNION ALL SELECT 1 FROM accounts WHERE write_fence IS NOT NULL OR status!='active' LIMIT 1",
      ).first()
    )
      throw new Error('Pending security or erasure operation');
    if ((await q(db, 'PRAGMA foreign_key_check').all()).results.length)
      throw new Error('Invalid database ownership');
    const now = (await q(db, `SELECT ${DB_NOW} AS now`).first<number>('now'))!;
    const chains: Chain[] = [];
    for (const id of erasureJobIds(inventory.erasures)) {
      const chain = await this.restore.erasure.ledger.load(id);
      if (chain.pending || !chain.completion) throw new Error('Pending erasure pass');
      chains.push(chain);
    }
    const independentIds = new Set(chains.map((c) => c.intent.jobId));
    const projected = (await q(db, 'SELECT id FROM deletion_jobs').all<{ id: string }>()).results;
    if (projected.some((j) => !independentIds.has(j.id)))
      throw new Error('Missing independent erasure inventory');
    const erased = new Set(
      chains.filter((c) => c.target.scope === 'account').map((c) => c.target.subjectId),
    );
    const accounts = (
      await q(db, 'SELECT id,auth_epoch,key_version FROM accounts ORDER BY id').all<{
        id: string;
        auth_epoch: number;
        key_version: number;
      }>()
    ).results;
    const all = new Map<string, Checkpoint>();
    const latest = await this.restore.checkpoints(
      inventory.identity,
      accounts.map((a) => a.id),
      erased,
      all,
    );
    for (const account of accounts) {
      if (erased.has(account.id)) throw new Error('Account erasure has not been applied');
      if (latest.get(account.id)?.epoch !== account.auth_epoch)
        throw new Error('Current identity checkpoint mismatch');
      await this.restore.validateAccountKeys(account.id, account.key_version);
    }
    const eligible = new Set<string>();
    for (const chain of chains) {
      const completion = chain.completion!;
      if (Date.parse(completion.purgeAfter) > now || Date.parse(completion.backupExpiresBy) > now)
        continue;
      await this.requireErased(chain.target);
      const job = await q(
        db,
        'SELECT state,target_hmac,ledger_key FROM deletion_jobs WHERE id=?',
        chain.intent.jobId,
      ).first<{ state: string; target_hmac: string; ledger_key: string }>();
      if (
        job &&
        (job.state !== 'complete' ||
          job.target_hmac !== chain.intent.targetHmac ||
          job.ledger_key !== `erasures/v1/${chain.intent.jobId}/intent.json`)
      )
        throw new Error('Erasure projection mismatch');
      eligible.add(chain.intent.jobId);
    }
    const groupFor = (subset: Chain[]): Group => ({
      jobs: subset.map((c) => c.intent.jobId),
      operations: [],
      objects: inventory.erasures.filter((o) =>
        subset.some((c) => o.key.startsWith(`erasures/v1/${c.intent.jobId}/`)),
      ),
    });
    const groups: Group[] = [];
    // Delete an erased owner's evidence and immutable empty markers as one bounded group.
    for (const owner of erased) {
      const owned = chains.filter((c) => c.target.subjectId === owner);
      if (!owned.every((c) => eligible.has(c.intent.jobId))) continue;
      const prefixes = await Promise.all(
        [...this.restore.erasure.ledger.keys.values()].map(
          async (k) => `identity/v1/${await k.hash('identity-subject', owner)}/`,
        ),
      );
      const markers = inventory.identity.filter((o) => prefixes.some((p) => o.key.startsWith(p)));
      if (markers.some((o) => o.size !== 0))
        throw new Error('Account checkpoint erasure is incomplete');
      const group = groupFor(owned);
      group.objects.push(...markers);
      groups.push(group);
    }
    for (const chain of chains)
      if (!erased.has(chain.target.subjectId) && eligible.has(chain.intent.jobId))
        groups.push(groupFor([chain]));
    for (const account of accounts) {
      const ordered = [...all.entries()]
        .filter(([, c]) => c.subjectId === account.id)
        .sort(([, a], [, b]) => a.epoch - b.epoch);
      for (let i = 0; i < ordered.length - 1; i++) {
        const [key, checkpoint] = ordered[i]!,
          successor = ordered[i + 1]![1];
        if (Date.parse(successor.createdAt) > now - 45 * DAY) continue;
        if (Date.parse(checkpoint.createdAt) > Date.parse(successor.createdAt))
          throw new Error('Nonmonotonic checkpoint time');
        const operation = await q(
          db,
          'SELECT state,applied_at FROM security_operations WHERE id=?',
          checkpoint.operationId,
        ).first<{ state: string; applied_at: number | null }>();
        if (
          operation &&
          (operation.state !== 'applied' ||
            operation.applied_at === null ||
            operation.applied_at > now - 30 * DAY)
        )
          continue;
        groups.push({
          objects: [inventory.identity.find((o) => o.key === key)!],
          jobs: [],
          operations: [checkpoint.operationId],
        });
      }
    }
    return groups;
  }
  private async requireErased(target: Target) {
    const db = this.env.DB,
      owner = target.subjectId;
    if (target.scope === 'account') {
      if (await q(db, 'SELECT 1 FROM accounts WHERE id=?', owner).first())
        throw new Error('Account is not erased');
      return;
    }
    // Milestone 3 copies are not supported by this local cleanup. Absence of the source is
    // insufficient proof: independently reject any unqualified copy family for its owner.
    for (const table of [
      'import_batches',
      'import_items',
      'import_identities',
      'generation_context',
      'context_grants',
      'revisits',
    ])
      if (await q(db, `SELECT 1 FROM ${table} WHERE owner_id=? LIMIT 1`, owner).first())
        throw new Error('Unsupported erasure copy family');
    if (target.scope === 'reflection_revision') {
      if (
        await q(
          db,
          'SELECT 1 FROM reflection_revisions WHERE owner_id=? AND reflection_id=? AND revision=? AND (body_enc IS NOT NULL OR erased_at IS NULL)',
          owner,
          target.reflectionId,
          target.revision,
        ).first()
      )
        throw new Error('Reflection is not erased');
      return;
    }
    if (target.scope !== 'session') throw new Error('Unsupported erasure target');
    const id = target.sessionId;
    const checks: Array<[string, (string | number)[]]> = [
      [
        "SELECT 1 FROM reading_sessions WHERE owner_id=? AND id=? AND (status!='deleted' OR question_enc IS NOT NULL)",
        [owner, id],
      ],
      [
        'SELECT 1 FROM basis_snapshots WHERE owner_id=? AND session_id=? AND body_enc IS NOT NULL',
        [owner, id],
      ],
      [
        "SELECT 1 FROM reading_editions WHERE owner_id=? AND session_id=? AND (body_enc IS NOT NULL OR status!='deleted')",
        [owner, id],
      ],
      [
        "SELECT 1 FROM generation_requests WHERE owner_id=? AND session_id=? AND (input_enc IS NOT NULL OR plan_enc IS NOT NULL OR state NOT IN ('published','failed','blocked','expired','cancelled'))",
        [owner, id],
      ],
      [
        "SELECT 1 FROM quota_reservations q JOIN generation_requests r ON r.owner_id=q.owner_id AND r.id=q.request_id WHERE r.owner_id=? AND r.session_id=? AND q.state='held'",
        [owner, id],
      ],
      [
        'SELECT 1 FROM reflection_revisions r JOIN reflections f ON f.owner_id=r.owner_id AND f.id=r.reflection_id WHERE f.owner_id=? AND f.session_id=? AND (r.body_enc IS NOT NULL OR r.erased_at IS NULL)',
        [owner, id],
      ],
      [
        'SELECT 1 FROM provider_dispatches d JOIN generation_requests r ON r.owner_id=d.owner_id AND r.id=d.request_id WHERE r.owner_id=? AND r.session_id=? AND (d.transmission_enc IS NOT NULL OR d.candidate_enc IS NOT NULL OR d.provider_response_id_enc IS NOT NULL)',
        [owner, id],
      ],
    ];
    for (const [sql, values] of checks)
      if (await q(db, sql, ...values).first()) throw new Error('Session is not erased');
  }
}
