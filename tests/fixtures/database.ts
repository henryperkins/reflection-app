import type { SyntheticPlan } from '../../src/worker/db/prototype.ts';

export const SYNTHETIC = 'SYNTHETIC_ONLY_NOT_ENCRYPTED';
export const OWNER = '11111111-1111-4111-8111-111111111111';
export const OTHER = '22222222-2222-4222-8222-222222222222';
export const CONTENT = 'a'.repeat(64);
export const POLICY = 'b'.repeat(64);
export const HASH = 'c'.repeat(64);
export const sql = (db: D1Database, query: string, ...values: (string | number | null)[]) =>
  db.prepare(query).bind(...values);
export async function seedDatabase(db: D1Database): Promise<SyntheticPlan> {
  await db.batch([
    sql(
      db,
      `INSERT INTO content_editions(hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at) VALUES (?,'approved','{}',?,'human_approved','synthetic-reviewer','cleared',1,1)`,
      CONTENT,
      CONTENT,
    ),
    sql(
      db,
      `INSERT INTO system_state(id,active_content_hash,generation_enabled,dispatch_mode,provider_policy_hash,updated_at) VALUES (1,?,1,'model',?,1)`,
      CONTENT,
      POLICY,
    ),
    ...[OWNER, OTHER].flatMap((owner) => [
      sql(
        db,
        `INSERT INTO accounts(id,recovery_handle_hash,recovery_ack_at,created_at,updated_at) VALUES (?,?,1,1,1)`,
        owner,
        owner,
      ),
      sql(
        db,
        `INSERT INTO account_keys(owner_id,version,wrap_key_id,wrapped_key_enc,wrapped_index_key_enc,created_at) VALUES (?,1,'synthetic',?,?,1)`,
        owner,
        SYNTHETIC,
        SYNTHETIC,
      ),
      sql(
        db,
        `INSERT INTO permission_revisions(owner_id,revision,model_allowed,policy_version,created_at) VALUES (?,1,1,'egress.v1',1)`,
        owner,
      ),
    ]),
  ]);
  const sessionId = crypto.randomUUID(),
    basisId = crypto.randomUUID();
  await db.batch([
    sql(
      db,
      `INSERT INTO reading_sessions(id,owner_id,question_enc,created_at,retention_expires_at) VALUES (?,?,?,1,9999999999999)`,
      sessionId,
      OWNER,
      SYNTHETIC,
    ),
    sql(
      db,
      `INSERT INTO basis_snapshots(id,owner_id,session_id,kind,schema_version,body_enc,key_version,created_at) VALUES (?,?,?,'tarot.v1',1,?,1,1)`,
      basisId,
      OWNER,
      sessionId,
      SYNTHETIC,
    ),
  ]);
  return {
    syntheticOnly: true,
    ownerId: OWNER,
    sessionId,
    basisId,
    clientIntentId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    payloadHmac: HASH,
    planHmac: HASH,
    keyVersion: 1,
    permissionRevision: 1,
    contentHash: CONTENT,
    contentPolicyRevision: 1,
    policyHash: POLICY,
    context: [],
  };
}
export async function addContext(db: D1Database, plan: SyntheticPlan): Promise<SyntheticPlan> {
  const edition = crypto.randomUUID(),
    grant = crypto.randomUUID();
  await db.batch([
    sql(
      db,
      `INSERT INTO reading_editions(id,owner_id,session_id,edition_number,status,mode,body_enc,key_version,accepted_at) VALUES (?,?,?,1,'imported','legacy',?,1,1)`,
      edition,
      plan.ownerId,
      plan.sessionId,
      SYNTHETIC,
    ),
    sql(
      db,
      `INSERT INTO context_grants(id,owner_id,edition_id,state,created_at,updated_at) VALUES (?,?,?,'allowed',1,1)`,
      grant,
      plan.ownerId,
      edition,
    ),
  ]);
  return { ...plan, context: [{ grantId: grant, grantRevision: 1, fragmentHmac: HASH }] };
}

/** Plugin v1 does not roll storage back between tests; clean in one FK-deferred batch. */
export async function clearDatabase(db: D1Database): Promise<void> {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('d1_migrations','_cf_METADATA')",
    )
    .all<{ name: string }>();
  await db.batch([
    db.prepare('PRAGMA defer_foreign_keys=ON'),
    ...tables.results.map(({ name }) => db.prepare(`DELETE FROM "${name}"`)),
  ]);
}
