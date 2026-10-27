import { timingSafeEqual } from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

export type OfflinePurpose = 'restore' | 'cleanup' | 'rekey' | 'retirement';
export interface OfflineContext {
  environmentId: string;
  operationId: string;
  epoch: number;
  purpose: OfflinePurpose;
}
export interface OfflineCoordinator {
  acquire(purpose: OfflinePurpose, environmentId?: string): Promise<OfflineContext>;
  assertCurrent(context: OfflineContext): Promise<void>;
  complete(context: OfflineContext, evidenceHash: string): Promise<void>;
}
interface ControlBindings {
  OFFLINE_COORDINATOR: DurableObjectNamespace<OfflineControl>;
  RECOVERY_CONTROL_SECRET?: string;
  BACKUP_INVENTORY?: R2Bucket;
  DB: D1Database;
}
type ControlRow = {
  epoch: number;
  mode: string;
  operation_id: string | null;
  purpose: OfflinePurpose | null;
  expires_at: number;
  evidence_hash: string | null;
};
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const environmentName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/);
const purposeSchema = z.enum(['restore', 'cleanup', 'rekey', 'retirement']);
export const RecoveryValidation = z.strictObject({
  version: z.literal(1),
  producer: z.literal('restore-validator.v1'),
  status: z.literal('passed'),
  environmentId: environmentName,
  operationId: z.uuid(),
  epoch: z.number().int().nonnegative(),
  sourceDigest: hash,
  configurationDigest: hash,
  backupInventoryDigest: hash,
  recoveryValidationDigest: hash,
  financialReconciliationDigest: hash,
  validatedAt: z.iso.datetime(),
  generation: z.literal('off'),
});
export async function bytesDigest(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
}

