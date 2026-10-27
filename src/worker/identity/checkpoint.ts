import { recoveryWrite, type RecoveryLease } from '../recovery/coordination.ts';
import { IdentityCheckpoint } from '../../contracts/index.ts';
import { type Checkpoint, decode, type IdentityCrypto, type WrappedKeys } from './crypto.ts';

export const DB_NOW = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";
export const statement = (
  db: D1Database,
  query: string,
  ...values: (string | number | null | ArrayBuffer)[]
) => db.prepare(query).bind(...values);
export const assertion = (
  db: D1Database,
  condition: string,
  ...values: (string | number | null)[]
) => statement(db, `INSERT INTO assertion_probe(ok) SELECT 0 WHERE NOT (${condition})`, ...values);
/** Every ordinary mutation must recheck the persistent operator fence at execution. */
export const onlineGuard = (db: D1Database) =>
  assertion(db, 'NOT EXISTS(SELECT 1 FROM system_state WHERE restore_in_progress=1)');
interface Operation {
  id: string;
  owner_id: string;
  epoch: number;
  state: string;
  snapshot_enc: string;
  ledger_key: string;
  created_at: number;
  next_run_at: number;
}
export class IdentityCheckpoints {
  constructor(
    private db: D1Database,
    private bucket: R2Bucket,
    private crypt: IdentityCrypto,
  ) {}
  async commit(
    input: Checkpoint,
    options: { initialKeys?: WrappedKeys; expected?: Checkpoint; guards?: D1PreparedStatement[] },
  ): Promise<void> {
    return recoveryWrite(this.crypt.secrets.environment, () =>
      this.commitOperation(input, options),
    );
  }
  private async commitOperation(
    input: Checkpoint,
    options: { initialKeys?: WrappedKeys; expected?: Checkpoint; guards?: D1PreparedStatement[] },
  ): Promise<void> {
    const snapshot = IdentityCheckpoint.parse(input);
    const encrypted = await this.crypt.sealCheckpoint(snapshot);
    const key = await this.crypt.checkpointKey(snapshot);
    const now = Date.now(),
      fence = `security:${snapshot.operationId}`;
    const writes = [onlineGuard(this.db), ...(options.guards ?? [])];
    if (options.initialKeys) {
      if (snapshot.epoch !== 1) throw new Error('Invalid initial epoch');
      writes.push(
        statement(
          this.db,
          'INSERT INTO accounts(id,write_fence,recovery_handle_hash,created_at,updated_at) VALUES (?,?,?,?,?)',
          snapshot.subjectId,
          fence,
          snapshot.recoveryHandleHash,
          now,
          now,
        ),
      );
      const keys = options.initialKeys;
      writes.push(
        statement(
          this.db,
          'INSERT INTO account_keys(owner_id,version,wrap_key_id,wrapped_key_enc,wrapped_index_key_enc,created_at) VALUES (?,1,?,?,?,?)',
          snapshot.subjectId,
          keys.wrapKeyId,
          keys.wrappedKey,
          keys.wrappedIndexKey,
          now,
        ),
      );
      writes.push(
        statement(
          this.db,
          "INSERT INTO permission_revisions(owner_id,revision,model_allowed,policy_version,created_at) VALUES (?,1,0,'egress.v1',?)",
          snapshot.subjectId,
          now,
        ),
      );
    } else {
      const expected = options.expected;
      if (
        !expected ||
        expected.subjectId !== snapshot.subjectId ||
        expected.epoch + 1 !== snapshot.epoch
      )
        throw new Error('Missing identity comparison');
      writes.push(
        assertion(
          this.db,
          "EXISTS(SELECT 1 FROM accounts WHERE id=? AND auth_epoch=? AND status='active' AND write_fence IS NULL AND recovery_handle_hash=?)",
          snapshot.subjectId,
          expected.epoch,
          expected.recoveryHandleHash,
        ),
      );
      writes.push(
        assertion(
          this.db,
          '(SELECT count(*) FROM credentials WHERE owner_id=?)=?',
          snapshot.subjectId,
          expected.credentials.length,
        ),
      );
      for (const credential of expected.credentials)
        writes.push(
          assertion(
            this.db,
            'EXISTS(SELECT 1 FROM credentials WHERE owner_id=? AND id=? AND sign_count=? AND backed_up=?)',
            snapshot.subjectId,
            credential.id,
            credential.signCount,
            Number(credential.backedUp),
          ),
        );
      writes.push(
        statement(
          this.db,
          'UPDATE accounts SET write_fence=?,revision=revision+1,updated_at=? WHERE id=?',
          fence,
          now,
          snapshot.subjectId,
        ),
      );
    }
    // Reserve newly introduced IDs in the same transaction as the account fence.
    // The global credentials PK rejects cross-account races before any R2 write;
    // write_fence keeps these provisional factors unusable until final apply.
    const existingIds = new Set(
      options.initialKeys ? [] : options.expected!.credentials.map((credential) => credential.id),
    );
    for (const credential of snapshot.credentials) {
      if (existingIds.has(credential.id)) continue;
      writes.push(
        statement(
          this.db,
          'INSERT INTO credentials(id,owner_id,public_key,sign_count,backed_up,transports_json,created_at) VALUES (?,?,?,?,?,?,?)',
          credential.id,
          snapshot.subjectId,
          decode(credential.publicKey).buffer,
          credential.signCount,
          Number(credential.backedUp),
          JSON.stringify(credential.transports),
          Date.parse(credential.createdAt),
        ),
      );
    }
    writes.push(
      statement(
        this.db,
        "INSERT INTO security_operations(id,owner_id,epoch,state,snapshot_enc,ledger_key,created_at,next_run_at) VALUES (?,?,?,'fenced',?,?,?,?)",
        snapshot.operationId,
        snapshot.subjectId,
        snapshot.epoch,
        encrypted,
        key,
        now,
        now,
      ),
    );
    await this.db.batch(writes);
    await this.apply(snapshot.operationId);
  }
  async apply(id: string, lease?: RecoveryLease): Promise<void> {
    return recoveryWrite(
      this.crypt.secrets.environment,
      () => this.applyOperation(id, lease),
      lease,
    );
  }
  private async applyOperation(id: string, lease?: RecoveryLease): Promise<void> {
    if (
      !lease &&
      (await statement(this.db, 'SELECT 1 FROM system_state WHERE restore_in_progress=1').first())
    )
      throw new Error('Recovery database is offline');
    const op = await statement(
      this.db,
      'SELECT * FROM security_operations WHERE id=?',
      id,
    ).first<Operation>();
    if (!op || op.state === 'applied') return;
    const snapshot = await this.crypt.openCheckpoint(op.owner_id, op.epoch, op.id, op.snapshot_enc);
    const crypt = this.crypt.forKey(this.crypt.envelopeKeyId(op.snapshot_enc));
    if ((await crypt.checkpointKey(snapshot)) !== op.ledger_key)
      throw new Error('Checkpoint key mismatch');
    const put = await this.bucket.put(op.ledger_key, op.snapshot_enc, {
      onlyIf: { etagDoesNotMatch: '*' },
    });
    if (!put) {
      const existing = await this.bucket.get(op.ledger_key);
      if (!existing || (await existing.text()) !== op.snapshot_enc)
        throw new Error('Immutable checkpoint mismatch');
    }
    const now = Date.now();
    const writes: D1PreparedStatement[] = [
      assertion(
        this.db,
        "EXISTS(SELECT 1 FROM accounts a JOIN security_operations s ON s.owner_id=a.id WHERE s.id=? AND s.state IN ('fenced','ledgered') AND a.status='active' AND a.write_fence=? AND a.auth_epoch IN (?,?))",
        id,
        `security:${id}`,
        op.epoch - 1,
        op.epoch,
      ),
      statement(this.db, 'DELETE FROM credentials WHERE owner_id=?', op.owner_id),
      statement(this.db, 'DELETE FROM recovery_codes WHERE owner_id=?', op.owner_id),
      statement(this.db, 'DELETE FROM auth_sessions WHERE owner_id=?', op.owner_id),
      // Only a preallocated, future-epoch restricted recovery challenge survives.
      statement(
        this.db,
        'DELETE FROM auth_challenges WHERE owner_id=? AND (auth_epoch IS NULL OR auth_epoch<>?)',
        op.owner_id,
        op.epoch,
      ),
    ];
    for (const credential of snapshot.credentials)
      writes.push(
        statement(
          this.db,
          'INSERT INTO credentials(id,owner_id,public_key,sign_count,backed_up,transports_json,created_at) VALUES (?,?,?,?,?,?,?)',
          credential.id,
          op.owner_id,
          decode(credential.publicKey).buffer,
          credential.signCount,
          Number(credential.backedUp),
          JSON.stringify(credential.transports),
          Date.parse(credential.createdAt),
        ),
      );
    for (const code of snapshot.recoveryCodes)
      writes.push(
        statement(
          this.db,
          'INSERT INTO recovery_codes(owner_id,code_hash,used_at,created_at) VALUES (?,?,?,?)',
          op.owner_id,
          code.codeHash,
          code.usedAt ? Date.parse(code.usedAt) : null,
          Date.parse(code.createdAt),
        ),
      );
    writes.push(
      statement(
        this.db,
        'UPDATE accounts SET data_revision=data_revision+1,auth_epoch=?,recovery_handle_hash=?,recovery_ack_at=?,write_fence=NULL,updated_at=? WHERE id=?',
        op.epoch,
        snapshot.recoveryHandleHash,
        snapshot.recoveryAcknowledgedAt ? Date.parse(snapshot.recoveryAcknowledgedAt) : null,
        now,
        op.owner_id,
      ),
    );
    writes.push(
      statement(
        this.db,
        "UPDATE security_operations SET state='applied',applied_at=? WHERE id=?",
        now,
        id,
      ),
    );
    try {
      await this.db.batch(writes);
    } catch (error) {
      const state = await statement(
        this.db,
        'SELECT state FROM security_operations WHERE id=?',
        id,
      ).first<string>('state');
      if (state !== 'applied') throw error;
    }
  }
  async resumePending(deadlineMs = Infinity): Promise<void> {
    const pending = await this.db
      .prepare(
        `SELECT id,created_at FROM security_operations WHERE state<>'applied' AND next_run_at<=${DB_NOW} ORDER BY next_run_at LIMIT 20`,
      )
      .all<{ id: string; created_at: number }>();
    for (const operation of pending.results) {
      if (Date.now() >= deadlineMs) break;
      try {
        await this.apply(operation.id);
      } catch {
        const age = Math.max(0, Date.now() - operation.created_at);
        const delay = Math.min(30, 2 ** Math.floor(Math.log2(age / 60_000 + 1))) * 60_000;
        await statement(
          this.db,
          "UPDATE security_operations SET next_run_at=? WHERE id=? AND state<>'applied' AND NOT EXISTS(SELECT 1 FROM system_state WHERE restore_in_progress=1)",
          Date.now() + delay,
          operation.id,
        ).run();
        if (age >= 15 * 60_000) console.warn('identity_checkpoint_pending');
      }
    }
  }
}
