import type { DBClient } from "../d1.server";
import { contentChecksum } from "./draft-comparison";
import { samePublishedBundle, validateContentGraph } from "./schema";
import { isEarlierRelease } from "./release-version";
import {
  draftAdminGuard,
  draftUnchangedGuard,
  loadReviewedDraft,
  requireDraftAdmin,
} from "./content-drafts.server";

export const CONTENT_CHECKSUM_ALGORITHM = "sha256-canonical-json-v1";
export type ReleaseActor = { kind: "admin"; userId: string } | { kind: "signed-public" };
type Source = "admin" | "public-ingest" | "public-rollback";
type Statement = { sql: string; params: (string | number | null)[] };
export interface PublicationState {
  operationId: string;
  operation: "stage" | "activate" | "rollback";
  status: "pending" | "complete" | "failed" | "superseded";
  active: boolean;
  previousVersion: string | null;
  artifactKey: string | null;
  error: string | null;
}
interface StoredRelease {
  id: string;
  version: string;
  checksum: string;
  checksum_algorithm: string | null;
  bundle: Record<string, unknown>;
  bundle_identity: string;
  is_active: boolean;
  created_at: string;
  publication_state: PublicationState | null;
}
export interface ReleaseReceipt {
  id: string;
  version: string;
  checksum: string;
  checksumAlgorithm: string;
  previousVersion: string | null;
  activeVersion: string | null;
  isRollback: boolean;
  publication: PublicationState;
}
export class ContentReleaseError extends Error {
  constructor(
    message: string,
    public status = 500,
  ) {
    super(message);
  }
}

async function authorize(db: DBClient, actor: ReleaseActor) {
  if (actor.kind === "admin") await requireDraftAdmin(db, actor.userId);
  else if (actor.kind !== "signed-public")
    throw new ContentReleaseError("Release authority is required.", 403);
}
const authorityGuards = (actor: ReleaseActor): Statement[] =>
  actor.kind === "admin" ? [draftAdminGuard(actor.userId)] : [];
function adminAudit(
  actor: ReleaseActor,
  kind: string,
  detail: Record<string, unknown>,
): Statement[] {
  return actor.kind === "admin"
    ? [
        {
          sql: "INSERT INTO audit_events (id,user_id,kind,detail) VALUES (?,?,?,?)",
          params: [crypto.randomUUID(), actor.userId, kind, JSON.stringify(detail)],
        },
      ]
    : [];
}

async function findRelease(db: DBClient, version: string) {
  const { data, error } = await db
    .from<StoredRelease>("content_releases")
    .select(
      "id,version,checksum,checksum_algorithm,bundle,bundle AS bundle_identity,is_active,created_at,publication_state",
    )
    .eq("version", version)
    .maybeSingle();
  if (error) throw new ContentReleaseError("The release could not be read. Please retry.");
  return data;
}
async function activeRelease(db: DBClient) {
  const { data, error } = await db
    .from<StoredRelease>("content_releases")
    .select("id,version,checksum,created_at")
    .eq("is_active", true)
    .maybeSingle();
  if (error)
    throw new ContentReleaseError("The active release pointer could not be read. Please retry.");
  return data;
}
function initialPublication(
  operation: PublicationState["operation"],
  active: boolean,
  previousVersion: string | null,
): PublicationState {
  return {
    operationId: crypto.randomUUID(),
    operation,
    status: "pending",
    active,
    previousVersion,
    artifactKey: null,
    error: null,
  };
}
async function receipt(
  db: DBClient,
  release: StoredRelease,
  state: PublicationState,
): Promise<ReleaseReceipt> {
  const active = await activeRelease(db);
  return {
    id: release.id,
    version: release.version,
    checksum: release.checksum,
    checksumAlgorithm: release.checksum_algorithm ?? "legacy-unlabelled",
    previousVersion: state.previousVersion,
    activeVersion: active?.version ?? null,
    isRollback: state.operation === "rollback",
    publication:
      state.active && active?.version !== release.version
        ? {
            ...state,
            status: "superseded",
            error: "The active release advanced. This publication no longer owns the pointer.",
          }
        : state,
  };
}

