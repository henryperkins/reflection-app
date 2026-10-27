import { Hash } from '../../contracts/index.ts';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { assertion, onlineGuard } from '../identity/checkpoint.ts';
import {
  type Bundle,
  type ContentApproval,
  inspectReviewedBundle,
  verifyContentApproval,
} from './approval.ts';
export type { ContentApproval } from './approval.ts';

/** One CAS batch, with immutable bundle bytes. Activation always leaves generation off. */
export async function activateContent(
  db: D1Database,
  value: Bundle,
  approval: ContentApproval,
  expectedRevision: number,
): Promise<{ contentHash: string; revision: number }> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new Error('Content activation revision required');
  const bundle = await inspectReviewedBundle(value);
  await verifyContentApproval(approval, bundle);
  const hash = bundle.editionHash,
    bytes = canonicalJson(bundle),
    signed = canonicalJson(approval),
    approvalHash = await sha256Json(approval);
  const done = async () =>
    !!(await q(
      db,
      "SELECT 1 FROM system_state sys JOIN content_editions c ON c.hash=sys.active_content_hash WHERE sys.id=1 AND sys.revision=? AND c.hash=? AND c.state='approved' AND c.bundle_json=? AND c.approval_hash=? AND sys.generation_enabled=0 AND sys.dispatch_mode='off'",
      expectedRevision + 1,
      hash,
      bytes,
      approvalHash,
    ).first());
  if (await done()) return { contentHash: hash, revision: expectedRevision + 1 };
  try {
    await db.batch([
      onlineGuard(db),
      assertion(
        db,
        'EXISTS(SELECT 1 FROM system_state WHERE id=1 AND revision=?)',
        expectedRevision,
      ),
      assertion(
        db,
        "NOT EXISTS(SELECT 1 FROM content_editions WHERE hash=? AND (state NOT IN ('staged','superseded') OR bundle_json!=? OR (state='superseded' AND (rights_status!='cleared' OR reviewer_kind!='human_approved' OR reviewer_id IS NULL OR reviewer_id!=? OR reviewed_hash IS NULL OR reviewed_hash!=hash OR approval_hash IS NULL OR approval_hash!=? OR approval_json IS NULL OR approval_json!=?))))",
        hash,
        bytes,
        approval.document.reviewerId,
        approvalHash,
        signed,
      ),
      q(
        db,
        `INSERT INTO content_editions(hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at,approval_json,approval_hash) VALUES (?,'approved',?,?,'human_approved',?,'cleared',${DB_NOW},?,?,?) ON CONFLICT(hash) DO UPDATE SET state='approved',reviewed_hash=excluded.reviewed_hash,reviewer_kind=excluded.reviewer_kind,reviewer_id=excluded.reviewer_id,rights_status=excluded.rights_status,approved_at=excluded.approved_at,approval_json=excluded.approval_json,approval_hash=excluded.approval_hash,policy_revision=content_editions.policy_revision+1`,
        hash,
        bytes,
        hash,
        approval.document.reviewerId,
        Date.parse(approval.document.approvedAt),
        signed,
        approvalHash,
      ),
      q(
        db,
        "UPDATE content_editions SET state='superseded',policy_revision=policy_revision+1 WHERE hash=(SELECT active_content_hash FROM system_state WHERE id=1) AND hash!=? AND state='approved'",
        hash,
      ),
      q(
        db,
        `UPDATE system_state SET active_content_hash=?,revision=revision+1,generation_enabled=0,dispatch_mode='off',updated_at=${DB_NOW} WHERE id=1 AND revision=?`,
        hash,
        expectedRevision,
      ),
      assertion(db, 'changes()=1'),
    ]);
  } catch (error) {
    if (!(await done())) throw error;
  }
  return { contentHash: hash, revision: expectedRevision + 1 };
}
export async function withdrawContent(
  db: D1Database,
  hash: string,
  expectedRevision: number,
): Promise<void> {
  Hash.parse(hash);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw new Error('Content withdrawal revision required');
  await db.batch([
    onlineGuard(db),
    assertion(db, 'EXISTS(SELECT 1 FROM system_state WHERE id=1 AND revision=?)', expectedRevision),
    q(
      db,
      `UPDATE content_editions SET state='withdrawn',policy_revision=policy_revision+1,withdrawn_at=${DB_NOW} WHERE hash=? AND state IN ('approved','superseded')`,
      hash,
    ),
    assertion(db, 'changes()=1'),
    q(
      db,
      `UPDATE system_state SET revision=revision+1,generation_enabled=CASE WHEN active_content_hash=? THEN 0 ELSE generation_enabled END,dispatch_mode=CASE WHEN active_content_hash=? THEN 'off' ELSE dispatch_mode END,updated_at=${DB_NOW} WHERE id=1 AND revision=?`,
      hash,
      hash,
      expectedRevision,
    ),
    assertion(db, 'changes()=1'),
  ]);
}
