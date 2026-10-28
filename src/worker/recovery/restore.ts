import { ACCOUNT_FIELD_HANDLERS } from './private-fields.ts';
import type { ApplicationRuntime } from '../runtime/application.ts';
import type { HostedCoordinator, OfflineContext } from './hosted-coordinator.ts';
import type { ProtectedBackupInventory } from './backup-inventory.ts';
import { verifyAttestedRecoveryObjects } from './attested-inventory.ts';
import { bytesDigest } from './digest.ts';
import { z } from 'zod';
import type { Env } from '../index.ts';
import { IdentityCheckpoint } from '../../contracts/index.ts';
import { sha256Json } from '../../domain/json.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import {
  IdentityCrypto,
  decode,
  type IdentitySecrets,
  type Checkpoint,
} from '../identity/crypto.ts';
import { localIdentity } from '../identity/routes.ts';
import { assertion } from '../identity/checkpoint.ts';
import { RecordBase } from '../readings/base.ts';
import { SessionErasure } from '../readings/erasure.ts';
import { syntheticBundle, localDevelopmentBundle } from '../readings/local-content.ts';
import { objects, erasureJobIds, type Chain } from './ledger.ts';
import { recoveryExclusive, type RecoveryLease } from './coordination.ts';
import { CleanupJournal, CLEANUP_STATE_KEY } from './cleanup-state.ts';