/** Delivery retries reuse the same operation. They never calculate a chart or call a model. */
async function deliver(
  db: DBClient,
  release: StoredRelease,
  state: PublicationState,
): Promise<ReleaseReceipt> {
  if (state.status === "complete" || state.status === "superseded")
    return receipt(db, release, state);
  if (state.active && (await activeRelease(db))?.version !== release.version) {
    const superseded: PublicationState = {
      ...state,
      status: "superseded",
      error:
        "The active release advanced. Activate this release again explicitly to move the pointer.",
    };
    await db.exec(
      "UPDATE content_releases SET publication_state=? WHERE id=? AND json_extract(publication_state,'$.operationId')=?",
      [JSON.stringify(superseded), release.id, state.operationId],
    );
    return receipt(db, release, superseded);
  }
  const { publishReleaseArtifact } = await import("../workflows.server");
  const result = await publishReleaseArtifact({
    operationId: state.operationId,
    version: release.version,
    checksum: release.checksum,
    active: state.active,
  });
  const succeeded =
    result?.ok === true &&
    result.operationId === state.operationId &&
    result.version === release.version &&
    result.checksum === release.checksum &&
    typeof result.artifactKey === "string" &&
    (!state.active || result.activeVersion === release.version);
  const updated: PublicationState = {
    ...state,
    status: succeeded ? "complete" : "failed",
    artifactKey: succeeded ? result.artifactKey : null,
    error: succeeded
      ? null
      : "Release saved; edge artifact or pointer delivery is incomplete. Reconcile publication.",
  };
  const changed = await db.exec<{ id: string }>(
    "UPDATE content_releases SET publication_state=? WHERE id=? AND checksum=? AND json_extract(publication_state,'$.operationId')=? AND (json_extract(publication_state,'$.status') IN ('pending','failed') OR (?='complete' AND json_extract(publication_state,'$.status')='complete')) RETURNING id",
    [JSON.stringify(updated), release.id, release.checksum, state.operationId, updated.status],
  );
  if (!changed.length) {
    const current = await findRelease(db, release.version);
    if (!current?.publication_state)
      throw new ContentReleaseError("Publication state changed. Reload the release.");
    return receipt(db, current, current.publication_state);
  }
  return receipt(db, release, updated);
}

/** Immutable inactive staging, shared by reviewed admin drafts and signed uploads. */
export async function stageContentRelease(
  db: DBClient,
  input: {
    version: string;
    bundle: Record<string, unknown>;
    actor: ReleaseActor;
    source: Source;
    draftReview?: { draftId: string; candidateHash: string; baseHash: string };
  },
): Promise<ReleaseReceipt> {
  await authorize(db, input.actor);
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(input.version) ||
    input.version.length > 64
  )
    throw new ContentReleaseError("New releases require a numeric semantic version.", 400);
  if (input.bundle["version"] !== undefined && input.bundle["version"] !== input.version)
    throw new ContentReleaseError("Bundle version does not match the release version.", 422);
  try {
    validateContentGraph(input.bundle);
  } catch (error) {
    throw new ContentReleaseError(
      error instanceof Error ? error.message : "Invalid release graph",
      422,
    );
  }
  const checksum = await contentChecksum(input.bundle);
  const serialized = JSON.stringify(input.bundle);
  if (serialized.length > 1000000)
    throw new ContentReleaseError("Release content exceeds the limit.", 422);
  const existing = await findRelease(db, input.version);
  if (existing && !samePublishedBundle(existing.bundle, input.bundle))
    throw new ContentReleaseError(
      "Release version conflict with differing immutable content.",
      409,
    );
  const guards = authorityGuards(input.actor),
    consume: Statement[] = [];
  if (input.draftReview) {
    if (input.actor.kind !== "admin")
      throw new ContentReleaseError("Draft review requires administrator authority.", 403);
    const draft = await loadReviewedDraft(db, input.actor.userId, input.draftReview.draftId);
    const candidateHash = await contentChecksum(draft.bundle);
    if (
      !draft.base_hash ||
      input.draftReview.baseHash !== draft.base_hash ||
      input.draftReview.candidateHash !== candidateHash ||
      draft.review_candidate_hash !== candidateHash ||
      draft.review_base_hash !== draft.base_hash
    )
      throw new ContentReleaseError(
        "Review and approve the exact candidate and frozen baseline before publishing.",
        409,
      );
    if (!samePublishedBundle({ ...draft.bundle, version: input.version }, input.bundle))
      throw new ContentReleaseError("The reviewed candidate changed before publication.", 409);
    guards.push(draftUnchangedGuard(draft), {
      sql: "SELECT CASE WHEN EXISTS(SELECT 1 FROM content_drafts WHERE id=? AND review_candidate_hash=? AND review_base_hash=?) THEN 1 ELSE json('draft-review-changed') END",
      params: [draft.id, candidateHash, draft.base_hash],
    });
    consume.push({
      sql: "UPDATE content_drafts SET status='published',published_version=? WHERE id=?",
      params: [input.version, draft.id],
    });
  }
  const state = existing?.publication_state ?? initialPublication("stage", false, null);
  const stageRecord = {
    operationId: state.operationId,
    actorKind: input.actor.kind,
    source: input.source,
    reviewHash: input.draftReview?.candidateHash ?? null,
    at: new Date().toISOString(),
  };
  const id = existing?.id ?? crypto.randomUUID();
  const writes: Statement[] = existing
    ? !existing.publication_state
      ? [
          {
            sql: "UPDATE content_releases SET publication_state=? WHERE id=? AND bundle=? AND publication_state IS NULL",
            params: [JSON.stringify(state), id, existing.bundle_identity],
          },
        ]
      : []
    : [
        {
          sql: "INSERT INTO content_releases (id,version,checksum,checksum_algorithm,bundle,is_active,stage_receipt,publication_state,created_at) VALUES (?,?,?,?,?,0,?,?,?)",
          params: [
            id,
            input.version,
            checksum,
            CONTENT_CHECKSUM_ALGORITHM,
            serialized,
            JSON.stringify(stageRecord),
            JSON.stringify(state),
            stageRecord.at,
          ],
        },
      ];
  if (!existing || consume.length) {
    try {
      await db.batch([
        ...guards,
        ...writes,
        ...consume,
        ...adminAudit(
          input.actor,
          input.draftReview ? "content_draft_published" : "content_release_staged",
          { version: input.version, checksum: existing?.checksum ?? checksum, ...stageRecord },
        ),
      ]);
    } catch {
      const winner = await findRelease(db, input.version);
      if (winner && !input.draftReview) {
        if (!samePublishedBundle(winner.bundle, input.bundle))
          throw new ContentReleaseError(
            "Release version conflict with differing immutable content.",
            409,
          );
        return deliver(db, winner, winner.publication_state ?? state);
      }
      throw new ContentReleaseError(
        "Release staging failed or the draft changed. No partial draft publication was committed.",
        409,
      );
    }
  } else if (writes.length) await db.batch([...guards, ...writes]);
  const stored = await findRelease(db, input.version);
  if (!stored) throw new ContentReleaseError("The staged release could not be confirmed.");
  return deliver(db, stored, stored.publication_state ?? state);
}