/** Persistent authority outside D1 rollback. Only server binding RPC can reach this class. */
export class OfflineControl extends DurableObject<ControlBindings> {
  constructor(ctx: DurableObjectState, env: ControlBindings) {
    super(ctx, env);
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1),epoch INTEGER NOT NULL,mode TEXT NOT NULL,operation_id TEXT,purpose TEXT,expires_at INTEGER NOT NULL,evidence_hash TEXT)',
    );
    ctx.storage.sql.exec("INSERT OR IGNORE INTO control VALUES(1,0,'online',NULL,NULL,0,NULL)");
    // No heartbeat/TTL: a crashed writer stays registered until independently reconciled.
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS writers(id TEXT PRIMARY KEY,operation_id TEXT)',
    );
  }
  async #authenticate(secret: string, environment: string) {
    environmentName.parse(environment);
    if (
      !this.env.RECOVERY_CONTROL_SECRET ||
      !this.ctx.id.equals(this.env.OFFLINE_COORDINATOR.idFromName(environment))
    )
      throw new Error('Offline control unavailable');
    const [a, b] = await Promise.all(
      [secret, this.env.RECOVERY_CONTROL_SECRET].map((s) =>
        crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)),
      ),
    );
    if (!timingSafeEqual(new Uint8Array(a!), new Uint8Array(b!)))
      throw new Error('Offline control unavailable');
  }
  #row() {
    return this.ctx.storage.sql.exec<ControlRow>('SELECT * FROM control WHERE id=1').one();
  }
  #count() {
    return this.ctx.storage.sql.exec<{ n: number }>('SELECT count(*) n FROM writers').one().n;
  }
  #current(context: OfflineContext) {
    const row = this.#row();
    if (
      row.mode !== 'offline' ||
      row.operation_id !== context.operationId ||
      row.epoch !== context.epoch ||
      row.purpose !== context.purpose ||
      row.expires_at <= Date.now()
    )
      throw new Error('Offline lease unavailable');
    return row;
  }
  async registerWriter(secret: string, environment: string, id: string) {
    await this.#authenticate(secret, environment);
    if (!/^[\w-]{1,100}$/.test(id)) throw new Error('Writer identity required');
    return this.ctx.storage.transactionSync(() => {
      if (this.#row().mode !== 'online') throw new Error('Environment is offline');
      this.ctx.storage.sql.exec('INSERT INTO writers(id,operation_id) VALUES(?,NULL)', id);
      return this.#row().epoch;
    });
  }
  async finishWriter(secret: string, environment: string, id: string) {
    await this.#authenticate(secret, environment);
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec('DELETE FROM writers WHERE id=? AND operation_id IS NULL', id);
      if (this.#row().mode === 'closing' && this.#count() === 0)
        this.ctx.storage.sql.exec("UPDATE control SET mode='offline'");
    });
  }
  async acquire(
    secret: string,
    environment: string,
    purpose: OfflinePurpose,
  ): Promise<OfflineContext> {
    await this.#authenticate(secret, environment);
    purposeSchema.parse(purpose);
    return this.ctx.storage.transactionSync(() => {
      const row = this.#row();
      // An expired lease can be replaced only when no invocation can still be writing.
      if (
        (row.mode !== 'online' && row.expires_at > Date.now()) ||
        (row.mode !== 'online' && this.#count() > 0)
      )
        throw new Error('Offline operation already active');
      const epoch = row.epoch + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error('Recovery epoch exhausted');
      const operationId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        'UPDATE control SET epoch=?,mode=?,operation_id=?,purpose=?,expires_at=?,evidence_hash=NULL',
        epoch,
        this.#count() ? 'closing' : 'offline',
        operationId,
        purpose,
        Date.now() + 15 * 60_000,
      );
      return { environmentId: environment, operationId, epoch, purpose };
    });
  }
  async assertCurrent(secret: string, context: OfflineContext) {
    await this.#authenticate(secret, context.environmentId);
    this.#current(context);
    if (
      this.ctx.storage.sql
        .exec<{ n: number }>('SELECT count(*) n FROM writers WHERE operation_id IS NULL')
        .one().n
    )
      throw new Error('Writers not drained');
  }
  async beginOffline(secret: string, context: OfflineContext, id: string) {
    await this.assertCurrent(secret, context);
    this.ctx.storage.transactionSync(() => {
      this.#current(context);
      this.ctx.storage.sql.exec('INSERT INTO writers VALUES(?,?)', id, context.operationId);
    });
  }
  async finishOffline(secret: string, context: OfflineContext, id: string) {
    await this.#authenticate(secret, context.environmentId);
    this.ctx.storage.sql.exec(
      'DELETE FROM writers WHERE id=? AND operation_id=?',
      id,
      context.operationId,
    );
  }
  async complete(secret: string, context: OfflineContext, evidenceHash: string) {
    await this.assertCurrent(secret, context);
    hash.parse(evidenceHash);
    this.ctx.storage.transactionSync(() => {
      this.#current(context);
      if (this.#count()) throw new Error('Offline mutation still running');
      this.ctx.storage.sql.exec('UPDATE control SET evidence_hash=?', evidenceHash);
    });
  }
  async resume(secret: string, context: OfflineContext, evidenceHash: string) {
    await this.assertCurrent(secret, context);
    hash.parse(evidenceHash);
    if (this.#row().evidence_hash !== evidenceHash || !this.env.BACKUP_INVENTORY)
      throw new Error('Recovery validation required');
    const object = await this.env.BACKUP_INVENTORY.get(
      'recovery-validation/' + evidenceHash + '.json',
    );
    if (!object || object.size > 65536) throw new Error('Recovery validation required');
    const bytes = await object.arrayBuffer();
    if ((await bytesDigest(bytes)) !== evidenceHash)
      throw new Error('Recovery validation required');
    const evidence = RecoveryValidation.parse(JSON.parse(new TextDecoder().decode(bytes)));
    if (
      evidence.environmentId !== context.environmentId ||
      evidence.operationId !== context.operationId ||
      evidence.epoch !== context.epoch ||
      Date.parse(evidence.validatedAt) > Date.now() + 60_000 ||
      Date.now() - Date.parse(evidence.validatedAt) > 15 * 60_000
    )
      throw new Error('Recovery validation required');
    await this.assertCurrent(secret, context);
    // D1 can be rolled back, so this assertion is subordinate to the independent epoch.
    const db = await this.env.DB.prepare(
      'SELECT epoch,state,evidence_hash FROM hosted_coordination WHERE environment_id=?',
    )
      .bind(context.environmentId)
      .first<{ epoch: number; state: string; evidence_hash: string | null }>();
    if (
      !db ||
      db.epoch !== context.epoch ||
      db.state !== 'validated' ||
      db.evidence_hash !== evidenceHash
    )
      throw new Error('Recovery validation required');
    if (this.#count()) throw new Error('Offline mutation still running');
    if (
      !(await this.env.DB.prepare(
        "SELECT 1 FROM system_state WHERE id=1 AND restore_in_progress=1 AND generation_enabled=0 AND dispatch_mode='off'",
      ).first())
    )
      throw new Error('Recovery validation required');
    await this.env.DB.batch([
      this.env.DB.prepare(
        "UPDATE system_state SET restore_in_progress=0,generation_enabled=0,dispatch_mode='off' WHERE id=1",
      ),
      this.env.DB.prepare(
        "UPDATE hosted_coordination SET state='online' WHERE environment_id=? AND epoch=? AND state='validated'",
      ).bind(context.environmentId, context.epoch),
    ]);
    this.ctx.storage.transactionSync(() => {
      this.#current(context);
      if (this.#count()) throw new Error('Offline mutation still running');
      this.ctx.storage.sql.exec(
        "UPDATE control SET mode='online',operation_id=NULL,purpose=NULL,expires_at=0",
      );
    });
  }
}

export class HostedCoordinator implements OfflineCoordinator {
  constructor(
    readonly namespace: DurableObjectNamespace<OfflineControl>,
    private readonly secret: string,
    readonly environmentId: string,
  ) {}
  private stub() {
    return this.namespace.getByName(this.environmentId);
  }
  private check(context: OfflineContext) {
    if (context.environmentId !== this.environmentId) throw new Error('Wrong recovery environment');
  }
  async acquire(purpose: OfflinePurpose, environmentId = this.environmentId) {
    if (environmentId !== this.environmentId)
      return Promise.reject(new Error('Wrong recovery environment'));
    return await this.stub().acquire(this.secret, this.environmentId, purpose);
  }
  async assertCurrent(context: OfflineContext) {
    this.check(context);
    await this.stub().assertCurrent(this.secret, context);
  }
  async complete(context: OfflineContext, evidenceHash: string) {
    this.check(context);
    await this.stub().complete(this.secret, context, evidenceHash);
  }
  async resume(context: OfflineContext, evidenceHash: string) {
    this.check(context);
    await this.stub().resume(this.secret, context, evidenceHash);
  }
  async withWriter<T>(work: () => Promise<T>): Promise<T> {
    const id = crypto.randomUUID();
    await this.stub().registerWriter(this.secret, this.environmentId, id);
    try {
      return await work();
    } finally {
      await this.stub().finishWriter(this.secret, this.environmentId, id);
    }
  }
  async withOffline<T>(context: OfflineContext, work: () => Promise<T>): Promise<T> {
    this.check(context);
    const id = crypto.randomUUID();
    await this.stub().beginOffline(this.secret, context, id);
    try {
      const value = await work();
      await this.assertCurrent(context);
      return value;
    } finally {
      await this.stub().finishOffline(this.secret, context, id);
    }
  }
}