export interface OfflineRestoreOptions {
  retainedKeys?: IdentitySecrets[];
  now?: () => number;
  runtime?: ApplicationRuntime;
  offline?: { coordinator: HostedCoordinator; context: OfflineContext };
  validateContent?: (hash: string) => Promise<boolean>;
  backupInventory?: ProtectedBackupInventory;
}
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Local operator service only. No HTTP route imports this module. One offline runner owns D1/R2. */
export class OfflineRestore {
  readonly base: RecordBase;
  readonly erasure: SessionErasure;
  readonly now: () => number;
  private readonly recoveryMutations = new Map<string, string | null>();
  constructor(
    readonly env: Env,
    readonly options: OfflineRestoreOptions = {},
  ) {
    const identity = options.runtime?.identity ?? localIdentity(env);
    if (
      env.RESTORE_MODE !== 'offline' ||
      !identity ||
      (options.runtime
        ? !options.offline ||
          !options.validateContent ||
          options.runtime.environmentId !== identity.crypt.secrets.environment ||
          options.offline.context.environmentId !== options.runtime.environmentId ||
          options.offline.coordinator.environmentId !== options.runtime.environmentId
        : env.READING_MODE !== 'synthetic-local' ||
          identity.crypt.secrets.environment !== 'synthetic-local')
    )
      throw new Error('Restore requires explicit offline identity and coordinator bindings');
    this.base = new RecordBase(env.DB, identity);
    this.erasure = new SessionErasure(
      this.base,
      options.runtime ? this.trackedRecovery(env.RECOVERY!) : env.RECOVERY!,
      options.retainedKeys?.map((k) => new IdentityCrypto(k)),
    );
    this.now = options.now ?? Date.now;
  }
  private trackedRecovery(bucket: R2Bucket): R2Bucket {
    const mutations = this.recoveryMutations;
    return new Proxy(bucket, {
      get(target, key) {
        if (key === 'put')
          return async (...args: Parameters<R2Bucket['put']>) => {
            const result = await target.put(...args);
            if (result) {
              const stored = await target.get(args[0]);
              if (!stored || stored.etag !== result.etag || stored.size > 64 * 1024 * 1024)
                throw new Error('Recovery mutation proof unavailable');
              mutations.set(args[0], await bytesDigest(await stored.arrayBuffer()));
            }
            return result;
          };
        if (key === 'delete')
          return async (keys: string | string[]) => {
            await target.delete(keys);
            for (const name of typeof keys === 'string' ? [keys] : keys) mutations.set(name, null);
          };
        const value = Reflect.get(target, key);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }
  async fence() {
    if (this.options.offline) {
      const { coordinator, context } = this.options.offline;
      await coordinator.assertCurrent(context);
      await this.env.DB.batch([
        assertion(
          this.env.DB,
          'NOT EXISTS(SELECT 1 FROM hosted_coordination WHERE environment_id=? AND epoch>?)',
          context.environmentId,
          context.epoch,
        ),
        q(
          this.env.DB,
          `INSERT INTO hosted_coordination(environment_id,epoch,state,evidence_hash,updated_at) VALUES(?,?,'offline',NULL,${DB_NOW}) ON CONFLICT(environment_id) DO UPDATE SET epoch=excluded.epoch,state='offline',evidence_hash=NULL,updated_at=excluded.updated_at`,
          context.environmentId,
          context.epoch,
        ),
      ]);
    }
    await this.env.DB.batch([
      q(
        this.env.DB,
        `INSERT INTO system_state(id,provider_policy_hash,updated_at) VALUES (1,?,${DB_NOW}) ON CONFLICT(id) DO NOTHING`,
        '0'.repeat(64),
      ),
      q(
        this.env.DB,
        `UPDATE system_state SET restore_in_progress=1,generation_enabled=0,dispatch_mode='off',revision=revision+1,updated_at=${DB_NOW} WHERE id=1`,
      ),
    ]);
  }
  async exclusive<T>(work: (lease: RecoveryLease) => Promise<T>): Promise<T> {
    if (this.options.offline) {
      const lease = this.options.offline;
      return lease.coordinator.withOffline(lease.context, () => work(lease));
    }
    return recoveryExclusive(this.base.identity.crypt.secrets.environment, work);
  }
  /** Flush accessible operations before taking the database back to an older bookmark. */
  async prepare() {
    return this.exclusive(async (lease) => {
      await this.fence();
      await new CleanupJournal(this.erasure.ledger).requireRestorable(this.env.DB);
      for (;;) {
        const pending = await q(
          this.env.DB,
          "SELECT id FROM security_operations WHERE state!='applied' ORDER BY created_at LIMIT 100",
        ).all<{ id: string }>();
        if (!pending.results.length) break;
        for (const row of pending.results)
          await this.base.identity.checkpoints.apply(row.id, lease);
      }
      for (;;) {
        const pending = await q(
          this.env.DB,
          "SELECT id FROM deletion_jobs WHERE state!='complete' ORDER BY created_at LIMIT 100",
        ).all<{ id: string }>();
        if (!pending.results.length) break;
        for (const row of pending.results) await this.erasure.resume(row.id, lease);
      }
      return { status: 'offline' as const };
    });
  }
  async replay() {
    return this.exclusive(async () => {
      await this.fence();
      this.recoveryMutations.clear();
      if (this.options.offline && !this.options.backupInventory)
        throw new Error('Independent hosted recovery inventory required');
      const attested = this.options.offline
        ? await verifyAttestedRecoveryObjects(
            this.options.backupInventory!,
            this.env.RECOVERY!,
            this.options.offline.context.environmentId,
            this.options.offline.context.epoch,
          )
        : null;
      await new CleanupJournal(this.erasure.ledger).requireRestorable(this.env.DB);
      const inventory = await this.inventory();
      const jobs = erasureJobIds(inventory.erasures);
      const chains: Chain[] = [];
      for (const id of jobs) chains.push(await this.erasure.ledger.load(id));
      const erasedAccounts = new Set(
        chains.filter((c) => c.target.scope === 'account').map((c) => c.target.subjectId),
      );
      const accounts = (
        await q(this.env.DB, 'SELECT id,auth_epoch,key_version FROM accounts ORDER BY id').all<{
          id: string;
          auth_epoch: number;
          key_version: number;
        }>()
      ).results;
      const checkpoints = await this.checkpoints(
        inventory.identity,
        accounts.map((a) => a.id),
        erasedAccounts,
      );
      // No cleanup or other writer may change the independent inventory during validation.
      if ((await sha256Json(inventory)) !== (await sha256Json(await this.inventory())))
        throw new Error('Recovery inventory changed');
      // Account erasure overrides all retained identity checkpoints and other owned targets.
      chains.sort(
        (a, b) => Number(b.target.scope === 'account') - Number(a.target.scope === 'account'),
      );
      for (const original of chains) {
        const chain = await this.erasure.ledger.load(original.intent.jobId);
        const pass = await this.erasure.ledger.begin(chain, this.now());
        await this.erasure.project(chain.intent, chain.target, null);
        await this.env.DB.batch(this.erasure.fence(chain.target));
        await this.erasure.eraseTarget(chain.intent.jobId, chain.target);
        const complete = await this.erasure.ledger.finish(chain, pass, this.now());
        await this.erasure.project(chain.intent, chain.target, complete);
      }
      for (const account of accounts) {
        if (erasedAccounts.has(account.id)) continue;
        const checkpoint = checkpoints.get(account.id);
        if (!checkpoint || checkpoint.epoch < account.auth_epoch)
          throw new Error('Missing current identity checkpoint');
        await this.applyCheckpoint(checkpoint);
        await this.validateAccountKeys(account.id, account.key_version);
      }
      await this.resetRuntime();
      await this.checkContent();
      await this.validateBodies();
      if ((await q(this.env.DB, 'PRAGMA foreign_key_check').all()).results.length)
        throw new Error('Restore ownership check failed');
      const pending = await q(
        this.env.DB,
        "SELECT 1 FROM deletion_jobs WHERE state!='complete' LIMIT 1",
      ).first();
      if (pending) throw new Error('Unflushed erasure remains pending');
      const resulting = this.options.offline
        ? await verifyAttestedRecoveryObjects(
            this.options.backupInventory!,
            this.env.RECOVERY!,
            this.options.offline.context.environmentId,
            this.options.offline.context.epoch,
            this.recoveryMutations,
          )
        : null;
      if (attested && resulting?.manifestDigest !== attested.manifestDigest)
        throw new Error('Independent recovery inventory changed during replay');
      // Only the local runner can now remove its explicit offline binding. Dispatch stays off.
      if (!this.options.offline)
        await q(this.env.DB, 'UPDATE system_state SET restore_in_progress=0 WHERE id=1').run();
      return {
        status: 'verified' as const,
        scope: this.options.offline
          ? ('hosted-synthetic' as const)
          : ('synthetic-local-only' as const),
        erasureJobs: chains.length,
        identityCheckpoints: checkpoints.size,
        generationEnabled: false as const,
        inventorySha256: await sha256Json(inventory),
        ...(attested && resulting
          ? {
              independentInventorySha256: attested.manifestDigest,
              recoveryResultSha256: resulting.objectDigest,
            }
          : {}),
      };
    });
  }
  async inventory() {
    const normalize = (items: R2Object[]) =>
      items
        .map((i) => ({ key: i.key, etag: i.etag, size: i.size }))
        .sort((a, b) => a.key.localeCompare(b.key));
    const all = await objects(this.env.RECOVERY!, '');
    if (
      all.some(
        (o) =>
          o.key !== CLEANUP_STATE_KEY &&
          !o.key.startsWith('erasures/') &&
          !o.key.startsWith('identity/'),
      )
    )
      throw new Error('Unexpected recovery object');
    return {
      erasures: normalize(all.filter((o) => o.key.startsWith('erasures/'))),
      identity: normalize(all.filter((o) => o.key.startsWith('identity/'))),
    };
  }
  async checkpoints(
    entries: Array<{ key: string; etag: string; size: number }>,
    owners: string[],
    erased: Set<string>,
    all?: Map<string, Checkpoint>,
  ) {
    const result = new Map<string, Checkpoint>();
    const byPrefix = new Map<string, string>();
    for (const owner of new Set([...owners, ...erased]))
      for (const crypt of this.erasure.ledger.keys.values())
        byPrefix.set(await crypt.recoveryHash('identity-subject', owner), owner);
    const epochs = new Set<string>();
    for (const entry of entries) {
      const match = new RegExp(`^identity/v1/([a-f0-9]{64})/([1-9][0-9]*)-(${uuid})\\.enc$`).exec(
        entry.key,
      );
      if (!match || entry.size > 91_000) throw new Error('Invalid identity inventory');
      const expected = byPrefix.get(match[1]!);
      if (!expected) throw new Error('Checkpoint account/key missing from restored inventory');
      if (erased.has(expected)) continue;
      const object = await this.env.RECOVERY!.get(entry.key);
      if (!object || object.etag !== entry.etag) throw new Error('Identity checkpoint unavailable');
      const raw = await object.text();
      const crypt = this.erasure.ledger.key(this.base.identity.crypt.envelopeKeyId(raw));
      if ((await crypt.recoveryHash('identity-subject', expected)) !== match[1])
        throw new Error('Checkpoint key prefix mismatch');
      const snapshot = IdentityCheckpoint.parse(
        await crypt.openCheckpoint(expected, Number(match[2]), match[3]!, raw),
      );
      all?.set(entry.key, snapshot);
      const epoch = `${snapshot.subjectId}:${snapshot.epoch}`;
      if (epochs.has(epoch)) throw new Error('Ambiguous identity checkpoint epoch');
      epochs.add(epoch);
      if ((await crypt.checkpointKey(snapshot)) !== entry.key)
        throw new Error('Checkpoint identity mismatch');
      if (!result.has(snapshot.subjectId) || result.get(snapshot.subjectId)!.epoch < snapshot.epoch)
        result.set(snapshot.subjectId, snapshot);
    }
    return result;
  }
  async validateAccountKeys(owner: string, version: number) {
    const keys = (
      await q(
        this.env.DB,
        'SELECT version,wrapped_key_enc,wrapped_index_key_enc FROM account_keys WHERE owner_id=?',
        owner,
      ).all<{ version: number; wrapped_key_enc: string; wrapped_index_key_enc: string }>()
    ).results;
    if (!keys.some((k) => k.version === version)) throw new Error('Missing account data key');
    for (const key of keys) {
      await this.base.identity.crypt.unwrapAccountKey(
        owner,
        key.wrapped_key_enc,
        'data',
        key.version,
      );
      await this.base.identity.crypt.unwrapAccountKey(
        owner,
        key.wrapped_index_key_enc,
        'index',
        key.version,
      );
    }
  }
  private async applyCheckpoint(snapshot: Checkpoint) {
    const owner = snapshot.subjectId;
    const statements = [
      q(this.env.DB, 'DELETE FROM credentials WHERE owner_id=?', owner),
      q(this.env.DB, 'DELETE FROM recovery_codes WHERE owner_id=?', owner),
      q(this.env.DB, 'DELETE FROM security_operations WHERE owner_id=?', owner),
    ];
    for (const credential of snapshot.credentials)
      statements.push(
        q(
          this.env.DB,
          'INSERT INTO credentials(id,owner_id,public_key,sign_count,backed_up,transports_json,created_at) VALUES (?,?,?,?,?,?,?)',
          credential.id,
          owner,
          decode(credential.publicKey).buffer,
          credential.backedUp ? 0 : credential.signCount,
          Number(credential.backedUp),
          JSON.stringify(credential.transports),
          Date.parse(credential.createdAt),
        ),
      );
    for (const code of snapshot.recoveryCodes)
      statements.push(
        q(
          this.env.DB,
          'INSERT INTO recovery_codes(owner_id,code_hash,used_at,created_at) VALUES (?,?,?,?)',
          owner,
          code.codeHash,
          code.usedAt ? Date.parse(code.usedAt) : null,
          Date.parse(code.createdAt),
        ),
      );
    statements.push(
      q(
        this.env.DB,
        `UPDATE accounts SET status='active',auth_epoch=?,recovery_handle_hash=?,recovery_ack_at=?,write_fence=NULL,data_revision=data_revision+1,updated_at=${DB_NOW} WHERE id=?`,
        snapshot.epoch,
        snapshot.recoveryHandleHash,
        snapshot.recoveryAcknowledgedAt ? Date.parse(snapshot.recoveryAcknowledgedAt) : null,
        owner,
      ),
    );
    await this.env.DB.batch(statements);
  }
  private async resetRuntime() {
    const owners = (await q(this.env.DB, 'SELECT id FROM accounts').all<{ id: string }>()).results;
    for (const { id } of owners)
      await this.env.DB.batch([
        ...this.base.stopStatements(id),
        q(
          this.env.DB,
          `INSERT INTO permission_revisions SELECT ?,coalesce(max(revision),0)+1,0,'egress.v1',${DB_NOW} FROM permission_revisions WHERE owner_id=?`,
          id,
          id,
        ),
        q(
          this.env.DB,
          'UPDATE accounts SET permission_revision=(SELECT max(revision) FROM permission_revisions WHERE owner_id=?),data_revision=data_revision+1 WHERE id=?',
          id,
          id,
        ),
      ]);
    await this.env.DB.batch([
      q(this.env.DB, 'DELETE FROM auth_sessions'),
      q(this.env.DB, 'DELETE FROM auth_challenges'),
      q(this.env.DB, 'DELETE FROM export_tickets'),
      q(this.env.DB, 'DELETE FROM idempotency_keys'),
      q(
        this.env.DB,
        `UPDATE context_grants SET state='revoked',revision=revision+1,updated_at=${DB_NOW} WHERE state='allowed'`,
      ),
      q(
        this.env.DB,
        "UPDATE generation_requests SET error_code='DEPENDENCY_UNAVAILABLE' WHERE state='blocked'",
      ),
      q(
        this.env.DB,
        "UPDATE generation_attempts SET outcome='blocked',finished_at=coalesce(finished_at," +
          DB_NOW +
          ') WHERE finished_at IS NULL',
      ),
      q(this.env.DB, "UPDATE cost_reservations SET state='unknown' WHERE state='reserved'"),
      q(this.env.DB, 'UPDATE spend_buckets SET committed_microusd=ceiling_microusd'),
    ]);
  }
  private async checkContent() {
    // Exact localhost fixture editions only; this is not a production approval list.
    let fixtures: string[];
    if (this.options.validateContent) {
      fixtures = [];
      const entries = await q(
        this.env.DB,
        "SELECT hash FROM content_editions WHERE state!='withdrawn'",
      ).all<{ hash: string }>();
      for (const entry of entries.results)
        if (await this.options.validateContent(entry.hash)) fixtures.push(entry.hash);
    } else fixtures = [(await syntheticBundle()).editionHash, localDevelopmentBundle().editionHash];
    // An empty verified set withdraws everything, without interpolating any identity.
    if (!fixtures.length) fixtures = ['0'.repeat(64)];
    await this.env.DB.batch([
      q(
        this.env.DB,
        `UPDATE content_editions SET state='withdrawn',withdrawn_at=coalesce(withdrawn_at,${DB_NOW}) WHERE hash NOT IN (${fixtures.map(() => '?').join(',')}) AND state!='withdrawn'`,
        ...fixtures,
      ),
      q(
        this.env.DB,
        `UPDATE reading_editions SET status='withdrawn',body_enc=NULL,invalidated_at=coalesce(invalidated_at,${DB_NOW}) WHERE status!='deleted' AND content_hash IN (SELECT hash FROM content_editions WHERE state='withdrawn')`,
      ),
    ]);
  }
  private async validateBodies() {
    for (const field of ACCOUNT_FIELD_HANDLERS) {
      for (let offset = 0; ; offset += 100) {
        const rows = (
          await q(
            this.env.DB,
            `SELECT * FROM ${field.table} WHERE ${field.column} IS NOT NULL ORDER BY owner_id,${field.keyColumns.join(',')} LIMIT 100 OFFSET ?`,
            offset,
          ).all<Record<string, unknown>>()
        ).results;
        for (const row of rows) {
          const body = row[field.column];
          if (typeof body !== 'string') throw new Error('Encrypted field unavailable');
          await this.base.crypt.open(field.identity(row, body), body, z.unknown());
        }
        if (rows.length < 100) break;
      }
    }
  }
}
