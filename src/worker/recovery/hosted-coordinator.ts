import { AsyncLocalStorage } from 'node:async_hooks';
import { bytesDigest } from './digest.ts';
import { timingSafeEqual } from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { canonicalJson } from '../../domain/json.ts';
import { decode } from '../identity/crypto.ts';

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
  QUIESCENCE_TRUST?: string;
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
const QuiescenceDocument = z.strictObject({
  version: z.literal(1),
  producer: z.literal('platform-quiescence.v1'),
  status: z.literal('quiescent'),
  environmentId: environmentName,
  operationId: z.uuid(),
  epoch: z.number().int().positive(),
  registrationDigest: hash,
  ingress: z.literal('blocked'),
  egress: z.literal('blocked'),
  terminationEvidenceDigest: hash,
  sourceDigest: hash,
  configurationDigest: hash,
  observedAt: z.iso.datetime(),
});
const QuiescenceTrust = z.strictObject({
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[\w-]{43}$/),
  ext: z.boolean().optional(),
  key_ops: z.array(z.literal('verify')).max(1).optional(),
});
export { bytesDigest } from './digest.ts';

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
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS quiescence_reconciliations(epoch INTEGER PRIMARY KEY,evidence_hash TEXT NOT NULL,registrations INTEGER NOT NULL,completed_at INTEGER NOT NULL)',
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
  #registrations() {
    const rows = this.ctx.storage.sql
      .exec<{ id: string; operation_id: string | null }>(
        'SELECT id,operation_id FROM writers ORDER BY id LIMIT 10001',
      )
      .toArray();
    if (rows.length > 10000) throw new Error('Registration inspection bound exceeded');
    return rows.map((r) => ({ id: r.id, operationId: r.operation_id }));
  }
  async inspectRegistrations(secret: string, environment: string) {
    await this.#authenticate(secret, environment);
    const row = this.#row(),
      writers = this.#registrations();
    const snapshot = {
      environmentId: environment,
      epoch: row.epoch,
      operationId: row.operation_id,
      purpose: row.purpose,
      mode: row.mode,
      writers,
    };
    return {
      ...snapshot,
      registrationDigest: await bytesDigest(new TextEncoder().encode(canonicalJson(snapshot))),
    };
  }
  /** No expiry shortcut. A separately trusted platform verifier must attest actual termination. */
  async reconcileRegistrations(
    secret: string,
    environment: string,
    evidenceHash: string,
  ): Promise<OfflineContext> {
    await this.#authenticate(secret, environment);
    hash.parse(evidenceHash);
    if (!this.env.QUIESCENCE_TRUST || !this.env.BACKUP_INVENTORY)
      throw new Error('Independent quiescence proof required');
    const object = await this.env.BACKUP_INVENTORY.get('quiescence/' + evidenceHash + '.json');
    if (!object || object.size > 65536) throw new Error('Independent quiescence proof required');
    const bytes = await object.arrayBuffer();
    if ((await bytesDigest(bytes)) !== evidenceHash)
      throw new Error('Quiescence proof bytes mismatch');
    const envelope = z
      .strictObject({ document: QuiescenceDocument, signature: z.string().regex(/^[\w-]{86}$/) })
      .parse(JSON.parse(new TextDecoder().decode(bytes)));
    const trust = QuiescenceTrust.parse(JSON.parse(this.env.QUIESCENCE_TRUST));
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: trust.kty, crv: trust.crv, x: trust.x },
      'Ed25519',
      false,
      ['verify'],
    );
    if (
      !(await crypto.subtle.verify(
        'Ed25519',
        key,
        decode(envelope.signature),
        new TextEncoder().encode(canonicalJson(envelope.document)),
      ))
    )
      throw new Error('Independent quiescence signature required');
    const proof = envelope.document,
      snapshot = await this.inspectRegistrations(secret, environment);
    if (
      snapshot.mode === 'online' ||
      !snapshot.writers.length ||
      proof.environmentId !== environment ||
      proof.epoch !== snapshot.epoch ||
      proof.operationId !== snapshot.operationId ||
      proof.registrationDigest !== snapshot.registrationDigest ||
      Date.parse(proof.observedAt) > Date.now() + 60000 ||
      Date.now() - Date.parse(proof.observedAt) > 900000
    )
      throw new Error('Stale or incomplete quiescence proof');
    // The proof's platform exclusion precedes these writes. Clearing registrations
    // never opens traffic and never restores generation/financial capacity.
    await this.env.DB.batch([
      this.env.DB.prepare(
        'INSERT INTO assertion_probe(ok) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM system_state WHERE id=1)',
      ),
      this.env.DB.prepare(
        "UPDATE system_state SET restore_in_progress=1,generation_enabled=0,dispatch_mode='off',revision=revision+1 WHERE id=1",
      ),
    ]);
    return this.ctx.storage.transactionSync(() => {
      const row = this.#row();
      if (
        row.epoch !== snapshot.epoch ||
        row.operation_id !== snapshot.operationId ||
        row.mode !== snapshot.mode ||
        canonicalJson(this.#registrations()) !== canonicalJson(snapshot.writers)
      )
        throw new Error('Registration snapshot changed');
      const epoch = row.epoch + 1,
        operationId = crypto.randomUUID(),
        purpose = purposeSchema.parse(row.purpose);
      if (!Number.isSafeInteger(epoch)) throw new Error('Recovery epoch exhausted');
      this.ctx.storage.sql.exec(
        'INSERT INTO quiescence_reconciliations VALUES(?,?,?,?)',
        epoch,
        evidenceHash,
        snapshot.writers.length,
        Date.now(),
      );
      this.ctx.storage.sql.exec('DELETE FROM writers');
      this.ctx.storage.sql.exec(
        "UPDATE control SET epoch=?,mode='offline',operation_id=?,expires_at=?,evidence_hash=NULL",
        epoch,
        operationId,
        Date.now() + 900000,
      );
      return { environmentId: environment, operationId, epoch, purpose };
    });
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
        (row.mode !== 'online' && row.expires_at > Date.now() && row.evidence_hash === null) ||
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
      if (this.#row().evidence_hash !== null) throw new Error('Offline operation is complete');
      if (this.#count()) throw new Error('Offline mutation already running');
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
    const registrationId = 'resume-' + crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.#current(context);
      if (this.#count() || this.#row().evidence_hash !== evidenceHash)
        throw new Error('Exclusive validated resume required');
      this.ctx.storage.sql.exec(
        'INSERT INTO writers VALUES(?,?)',
        registrationId,
        context.operationId,
      );
    });
    try {
      await this.#resume(context, evidenceHash, secret, registrationId);
    } finally {
      await this.finishOffline(secret, context, registrationId);
    }
  }
  async #resume(
    context: OfflineContext,
    evidenceHash: string,
    secret: string,
    registrationId: string,
  ) {
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
    if (this.#count() !== 1) throw new Error('Exclusive resume registration required');
    if (
      !(await this.env.DB.prepare(
        "SELECT 1 FROM system_state WHERE id=1 AND restore_in_progress=1 AND generation_enabled=0 AND dispatch_mode='off'",
      ).first())
    )
      throw new Error('Recovery validation required');
    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT INTO assertion_probe(ok) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM hosted_coordination WHERE environment_id=? AND epoch=? AND state='validated' AND evidence_hash=?)",
      ).bind(context.environmentId, context.epoch, evidenceHash),
      this.env.DB.prepare(
        "INSERT INTO assertion_probe(ok) SELECT 0 WHERE NOT EXISTS(SELECT 1 FROM system_state WHERE id=1 AND restore_in_progress=1 AND generation_enabled=0 AND dispatch_mode='off')",
      ),
      this.env.DB.prepare(
        "UPDATE system_state SET restore_in_progress=0,generation_enabled=0,dispatch_mode='off' WHERE id=1",
      ),
      this.env.DB.prepare(
        "UPDATE hosted_coordination SET state='online' WHERE environment_id=? AND epoch=? AND state='validated'",
      ).bind(context.environmentId, context.epoch),
    ]);
    this.ctx.storage.transactionSync(() => {
      this.#current(context);
      if (
        this.#count() !== 1 ||
        !this.ctx.storage.sql
          .exec(
            'SELECT 1 FROM writers WHERE id=? AND operation_id=?',
            registrationId,
            context.operationId,
          )
          .toArray().length
      )
        throw new Error('Exclusive resume registration required');
      this.ctx.storage.sql.exec(
        "UPDATE control SET mode='online',operation_id=NULL,purpose=NULL,expires_at=0",
      );
      this.ctx.storage.sql.exec(
        'DELETE FROM writers WHERE id=? AND operation_id=?',
        registrationId,
        context.operationId,
      );
    });
  }
}

