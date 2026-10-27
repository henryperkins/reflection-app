import { Hash } from '../../contracts/index.ts';
import { canonicalJson, sha256Json } from '../../domain/json.ts';
import { type Bundle, type ContentTrust, verifySignedContentApproval } from './approval.ts';
export interface ContentRepository {
  active(): Promise<Bundle>;
  byHash(hash: string): Promise<Bundle>;
}
type Row = {
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
export class D1ContentRepository implements ContentRepository {
  constructor(
    private readonly db: D1Database,
    private readonly trust: ContentTrust,
  ) {}
  private async checked(row: Row | null, active = false): Promise<Bundle> {
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
  async active(): Promise<Bundle> {
    return this.checked(
      await this.db
        .prepare(
          "SELECT c.* FROM content_editions c JOIN system_state sys ON sys.active_content_hash=c.hash WHERE sys.id=1 AND c.state='approved'",
        )
        .first<Row>(),
      true,
    );
  }
  async byHash(hash: string): Promise<Bundle> {
    Hash.parse(hash);
    return this.checked(
      await this.db.prepare('SELECT * FROM content_editions WHERE hash=?').bind(hash).first<Row>(),
    );
  }
}
