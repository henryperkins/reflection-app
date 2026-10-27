import { RecordCrypto } from '../readings/crypto.ts';
import { z } from 'zod';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import { Ciphertext } from '../../contracts/index.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { assertion } from '../identity/checkpoint.ts';
import type { RecordBase } from '../readings/base.ts';
import type { HostedCoordinator, OfflineContext } from './hosted-coordinator.ts';
import { ACCOUNT_FIELD_HANDLERS, type AccountPrivateField } from './private-fields.ts';
import { bytesDigest } from './digest.ts';

type Phase = 'inventorying' | 'rewriting' | 'validating' | 'checkpoint' | 'complete';
interface Job {
  id: string;
  owner_id: string;
  expected_version: number;
  target_version: number;
  phase: Phase;
  revision: number;
  registry_hash: string;
  inventory_hash: string;
  expected_count: number;
  field_count: number;
  cursor_json: string;
  context_json: string;
  checkpoint_operation_id: string;
  checkpoint_epoch: number | null;
  created_at: number;
}
interface Entry {
  operation_id: string;
  ordinal: number;
  table_name: string;
  column_name: string;
  key_json: string;
  aad_revision: number;
  source_version: number;
  source_cipher_hash: string;
  value_hmac: string;
  target_cipher_hash: string | null;
  completed: number;
  validated: number;
}
const Context = z.strictObject({
  environmentId: z.string(),
  operationId: z.uuid(),
  epoch: z.number().int().positive(),
  purpose: z.literal('rekey'),
});
const Cursor = z.strictObject({
  field: z.number().int().nonnegative(),
  keys: z.array(z.union([z.string(), z.number().int()])),
});
export function privateFieldRegistryHash() {
  return sha256Json(
    ACCOUNT_FIELD_HANDLERS.map(({ table, column, aadRule, keyColumns }) => ({
      table,
      column,
      aadRule,
      keyColumns,
    })),
  );
}
export interface RekeyReceipt {
  operationId: string;
  fromVersion: number;
  toVersion: number;
  fields: number;
  registryHash: string;
  inventoryHash: string;
  stillOffline: true;
}