/** Pointer and both audit forms commit together; a stale decision cannot replace newer work. */
export async function setActiveContentRelease(
  db: DBClient,
  input: {
    version: string;
    expectedPreviousVersion?: string | null | undefined;
    actor: ReleaseActor;
    source: Source;
  },
): Promise<ReleaseReceipt> {
  await authorize(db, input.actor);
  let target = await findRelease(db, input.version);
  if (!target) throw new ContentReleaseError("Unknown release version.", 404);
  try {
    validateContentGraph(target.bundle);
  } catch (error) {
    throw new ContentReleaseError(
      error instanceof Error ? error.message : "Invalid release graph",
      422,
    );
  }
  if (
    target.checksum_algorithm === CONTENT_CHECKSUM_ALGORITHM &&
    (await contentChecksum(target.bundle)) !== target.checksum
  )
    throw new ContentReleaseError("Release checksum failed its integrity check.", 422);
  const previous = await activeRelease(db),
    previousVersion = previous?.version ?? null;
  const expected =
    input.expectedPreviousVersion === undefined ? previousVersion : input.expectedPreviousVersion;
  if (previousVersion === target.version) {
    // A concurrent activation can land between target and pointer reads. Reuse
    // the operation committed with that pointer, rather than the staged copy.
    const currentTarget = await findRelease(db, input.version);
    if (!currentTarget?.is_active || (await activeRelease(db))?.version !== input.version)
      throw new ContentReleaseError("The active release changed. Reload before activation.", 409);
    target = currentTarget;
    const old = target.publication_state;
    if (expected !== previousVersion && (!old || old.previousVersion !== expected))
      throw new ContentReleaseError("The active release changed. Reload before activation.", 409);
    if (old?.active) return deliver(db, target, old);
  } else if (expected !== previousVersion)
    throw new ContentReleaseError("The active release changed. Reload before activation.", 409);
  const isRollback =
    input.source === "public-rollback" || Boolean(previous && isEarlierRelease(target, previous));
  const state = initialPublication(isRollback ? "rollback" : "activate", true, previousVersion);
  const event = {
    operationId: state.operationId,
    version: target.version,
    checksum: target.checksum,
    previousVersion,
    actorKind: input.actor.kind,
    source: input.source,
    action: state.operation,
    at: new Date().toISOString(),
  };
  try {
    await db.batch([
      ...authorityGuards(input.actor),
      {
        sql: "SELECT CASE WHEN (SELECT COUNT(*) FROM content_releases WHERE is_active=1)<=1 AND (SELECT version FROM content_releases WHERE is_active=1 LIMIT 1) IS ? THEN 1 ELSE json('release-pointer-changed') END",
        params: [previousVersion],
      },
      {
        sql: "SELECT CASE WHEN EXISTS(SELECT 1 FROM content_releases WHERE id=? AND checksum=? AND bundle=?) THEN 1 ELSE json('release-content-changed') END",
        params: [target.id, target.checksum, target.bundle_identity],
      },
      { sql: "UPDATE content_releases SET is_active=0 WHERE is_active=1", params: [] },
      {
        sql: "UPDATE content_releases SET is_active=1,activation_audit=json_insert(COALESCE(activation_audit,'[]'),'$[#]',json(?)),publication_state=? WHERE id=?",
        params: [JSON.stringify(event), JSON.stringify(state), target.id],
      },
      ...adminAudit(
        input.actor,
        isRollback ? "content_release_rollback" : "content_release_activated",
        event,
      ),
    ]);
  } catch {
    throw new ContentReleaseError(
      "Release activation failed or the pointer changed. Reload before retrying.",
      409,
    );
  }
  return deliver(db, target, state);
}

export async function reconcileContentReleasePublication(
  db: DBClient,
  input: { version: string; actor: ReleaseActor },
) {
  await authorize(db, input.actor);
  const release = await findRelease(db, input.version);
  if (!release?.publication_state)
    throw new ContentReleaseError(
      "This historical release has no publication operation to reconcile.",
      409,
    );
  return deliver(db, release, release.publication_state);
}

