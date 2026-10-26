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
import { RecordBase } from '../readings/base.ts';
import { SessionErasure } from '../readings/erasure.ts';
import { syntheticBundle } from '../readings/local-content.ts';
import { objects, type Chain } from './ledger.ts';

const active = new WeakSet<D1Database>();
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
/** Local operator service only. No HTTP route imports this module. One offline runner owns D1/R2. */
export class OfflineRestore {
  readonly base: RecordBase;
  readonly erasure: SessionErasure;
  readonly now: () => number;
  constructor(
    readonly env: Env,
    options: { retainedKeys?: IdentitySecrets[]; now?: () => number } = {},
  ) {
    const identity = localIdentity(env);
    if (
      env.RESTORE_MODE !== 'offline' ||
      env.READING_MODE !== 'synthetic-local' ||
      !identity ||
      identity.crypt.secrets.environment !== 'synthetic-local'
    )
      throw new Error('Restore requires explicit synthetic offline bindings');
    this.base = new RecordBase(env.DB, identity);
    this.erasure = new SessionErasure(
      this.base,
      env.RECOVERY!,
      options.retainedKeys?.map((k) => new IdentityCrypto(k)),
    );
    this.now = options.now ?? Date.now;
  }
  private async fence() {
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
  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    if (active.has(this.env.DB)) throw new Error('An offline restore operation is already running');
    active.add(this.env.DB);
    try {
      return await work();
    } finally {
      active.delete(this.env.DB);
    }
  }
  /** Flush accessible operations before taking the database back to an older bookmark. */
  async prepare() {
    return this.exclusive(async () => {
      await this.fence();
      for (;;) {
        const pending = await q(
          this.env.DB,
          "SELECT id FROM security_operations WHERE state!='applied' ORDER BY created_at LIMIT 100",
        ).all<{ id: string }>();
        if (!pending.results.length) break;
        for (const row of pending.results) await this.base.identity.checkpoints.apply(row.id);
      }
      for (;;) {
        const pending = await q(
          this.env.DB,
          "SELECT id FROM deletion_jobs WHERE state!='complete' ORDER BY created_at LIMIT 100",
        ).all<{ id: string }>();
        if (!pending.results.length) break;
        for (const row of pending.results) await this.erasure.resume(row.id);
      }
      return { status: 'offline' as const };
    });
  }
  async replay() {
    return this.exclusive(async () => {
      await this.fence();
      const inventory = await this.inventory();
      const jobs = [
        ...new Set(
          inventory.erasures.map((item) => {
            const match = new RegExp(
              `^erasures/v1/(${uuid})/(intent\\.json|passes/[1-9][0-9]*/(start|complete)\\.json)$`,
            ).exec(item.key);
            if (!match) throw new Error('Unexpected erasure object');
            return match[1]!;
          }),
        ),
      ];
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
        const keys = (
          await q(
            this.env.DB,
            'SELECT version,wrapped_key_enc,wrapped_index_key_enc FROM account_keys WHERE owner_id=?',
            account.id,
          ).all<{ version: number; wrapped_key_enc: string; wrapped_index_key_enc: string }>()
        ).results;
        if (!keys.some((k) => k.version === account.key_version))
          throw new Error('Missing account data key');
        for (const key of keys) {
          if (key.version !== 1) throw new Error('Unsupported account key version');
          await this.base.identity.crypt.unwrapAccountKey(account.id, key.wrapped_key_enc, 'data');
          await this.base.identity.crypt.unwrapAccountKey(
            account.id,
            key.wrapped_index_key_enc,
            'index',
          );
        }
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
      // Only the local runner can now remove its explicit offline binding. Dispatch stays off.
      await q(this.env.DB, 'UPDATE system_state SET restore_in_progress=0 WHERE id=1').run();
      return {
        status: 'verified' as const,
        scope: 'synthetic-local-only' as const,
        erasureJobs: chains.length,
        identityCheckpoints: checkpoints.size,
        generationEnabled: false as const,
        inventorySha256: await sha256Json(inventory),
      };
    });
  }
  private async inventory() {
    const normalize = (items: R2Object[]) =>
      items
        .map((i) => ({ key: i.key, etag: i.etag, size: i.size }))
        .sort((a, b) => a.key.localeCompare(b.key));
    return {
      erasures: normalize(await objects(this.env.RECOVERY!, 'erasures/')),
      identity: normalize(await objects(this.env.RECOVERY!, 'identity/')),
    };
  }
  private async checkpoints(
    entries: Array<{ key: string; etag: string; size: number }>,
    owners: string[],
    erased: Set<string>,
  ) {
    const result = new Map<string, Checkpoint>();
    const byPrefix = new Map<string, { owner: string; crypt: IdentityCrypto }>();
    for (const owner of new Set([...owners, ...erased]))
      for (const crypt of this.erasure.ledger.keys.values())
        byPrefix.set(await crypt.hash('identity-subject', owner), { owner, crypt });
    const epochs = new Set<string>();
    for (const entry of entries) {
      const match = new RegExp(`^identity/v1/([a-f0-9]{64})/([1-9][0-9]*)-(${uuid})\\.enc$`).exec(
        entry.key,
      );
      if (!match || entry.size > 91_000) throw new Error('Invalid identity inventory');
      const expected = byPrefix.get(match[1]!);
      if (!expected) throw new Error('Checkpoint account/key missing from restored inventory');
      if (erased.has(expected.owner)) continue;
      const object = await this.env.RECOVERY!.get(entry.key);
      if (!object || object.etag !== entry.etag) throw new Error('Identity checkpoint unavailable');
      const raw = await object.text();
      const snapshot = IdentityCheckpoint.parse(
        await expected.crypt.openCheckpoint(expected.owner, Number(match[2]), match[3]!, raw),
      );
      const epoch = `${snapshot.subjectId}:${snapshot.epoch}`;
      if (epochs.has(epoch)) throw new Error('Ambiguous identity checkpoint epoch');
      epochs.add(epoch);
      if ((await expected.crypt.checkpointKey(snapshot)) !== entry.key)
        throw new Error('Checkpoint identity mismatch');
      if (!result.has(snapshot.subjectId) || result.get(snapshot.subjectId)!.epoch < snapshot.epoch)
        result.set(snapshot.subjectId, snapshot);
    }
    return result;
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
    const approved = (await syntheticBundle()).editionHash;
    await this.env.DB.batch([
      q(
        this.env.DB,
        `UPDATE content_editions SET state='withdrawn',withdrawn_at=coalesce(withdrawn_at,${DB_NOW}) WHERE hash!=? AND state!='withdrawn'`,
        approved,
      ),
      q(
        this.env.DB,
        `UPDATE reading_editions SET status='withdrawn',body_enc=NULL,invalidated_at=coalesce(invalidated_at,${DB_NOW}) WHERE status!='deleted' AND content_hash IN (SELECT hash FROM content_editions WHERE state='withdrawn')`,
      ),
    ]);
  }
  private async validateBodies() {
    for (const table of [
      'import_batches',
      'import_items',
      'import_identities',
      'generation_context',
      'revisits',
    ])
      if (await q(this.env.DB, `SELECT 1 FROM ${table} LIMIT 1`).first())
        throw new Error('Unsupported restored record family');
    const families: Array<{
      table: string;
      columns: string[];
      id: string;
      revision: string;
      version: string;
    }> = [
      {
        table: 'reading_sessions',
        columns: ['question_enc'],
        id: 'id',
        revision: '1',
        version: '1',
      },
      {
        table: 'basis_snapshots',
        columns: ['body_enc'],
        id: 'id',
        revision: '1',
        version: 'key_version',
      },
      {
        table: 'reading_editions',
        columns: ['body_enc'],
        id: 'id',
        revision: '1',
        version: 'key_version',
      },
      {
        table: 'reflection_revisions',
        columns: ['body_enc'],
        id: "reflection_id||':'||revision",
        revision: 'revision',
        version: 'key_version',
      },
      {
        table: 'generation_requests',
        columns: ['input_enc', 'plan_enc'],
        id: 'id',
        revision: '1',
        version: 'key_version',
      },
      {
        table: 'provider_dispatches',
        columns: ['transmission_enc', 'candidate_enc', 'provider_response_id_enc'],
        id: 'id',
        revision: '1',
        version: 'key_version',
      },
    ];
    for (const family of families)
      for (const column of family.columns)
        for (let offset = 0; ; offset += 100) {
          const rows = (
            await q(
              this.env.DB,
              `SELECT owner_id,${family.id} AS record_id,${family.revision} AS revision,${family.version} AS version,${column} AS body FROM ${family.table} WHERE ${column} IS NOT NULL ORDER BY owner_id,record_id LIMIT 100 OFFSET ?`,
              offset,
            ).all<{
              owner_id: string;
              record_id: string;
              revision: number;
              version: number;
              body: string;
            }>()
          ).results;
          for (const row of rows)
            await this.base.crypt.open(
              row.owner_id,
              family.table,
              column,
              row.record_id,
              row.body,
              z.unknown(),
              row.revision,
              row.version,
            );
          if (rows.length < 100) break;
        }
  }
}