/** Trusted offline operator only. Journals contain ciphertext digests/HMACs, never raw keys or values. */
export class AccountRekey {
  constructor(
    readonly base: RecordBase,
    readonly coordinator: HostedCoordinator,
    readonly initialContext?: OfflineContext,
  ) {}
  private async load(id: string) {
    const job = await q(
      this.base.db,
      'SELECT * FROM account_rekey_jobs WHERE id=?',
      id,
    ).first<Job>();
    if (!job) throw new Error('Replacement operation unavailable');
    if (job.registry_hash !== (await privateFieldRegistryHash()))
      throw new Error('Replacement registry changed');
    if (
      Context.parse(JSON.parse(job.context_json)).environmentId !==
      this.base.identity.crypt.secrets.environment
    )
      throw new Error('Wrong replacement environment');
    return job;
  }
  private context(job: Job): OfflineContext {
    return Context.parse(JSON.parse(job.context_json));
  }
  private guard(job: Job) {
    const context = this.context(job);
    return [
      assertion(
        this.base.db,
        "EXISTS(SELECT 1 FROM hosted_coordination WHERE environment_id=? AND epoch=? AND state='offline')",
        context.environmentId,
        context.epoch,
      ),
      assertion(
        this.base.db,
        "EXISTS(SELECT 1 FROM system_state WHERE id=1 AND restore_in_progress=1 AND generation_enabled=0 AND dispatch_mode='off')",
      ),
      assertion(
        this.base.db,
        'EXISTS(SELECT 1 FROM account_rekey_jobs WHERE id=? AND revision=? AND phase=?)',
        job.id,
        job.revision,
        job.phase,
      ),
      assertion(
        this.base.db,
        "EXISTS(SELECT 1 FROM accounts WHERE id=? AND status='active' AND key_version=?)",
        job.owner_id,
        ['checkpoint', 'complete'].includes(job.phase) ? job.target_version : job.expected_version,
      ),
    ];
  }
  private async safePending(allowedOperation = '') {
    if (
      await q(
        this.base.db,
        "SELECT 1 FROM security_operations WHERE state!='applied' AND id!=? UNION ALL SELECT 1 FROM deletion_jobs WHERE state!='complete' LIMIT 1",
        allowedOperation,
      ).first()
    )
      throw new Error('Flush pending security and erasure before replacement');
  }
  private async count(owner: string) {
    const results = await this.base.db.batch<{ n: number }>(
      ACCOUNT_FIELD_HANDLERS.map((f) =>
        q(
          this.base.db,
          `SELECT count(*) n FROM ${f.table} WHERE owner_id=? AND ${f.column} IS NOT NULL`,
          owner,
        ),
      ),
    );
    return results.reduce((sum, result) => {
      if (!result.success || !Number.isSafeInteger(result.results[0]?.n))
        throw new Error('Replacement inventory unavailable');
      return sum + result.results[0]!.n;
    }, 0);
  }
  async begin(ownerId: string, expectedVersion: number) {
    z.uuid().parse(ownerId);
    z.number().int().positive().parse(expectedVersion);
    const existing = await q(
      this.base.db,
      "SELECT id,target_version FROM account_rekey_jobs WHERE owner_id=? AND phase!='complete'",
      ownerId,
    ).first<{ id: string; target_version: number }>();
    if (existing) {
      const job = await this.load(existing.id);
      if (job.expected_version !== expectedVersion) throw new Error('Account version changed');
      await this.coordinator.assertCurrent(this.context(job));
      return { operationId: existing.id, targetVersion: existing.target_version };
    }
    const context = this.initialContext ?? (await this.coordinator.acquire('rekey'));
    if (
      context.purpose !== 'rekey' ||
      context.environmentId !== this.base.identity.crypt.secrets.environment
    )
      throw new Error('Wrong replacement context');
    return this.coordinator.withOffline(context, async () => {
      await this.safePending();
      const account = await q(
        this.base.db,
        "SELECT key_version FROM accounts WHERE id=? AND status='active' AND write_fence IS NULL",
        ownerId,
      ).first<{ key_version: number }>();
      if (account?.key_version !== expectedVersion) throw new Error('Account version changed');
      const previous = await q(
        this.base.db,
        'SELECT wrapped_index_key_enc FROM account_keys WHERE owner_id=? AND version=?',
        ownerId,
        expectedVersion,
      ).first<string>('wrapped_index_key_enc');
      if (!previous) throw new Error('Account key unavailable');
      const index = await this.base.identity.crypt.unwrapAccountKey(
          ownerId,
          previous,
          'index',
          expectedVersion,
        ),
        targetVersion = expectedVersion + 1;
      const wrapped = await this.base.identity.crypt.createAccountDataVersion(
        ownerId,
        targetVersion,
        index,
      );
      const operationId = crypto.randomUUID(),
        registryHash = await privateFieldRegistryHash(),
        count = await this.count(ownerId);
      await this.base.db.batch([
        assertion(
          this.base.db,
          'NOT EXISTS(SELECT 1 FROM hosted_coordination WHERE environment_id=? AND epoch>?)',
          context.environmentId,
          context.epoch,
        ),
        q(
          this.base.db,
          `INSERT INTO hosted_coordination VALUES(?,?,'offline',NULL,${DB_NOW}) ON CONFLICT(environment_id) DO UPDATE SET epoch=excluded.epoch,state='offline',evidence_hash=NULL,updated_at=excluded.updated_at`,
          context.environmentId,
          context.epoch,
        ),
        q(
          this.base.db,
          `INSERT INTO system_state(id,provider_policy_hash,updated_at) VALUES(1,?,${DB_NOW}) ON CONFLICT(id) DO NOTHING`,
          '0'.repeat(64),
        ),
        q(
          this.base.db,
          `UPDATE system_state SET restore_in_progress=1,generation_enabled=0,dispatch_mode='off',revision=revision+1,updated_at=${DB_NOW} WHERE id=1`,
        ),
        assertion(
          this.base.db,
          "EXISTS(SELECT 1 FROM accounts WHERE id=? AND key_version=? AND status='active' AND write_fence IS NULL)",
          ownerId,
          expectedVersion,
        ),
        ...this.base.stopStatements(ownerId, undefined, 'blocked', 'KEY_UNAVAILABLE'),
        q(
          this.base.db,
          "UPDATE provider_dispatches SET state='unknown' WHERE owner_id=? AND state='authorized'",
          ownerId,
        ),
        q(
          this.base.db,
          `UPDATE cost_reservations SET state='unknown',settled_at=${DB_NOW} WHERE state='reserved' AND dispatch_id IN(SELECT id FROM provider_dispatches WHERE owner_id=?)`,
          ownerId,
        ),
        q(
          this.base.db,
          `INSERT INTO account_keys VALUES(?,?,?,?,?,${DB_NOW})`,
          ownerId,
          targetVersion,
          wrapped.wrapKeyId,
          wrapped.wrappedKey,
          wrapped.wrappedIndexKey,
        ),
        q(
          this.base.db,
          `INSERT INTO account_rekey_jobs(id,owner_id,expected_version,target_version,phase,registry_hash,inventory_hash,expected_count,cursor_json,context_json,checkpoint_operation_id,created_at,updated_at) VALUES(?,?,?,?,'inventorying',?,?,?,?,?,?,${DB_NOW},${DB_NOW})`,
          operationId,
          ownerId,
          expectedVersion,
          targetVersion,
          registryHash,
          '0'.repeat(64),
          count,
          canonicalJson({ field: 0, keys: [] }),
          canonicalJson(context),
          crypto.randomUUID(),
        ),
      ]);
      return { operationId, targetVersion };
    });
  }
  /** Explicit handoff after rollback/lease loss; never adopts an epoch inferred from D1. */
  async adopt(operationId: string, context: OfflineContext) {
    const job = await this.load(operationId);
    if (
      context.purpose !== 'rekey' ||
      context.environmentId !== this.base.identity.crypt.secrets.environment ||
      context.epoch <= this.context(job).epoch
    )
      throw new Error('Current replacement lease required');
    return this.coordinator.withOffline(context, async () => {
      await this.base.db.batch([
        assertion(
          this.base.db,
          'NOT EXISTS(SELECT 1 FROM hosted_coordination WHERE environment_id=? AND epoch>?)',
          context.environmentId,
          context.epoch,
        ),
        assertion(
          this.base.db,
          'EXISTS(SELECT 1 FROM account_rekey_jobs WHERE id=? AND revision=?)',
          job.id,
          job.revision,
        ),
        assertion(
          this.base.db,
          "EXISTS(SELECT 1 FROM accounts WHERE id=? AND status='active' AND key_version=?)",
          job.owner_id,
          ['checkpoint', 'complete'].includes(job.phase)
            ? job.target_version
            : job.expected_version,
        ),
        q(
          this.base.db,
          `INSERT INTO hosted_coordination VALUES(?,?,'offline',NULL,${DB_NOW}) ON CONFLICT(environment_id) DO UPDATE SET epoch=excluded.epoch,state='offline',evidence_hash=NULL,updated_at=excluded.updated_at`,
          context.environmentId,
          context.epoch,
        ),
        q(
          this.base.db,
          `UPDATE system_state SET restore_in_progress=1,generation_enabled=0,dispatch_mode='off' WHERE id=1`,
        ),
        q(
          this.base.db,
          `UPDATE account_rekey_jobs SET context_json=?,revision=revision+1,updated_at=${DB_NOW} WHERE id=?`,
          canonicalJson(Context.parse(context)),
          job.id,
        ),
      ]);
    });
  }
  async assertTarget(operationId: string, ownerId: string, expectedVersion: number) {
    const job = await this.load(operationId);
    if (job.owner_id !== ownerId || job.expected_version !== expectedVersion)
      throw new Error('Wrong replacement account or version');
  }
  private field(entry: Entry) {
    const field = ACCOUNT_FIELD_HANDLERS.find(
      (f) => f.table === entry.table_name && f.column === entry.column_name,
    );
    if (!field) throw new Error('Unreviewed replacement field');
    return field;
  }
  private where(field: AccountPrivateField, keys: (string | number)[]) {
    if (keys.length !== field.keyColumns.length)
      throw new Error('Replacement field identity changed');
    return field.keyColumns.map((c) => c + '=?').join(' AND ');
  }
  private async row(job: Job, entry: Entry) {
    const field = this.field(entry),
      keys = z.array(z.union([z.string(), z.number().int()])).parse(JSON.parse(entry.key_json));
    const row = await q(
      this.base.db,
      `SELECT * FROM ${field.table} WHERE owner_id=? AND ${this.where(field, keys)}`,
      job.owner_id,
      ...keys,
    ).first<Record<string, unknown>>();
    if (!row || typeof row[field.column] !== 'string') throw new Error('Replacement field changed');
    const body = row[field.column] as string,
      identity = field.identity(row, body);
    if (identity.aadRevision !== entry.aad_revision)
      throw new Error('Immutable field revision changed');
    return { field, keys, row, body, identity };
  }
  private async inventory(
    job: Job,
    limit: number,
    records: RecordCrypto,
  ): Promise<{ phase: Phase; rewritten: number }> {
    const cursor = Cursor.parse(JSON.parse(job.cursor_json));
    const statements: D1PreparedStatement[] = [];
    const pending: Record<string, unknown>[] = [];
    let added = 0;
    while (cursor.field < ACCOUNT_FIELD_HANDLERS.length && added < limit) {
      const field = ACCOUNT_FIELD_HANDLERS[cursor.field]!;
      const after = cursor.keys.length
        ? ` AND (${field.keyColumns.join(',')})>(${cursor.keys.map(() => '?').join(',')})`
        : '';
      const remaining = limit - added;
      const rows = (
        await q(
          this.base.db,
          `SELECT * FROM ${field.table} WHERE owner_id=? AND ${field.column} IS NOT NULL${after} ORDER BY ${field.keyColumns.join(',')} LIMIT ?`,
          job.owner_id,
          ...cursor.keys,
          limit - added,
        ).all<Record<string, unknown>>()
      ).results;
      for (const row of rows) {
        const body = row[field.column] as string,
          envelope = Ciphertext.parse(JSON.parse(body)),
          identity = field.identity(row, body);
        if (envelope.keyVersion > job.expected_version)
          throw new Error('Unexpected mixed replacement');
        const value = await records.open(identity, body, z.unknown()),
          keys = field.keyColumns.map((c) => z.union([z.string(), z.number().int()]).parse(row[c]));
        statements.push(
          assertion(
            this.base.db,
            `EXISTS(SELECT 1 FROM ${field.table} WHERE owner_id=? AND ${this.where(field, keys)} AND ${field.column}=?)`,
            job.owner_id,
            ...keys,
            body,
          ),
        );
        const sourceHash = await bytesDigest(new TextEncoder().encode(body));
        const valueHmac = await records.hash(job.owner_id, 'account-rekey-value', [
          identity,
          value,
        ]);
        pending.push({
          table_name: field.table,
          column_name: field.column,
          key_json: canonicalJson(keys),
          aad_revision: identity.aadRevision,
          source_version: envelope.keyVersion,
          source_cipher_hash: sourceHash,
          value_hmac: valueHmac,
        });
        statements.push(
          q(
            this.base.db,
            'INSERT INTO account_rekey_entries(operation_id,owner_id,ordinal,table_name,column_name,key_json,aad_revision,source_version,source_cipher_hash,value_hmac) VALUES(?,?,?,?,?,?,?,?,?,?)',
            job.id,
            job.owner_id,
            job.field_count + added,
            field.table,
            field.column,
            canonicalJson(keys),
            identity.aadRevision,
            envelope.keyVersion,
            sourceHash,
            valueHmac,
          ),
        );
        cursor.keys = keys;
        added++;
      }
      if (rows.length < remaining) {
        cursor.field++;
        cursor.keys = [];
      }
    }
    const phase = cursor.field === ACCOUNT_FIELD_HANDLERS.length ? 'rewriting' : 'inventorying';
    if (phase === 'rewriting' && job.field_count + added !== job.expected_count)
      throw new Error('Replacement inventory changed');
    let inventoryHash = job.inventory_hash;
    if (phase === 'rewriting')
      inventoryHash = await sha256Json([...(await this.sourceEntries(job.id)), ...pending]);
    await this.base.db.batch([
      ...this.guard(job),
      ...statements,
      q(
        this.base.db,
        `UPDATE account_rekey_jobs SET phase=?,inventory_hash=?,field_count=field_count+?,cursor_json=?,revision=revision+1,updated_at=${DB_NOW} WHERE id=?`,
        phase,
        inventoryHash,
        added,
        canonicalJson(cursor),
        job.id,
      ),
    ]);
    return { phase, rewritten: 0 };
  }
  private async sourceEntries(id: string) {
    return (
      await q(
        this.base.db,
        'SELECT table_name,column_name,key_json,aad_revision,source_version,source_cipher_hash,value_hmac FROM account_rekey_entries WHERE operation_id=? ORDER BY ordinal',
        id,
      ).all()
    ).results;
  }
  async step(operationId: string, limit = 20): Promise<{ phase: Phase; rewritten: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new Error('Replacement batch limit is 20');
    const job = await this.load(operationId),
      context = this.context(job),
      records = new RecordCrypto(this.base.db, this.base.identity.crypt);
    return this.coordinator.withOffline(context, async () => {
      if (job.phase === 'complete') return { phase: 'complete', rewritten: 0 };
      await this.safePending(job.phase === 'checkpoint' ? job.checkpoint_operation_id : '');
      if (job.phase === 'inventorying') return this.inventory(job, limit, records);
      if (job.phase === 'checkpoint') {
        await this.checkpoint(job);
        return { phase: 'complete', rewritten: 0 };
      }
      const validating = job.phase === 'validating';
      const entries = (
        await q(
          this.base.db,
          `SELECT * FROM account_rekey_entries WHERE operation_id=? AND ${validating ? 'validated' : 'completed'}=0 ORDER BY ordinal LIMIT ?`,
          job.id,
          limit,
        ).all<Entry>()
      ).results;
      const statements: D1PreparedStatement[] = [];
      for (const entry of entries) {
        const { field, keys, body, identity } = await this.row(job, entry);
        if (
          (await bytesDigest(new TextEncoder().encode(body))) !==
          (validating ? entry.target_cipher_hash : entry.source_cipher_hash)
        )
          throw new Error('Replacement source ciphertext changed');
        const value = await records.open(identity, body, z.unknown());
        if (
          (await records.hash(job.owner_id, 'account-rekey-value', [identity, value])) !==
          entry.value_hmac
        )
          throw new Error('Replacement original value changed');
        if (validating) {
          if (Ciphertext.parse(JSON.parse(body)).keyVersion !== job.target_version)
            throw new Error('Replacement version mismatch');
          statements.push(
            q(
              this.base.db,
              'UPDATE account_rekey_entries SET validated=1 WHERE operation_id=? AND ordinal=?',
              job.id,
              entry.ordinal,
            ),
          );
        } else {
          const next = await records.seal(identity, value, job.target_version);
          statements.push(
            q(
              this.base.db,
              `UPDATE ${field.table} SET ${field.column}=? WHERE owner_id=? AND ${this.where(field, keys)} AND ${field.column}=?`,
              next,
              job.owner_id,
              ...keys,
              body,
            ),
            assertion(this.base.db, 'changes()=1'),
            q(
              this.base.db,
              'UPDATE account_rekey_entries SET target_cipher_hash=?,completed=1 WHERE operation_id=? AND ordinal=?',
              await bytesDigest(new TextEncoder().encode(next)),
              job.id,
              entry.ordinal,
            ),
          );
        }
      }
      let phase: Phase = job.phase;
      if (entries.length < limit) phase = validating ? 'checkpoint' : 'validating';
      if (phase === 'checkpoint') {
        if ((await sha256Json(await this.sourceEntries(job.id))) !== job.inventory_hash)
          throw new Error('Replacement journal changed');
        if ((await this.count(job.owner_id)) !== job.field_count)
          throw new Error('Replacement coverage changed');
        if (
          (await q(
            this.base.db,
            'SELECT count(*) n FROM account_rekey_entries WHERE operation_id=? AND validated=0',
            job.id,
          ).first<number>('n')) !== entries.length
        )
          throw new Error('Replacement validation incomplete');
        const tables = [
          ...new Set(
            ACCOUNT_FIELD_HANDLERS.filter((f) => f.table !== 'reading_sessions').map(
              (f) => f.table,
            ),
          ),
        ];
        for (const table of tables)
          statements.push(
            q(
              this.base.db,
              `UPDATE ${table} SET key_version=? WHERE owner_id=?`,
              job.target_version,
              job.owner_id,
            ),
          );
        statements.push(
          q(
            this.base.db,
            `UPDATE accounts SET key_version=?,data_revision=data_revision+1,updated_at=${DB_NOW} WHERE id=?`,
            job.target_version,
            job.owner_id,
          ),
        );
      }
      await this.base.db.batch([
        ...this.guard(job),
        ...statements,
        q(
          this.base.db,
          `UPDATE account_rekey_jobs SET phase=?,checkpoint_epoch=CASE WHEN ?='checkpoint' THEN (SELECT auth_epoch+1 FROM accounts WHERE id=owner_id) ELSE checkpoint_epoch END,revision=revision+1,updated_at=${DB_NOW} WHERE id=?`,
          phase,
          phase,
          job.id,
        ),
      ]);
      return { phase, rewritten: validating ? 0 : entries.length };
    });
  }
  private async checkpoint(job: Job) {
    const epoch = await q(
      this.base.db,
      'SELECT auth_epoch FROM accounts WHERE id=?',
      job.owner_id,
    ).first<number>('auth_epoch');
    if (epoch === null || job.checkpoint_epoch === null)
      throw new Error('Replacement checkpoint unavailable');
    const operation = await q(
      this.base.db,
      'SELECT state FROM security_operations WHERE id=?',
      job.checkpoint_operation_id,
    ).first<string>('state');
    const lease = { coordinator: this.coordinator, context: this.context(job) };
    if (operation && operation !== 'applied')
      await this.base.identity.checkpoints.apply(job.checkpoint_operation_id, lease);
    else if (epoch < job.checkpoint_epoch) {
      const previous = await this.base.identity.snapshot(job.owner_id);
      await this.base.identity.checkpoints.commit(
        {
          ...previous,
          operationId: job.checkpoint_operation_id,
          epoch: job.checkpoint_epoch,
          createdAt: new Date().toISOString(),
        },
        { expected: previous, lease },
      );
    }
    await this.base.db.batch([
      ...this.guard(job),
      assertion(
        this.base.db,
        'EXISTS(SELECT 1 FROM accounts WHERE id=? AND auth_epoch>=? AND write_fence IS NULL)',
        job.owner_id,
        job.checkpoint_epoch,
      ),
      q(
        this.base.db,
        `UPDATE account_rekey_jobs SET phase='complete',revision=revision+1,updated_at=${DB_NOW} WHERE id=?`,
        job.id,
      ),
    ]);
  }
  async validate(operationId: string): Promise<RekeyReceipt> {
    const job = await this.load(operationId),
      records = new RecordCrypto(this.base.db, this.base.identity.crypt);
    return this.coordinator.withOffline(this.context(job), async () => {
      await this.safePending();
      if (job.phase !== 'complete' || (await this.count(job.owner_id)) !== job.field_count)
        throw new Error('Replacement not complete');
      if ((await sha256Json(await this.sourceEntries(job.id))) !== job.inventory_hash)
        throw new Error('Replacement journal changed');
      const entries = (
        await q(
          this.base.db,
          'SELECT * FROM account_rekey_entries WHERE operation_id=? ORDER BY ordinal',
          job.id,
        ).all<Entry>()
      ).results;
      for (const entry of entries) {
        const current = await this.row(job, entry);
        const value = await records.open(current.identity, current.body, z.unknown());
        if (
          (await records.hash(job.owner_id, 'account-rekey-value', [current.identity, value])) !==
          entry.value_hmac
        )
          throw new Error('Replacement original value changed');
        if (
          !entry.validated ||
          (await bytesDigest(new TextEncoder().encode(current.body))) !== entry.target_cipher_hash
        )
          throw new Error('Replacement validation changed');
      }
      await this.base.db.batch(this.guard(job));
      return {
        operationId: job.id,
        fromVersion: job.expected_version,
        toVersion: job.target_version,
        fields: job.field_count,
        registryHash: job.registry_hash,
        inventoryHash: job.inventory_hash,
        stillOffline: true,
      };
    });
  }
}
