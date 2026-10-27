import { assertion } from '../identity/checkpoint.ts';
import { Hash } from '../../contracts/index.ts';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import { type Bundle, type ContentTrust, verifySignedContentApproval } from './approval.ts';
export interface ContentRepository {
  forGeneration(hash?: string): Promise<ContentSnapshot>;
  active(): Promise<Bundle>;
  byHash(hash: string): Promise<Bundle>;
}
export type ContentRow = {
  policy_revision: number;
  hash: string;
  state: string;
  bundle_json: string;
  reviewed_hash: string;
  reviewer_kind: string;
  reviewer_id: string;
  rights_status: string;
  approval_json: string | null;
  approval_hash: string | null;
};
export interface ContentSnapshot {
  bundle: Bundle;
  policyRevision: number;
  guard: D1PreparedStatement;
}
/** Bind the exact verified row, including approval and content bytes, in the mutation batch. */
export function contentSnapshot(db: D1Database, row: ContentRow, bundle: Bundle): ContentSnapshot {
  const fields = [
    'hash',
    'bundle_json',
    'reviewed_hash',
    'reviewer_kind',
    'reviewer_id',
    'rights_status',
    'approval_json',
    'approval_hash',
    'policy_revision',
  ] as const;
  return {
    bundle,
    policyRevision: row.policy_revision,
    guard: assertion(
      db,
      `EXISTS(SELECT 1 FROM content_editions WHERE state IN ('approved','superseded') AND ${fields.map((f) => `${f} IS ?`).join(' AND ')})`,
      ...fields.map((f) => row[f]),
    ),
  };
}
export class D1ContentRepository implements ContentRepository {
  constructor(
    private readonly db: D1Database,
    private readonly trust: ContentTrust,
  ) {}
  private async checked(row: ContentRow | null, active = false): Promise<Bundle> {
    try {
      if (
        !row ||
        !['approved', 'superseded'].includes(row.state) ||
        row.reviewed_hash !== row.hash ||
        row.reviewer_kind !== 'human_approved' ||
        row.reviewer_id !== this.trust.reviewerId ||
        row.rights_status !== 'cleared' ||
        !row.approval_json
      )
        throw new Error();
      const bundle: Bundle = JSON.parse(row.bundle_json),
        approval: unknown = JSON.parse(row.approval_json);
      const signed = await verifySignedContentApproval(
        approval,
        bundle,
        this.trust,
        Date.now(),
        active,
      );
      if (
        bundle.editionHash !== row.hash ||
        (await sha256Json(signed)) !== row.approval_hash ||
        canonicalJson(signed) !== row.approval_json
      )
        throw new Error();
      return bundle;
    } catch {
      throw new Error('CONTENT_UNAVAILABLE: checked catalog required');
    }
  }
  async forGeneration(hash?: string): Promise<ContentSnapshot> {
    if (hash !== undefined) Hash.parse(hash);
    const row =
      hash === undefined
        ? await this.db
            .prepare(
              "SELECT c.* FROM content_editions c JOIN system_state sys ON sys.active_content_hash=c.hash WHERE sys.id=1 AND c.state='approved'",
            )
            .first<ContentRow>()
        : await this.db
            .prepare('SELECT * FROM content_editions WHERE hash=?')
            .bind(hash)
            .first<ContentRow>();
    const bundle = await this.checked(row, hash === undefined);
    return contentSnapshot(this.db, row!, bundle);
  }
  async active(): Promise<Bundle> {
    return this.checked(
      await this.db
        .prepare(
          "SELECT c.* FROM content_editions c JOIN system_state sys ON sys.active_content_hash=c.hash WHERE sys.id=1 AND c.state='approved'",
        )
        .first<ContentRow>(),
      true,
    );
  }
  async byHash(hash: string): Promise<Bundle> {
    Hash.parse(hash);
    return this.checked(
      await this.db
        .prepare('SELECT * FROM content_editions WHERE hash=?')
        .bind(hash)
        .first<ContentRow>(),
    );
  }
}