const offlineInvocation = new AsyncLocalStorage<OfflineContext>();
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
    const value = await this.stub().acquire(this.secret, this.environmentId, purpose);
    return {
      environmentId: value.environmentId,
      operationId: value.operationId,
      epoch: value.epoch,
      purpose: value.purpose,
    };
  }
  async assertCurrent(context: OfflineContext) {
    this.check(context);
    await this.stub().assertCurrent(this.secret, context);
  }
  async inspectRegistrations() {
    const snapshot = await this.stub().inspectRegistrations(this.secret, this.environmentId);
    return {
      environmentId: snapshot.environmentId,
      epoch: snapshot.epoch,
      operationId: snapshot.operationId,
      purpose: snapshot.purpose,
      mode: snapshot.mode,
      writers: snapshot.writers.map((w) => ({ id: w.id, operationId: w.operationId })),
      registrationDigest: snapshot.registrationDigest,
    };
  }
  async reconcileRegistrations(evidenceHash: string): Promise<OfflineContext> {
    const context = await this.stub().reconcileRegistrations(
      this.secret,
      this.environmentId,
      evidenceHash,
    );
    return {
      environmentId: context.environmentId,
      operationId: context.operationId,
      epoch: context.epoch,
      purpose: context.purpose,
    };
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
    const active = offlineInvocation.getStore();
    if (
      active &&
      active.environmentId === context.environmentId &&
      active.operationId === context.operationId &&
      active.epoch === context.epoch
    ) {
      await this.assertCurrent(context);
      return work();
    }
    const id = crypto.randomUUID();
    await this.stub().beginOffline(this.secret, context, id);
    try {
      const value = await offlineInvocation.run(context, work);
      await this.assertCurrent(context);
      return value;
    } finally {
      await this.stub().finishOffline(this.secret, context, id);
    }
  }
}
