# Dated revisit notes: proposed implementation contract

Status: draft for review. No endpoints, tables or screens in this document have been implemented. The user authorized preparing the next increment; the proposed defaults below are engineering recommendations, not previously approved policy. This contract develops the existing [dated revisit notes design](../../design/dated-revisit-notes.md) against application commit `a60a5ec55e2855fffebd0341224c32b7a42d7ba0`.

## Intent and scope

A person can return to a saved reading and add a separately dated account of what they think now. The original accepted reading, sources and original reflection remain unchanged. Adding, editing, reading, exporting and deleting notes work with AI off and never make a provider request. Dates describe when the server saved the note; opening a reading does not create a note or record a revisit event.

The first increment includes a chronological note list, add/edit/delete controls, conflict handling, retained revisions, export, erasure and recovery coverage. Selected context, follow-up generation, imports, reminders, automatic summaries and search are separate increments. No new provider permission or context grant is created.

## Approaches and recommendation

1. Treat each later thought as another ordinary reflection. This reuses existing revision machinery but loses the distinction between the original reflection and a dated revisit, and conflicts with the supplied design.
2. **Recommended: enable a separate revisit resource with revision-safe editing.** Build on the dormant `revisits` family, its exact edition linkage and existing encryption/accounting coverage. Add the missing routes, history, erasure and export support together.
3. Ship append-only notes initially. This reduces edit/history work but omits the explicitly requested edit and conflict states and encourages duplicate notes to correct mistakes.

The recommendation is recorded for review; it is not described as a user-selected architecture. Database/index details and component boundaries may be refined during implementation without changing the behavior and privacy contract below.

## Existing constraints that affect the work

- `src/contracts/index.ts` already defines a minimal `Revisit` (`id`, `editionId`, `note`, `createdAt`), `RevisitWrite`, a portable `revisit` record and a 50-item page. `checks/generate-openapi.ts` describes create/list operations, but `src/worker/readings/routes.ts` does not implement them.
- `revisits` currently stores one encrypted body, its key version, owner, exact edition and server date. Its encryption AAD includes the existing table/column/id. SQL must not move ciphertext to a new encryption identity and pretend it is still readable.
- `ReadingExports` deliberately fails closed if any revisit rows exist. This guard must be narrowed only after complete revisit export support is available; enabling create alone would break export for that account.
- `RecordBase.atomic()` enforces the existing 20 MiB account admission estimate. Accounting includes encrypted UTF-8 bytes plus 1 KiB per owned row. Existing triggers already count the original revisit body.
- Standalone note erasure is absent. `ErasureTarget` and `deletion_jobs.scope` currently support account/session/reflection revision/context-copy scopes; session erasure already deletes its revisit rows. New note deletion needs a durable ledger target, fencing and restore replay, not a bare SQL delete.
- Retained-key inventory, rekey, restore and the fixed private-field registry cover the current revisit ciphertext. Any new encrypted revision storage must participate in all of them.

## Proposed product defaults

These are the concrete choices to review before implementation:

| Choice | Proposed default | Reason |
| --- | --- | --- |
| Text | 1–2,000 Unicode code points, with at least one non-whitespace character | Keeps the existing note-size intent and rejects empty saves; server and client use the same counting rule. Preserve the authored text without silently trimming or normalizing it. |
| Stance | Optional; reuse `resonates`, `unsure`, `disagree`, `unspecified` | Matches existing reflection vocabulary; omission becomes `unspecified`. |
| Number of notes | At most 100 active notes per exact reading edition | Bounds list and deletion work while allowing ongoing use. Deleted-note metadata still counts toward account storage. |
| Edit history | Retain every prior saved revision until that note, reading or account is deleted | Makes revisions/export truthful and enables exact retry results. The disclosure must say old versions are retained. |
| Revision count | At most 100 saved revisions per note, including creation | Matches the existing reflection revision bound; no silent overwrite or revision eviction at the limit. |
| Parent retention | Create only on an explicitly saved reading. Reject unsaving a reading while it has active notes; whole-reading deletion remains available. | Prevents an unrelated unsave action from silently placing dated notes into the 24-hour unsaved expiry path. |
| History order | Oldest note first, stable `(createdAt, id)` order | Matches the supplied chronological revisit design; edits keep the original position. |
| Privacy | Service-readable encryption; no automatic AI sharing; no persisted browser drafts | Uses the current application privacy model without claiming end-to-end encryption. |

No new subscription, generation quota or spending limit is introduced. Existing record read/write rate limits continue to apply. The per-note/per-edition limits are not substitutes for the account storage ceiling.

## Resource and API contract

Define an explicit revised note representation with `kind: "revisit.v2"`, `id`, `sessionId`, `editionId`, `revision`, `note`, `stance`, `createdAt` and `updatedAt`. The first revision has equal creation/update timestamps. Later edits preserve `id`, owner, session, edition and creation time. Timestamps come from the trusted server clock and are returned as UTC instants; the UI renders the person's local timezone with a machine-readable `<time datetime>` value and an accessible full date/time.

Keep an explicit decoder for the existing minimal revisit representation. Existing valid records retain their original date and receive normalized revision 1/unspecified stance on read; do not fabricate an earlier reflection into a dated note. Unknown encrypted body formats fail unavailable without rewriting them. The implementation should version portable export values so old and new note shapes are unambiguous and historical exports remain parseable.

All routes are under `/api/v1`, authenticated, owner-scoped, private/no-store, and subject to the existing origin, CSRF, auth epoch, account write fence and recovery coordination rules. Cross-owner identifiers return not found before decryption.

| Operation | Proposed interface and behavior |
| --- | --- |
| Create | `POST /revisits`, idempotency key, body `{editionId, note, stance}`. Derive the exact parent session server-side. Return 201, revision 1 and ETag. Assert saved parent, matching owner and available accepted/imported edition in the write transaction. |
| List | `GET /revisits?editionId=…&cursor=…&limit=…`, default 20/max 50. Ascending keyset order; signed cursor binds owner, current authentication epoch, edition and order. Return current nondeleted notes and `nextCursor`. |
| Read | `GET /revisits/:id`, optional exact `revision`. Return the current or retained historical snapshot and its ETag. |
| Edit | `PUT /revisits/:id`, idempotency key and exact `If-Match`, body `{note, stance}`. No parent/date fields are accepted. Atomically preserve the old revision and install the next one. |
| Delete | `DELETE /revisits/:id`, idempotency key, current `If-Match` and the existing client-generated deletion receipt id/token body. A new deletion intent with stale `If-Match` returns 409 with the current revision before fencing or erasing anything, just as an edit does. Replaying an already accepted matching deletion receipt preserves normal idempotent receipt behavior. Delete means the entire note and all its saved revisions. Return the normal durable deletion receipt. |

Missing preconditions return 428; stale revisions return 409 with the current revision, retaining the client draft. Reusing an idempotency key for different input returns `IDEMPOTENCY_MISMATCH`. Reading an owned erased note returns unavailable, and an old mutation retry must never resurrect it or return erased text. Use distinct typed errors for note count, revision count and account storage exhaustion, with corresponding actionable copy; do not report the AI reading allowance or a generic refresh loop for these limits. Contract/OpenAPI/generated mirrors change together.

Idempotency follows the existing seven-day owner-key/payload-HMAC policy; this contract does not promise permanent deduplication. A successful create/edit stores an exact `noteId:revision` result reference. Same-key replay resolves that original revision after reauthorization, including when the note has subsequently been edited. A deleted note returns unavailable within that receipt window. Once seven days have elapsed since the original attempt, the client stops **all** automatic submissions, including ones with the original key, because the server may have removed its receipt. It requires inspecting the current notes and an explicit new create/edit decision. No durable create-identity table is added in this increment. This bounded retry guarantee belongs in the implementation and test plan; an expired key must never be advertised as providing permanent protection against duplicate creates.

List pagination is a live ordered view, not a frozen account export. Deletions between pages do not repeat or skip later surviving keys. While an editor is open, other-note activity may refresh the list but must not replace the local draft.

A cursor is a pagination position, never an authorization credential. Validate it against the currently authenticated owner and epoch, independently constrain every query to that owner and exact parent edition, and recheck active authentication and parent availability before releasing decrypted results. Include the epoch in the revisit cursor's signed scope so a cursor from before recovery or logout-all is rejected even after the owner signs in again. The existing `RecordBase` helper already binds `session.subjectId`; supply a revisit scope containing the current epoch, edition and order, and retain the independent owner-qualified queries and authentication guards.

## Persistence, encryption and migration

Extend `revisits` with a current revision, immutable parent session linkage, `updated_at` and logical deletion state. Keep the current body under the existing `revisits.note_enc` encryption identity. Permit a null current body only after erasure. Add a `revisit_revisions` table for archived **prior** snapshots with owner/note/revision uniqueness, encrypted body, key version, revision-save timestamp and erasure state. The current snapshot lives only in `revisits`; do not store a second current copy.

On edit, decrypt/validate the current snapshot, reseal it under the historical table's explicitly registered AAD, and seal the replacement under the original current-body identity with the next AAD revision. A single guarded D1 batch inserts the archived snapshot, CAS-updates the current pointer/body/timestamp, records idempotency and advances account `data_revision`. Any failure rolls the entire batch back. Key-version and parent-availability checks are repeated inside the batch. Replayed result lookup selects current versus archived storage by exact revision.

Use an additive/rebuild migration that preserves existing valid note ciphertext and its old AAD version, original owner/edition/date, foreign-key ownership and import identity links. Initial current revision is 1; session is derived from the same-owner edition. Existing bodies are normalized only after authenticated decryption, not rewritten by SQL. Test the nonempty migration path as well as fresh databases. Existing fixtures that use a lower-level encrypted note payload must remain explicit cryptographic fixtures, not be silently accepted as valid public-domain records.

If an existing valid legacy note is attached to an unsaved parent, migration preserves the parent's existing expiry and availability rules; it must not silently save or extend the reading. Before expiry, the note can be read/exported with that parent and the UI displays the actual expiry. Editing requires explicitly saving the parent first. Expired/deleted-parent notes remain unavailable and follow the existing parent erasure job. This legacy case neither blocks migration nor creates a new saved-lifetime promise. New note creation always requires a saved parent.

Rebuilding the nullable note column and installing new accounting triggers must not double-count existing bodies. Recompute the account estimate with the same registry-derived rule, including archived revisions, idempotency and tombstone rows. At-capacity reads and deletion stay available. New writes that would exceed 20 MiB fail atomically with no saved partial note or consumed revision.

Extend the private-field registry, source schema and generated mirrors, ciphertext enumeration, rekey codecs, key-reference inventory, retention eligibility and cleanup manifests together. Register historical-body AAD with owner, note id and revision. Never rename encrypted storage or retire an old key based only on current notes when archived versions still reference it. Old binaries must not resume writers after the new feature is enabled; deployment/recovery compatibility checks must recognize the new schema and resource version.

## Retention, deletion, restore and export

Notes and their prior revisions remain with the saved parent until explicit note, reading or account deletion. Editorial withdrawal of a generated interpretation does not erase the person's notes: render the unavailable reading state alongside their still-accessible annotations. New note creation against unavailable/deleted editions is rejected; editing existing annotations remains available when the parent session is saved and owned. Unsaving with active notes is rejected with a clear explanation and links to note or whole-reading deletion.

Add a durable whole-note erasure target containing the owner and note identity, encrypted/signed through the existing recovery ledger. Admission checks the current revision, fences all note reads/writes immediately, advances the account snapshot revision and records the job before returning success. The ledger intent must become durable before body erasure is reported complete. Erase current and every archived body, queued/raw copies (none are created by this increment), idempotent response access and any relevant source aliases; keep only bounded content-free tombstone metadata necessary for recovery/integrity. Session and account erasure include both note stores.

Use the existing pass/completion and backup-deadline calculation; never promise an invented shorter deadline. Replay a stale database backup so that a deleted note stays deleted, including edits committed after an earlier bookmark. Interrupted/duplicated deletes and lost acknowledgements return the same receipt. An unavailable ledger leaves the note fenced and the job pending. Retention cleanup cannot remove a pending erasure's required state. Existing encrypted R2 ledger formats must remain readable; extend their target decoder explicitly rather than relabeling old documents.

Export current and every nonerased archived note revision under portable kind `revisit`, with stable identity/revision, exact session/edition linkage, stance and both original/edited timestamps. The portable record's `recordRevision` identifies the authored revision. The exporter removes only the revisit portion of its unsupported-family guard; context grants/import families remain closed. Include notes on saved parents whose generated content is withdrawn, while excluding erased bodies and inaccessible sessions. Reads are bounded, with existing record/byte page limits and final account snapshot/auth rechecks. Creating, editing or deleting any note invalidates an existing export ticket so no mixed snapshot is released. Parent-session or account deletion invalidates it when the deletion admission/fence batch advances `accounts.data_revision`, before asynchronous ledger/body erasure completes. Subsequent page release must fail the snapshot or active-authentication check; it must not continue serving notes while the parent is deleting. Previously downloaded bytes cannot be retracted.

The minimum consumer can inspect history via exact revision API/export; a dedicated revision-history comparison UI is outside this first increment. There is no individual historical-revision delete control in this contract: the deletion action erases the whole note, and copy must make that scope explicit. Original reflection revision erasure is unchanged.

## Interface and copy

Use the supplied Return, with time concept and the current Reflection / Account header. Keep the original reflection above the separately labelled **Revisit notes** section. Show original saved date and, after an edit, a separate edited date. The list may progressively load older-to-newer pages without changing the active editor or scroll unexpectedly. Notes remain visibly authored by the person, not generated interpretations.

Add/edit state order is text, optional stance, **Save note**, **Cancel**. Disable only the submitting action while saving. Failure, offline response or revision conflict preserves the editable in-memory draft. Explicit refresh of a conflicting note shows the latest saved version separately; overwrite requires a new deliberate save against that version. No automatic merge, new-key retry, localStorage or IndexedDB persistence of private text.

Use existing navigation/Back/reload/expiry protections. Cancel returns focus to the initiating control; deleting a note places focus on the adjacent note heading or Add revisit note. Announce saving, save failure/conflict and deletion outcomes without unnecessarily reading other private notes. Delete confirmation names the note date and that all saved versions are included. Never hide or truncate a deletion receipt.

Proposed disclosure: “This note is saved with this reading until you delete the note, reading or account. Editing keeps earlier saved versions, which are included in your export. Notes are encrypted at rest and can be read by this service when needed to show or manage them. Saving a note does not send it to an AI provider.” Deletion copy uses the existing active-storage versus backup-removal explanation and actual receipt deadline. Review this wording alongside the product defaults above.

## Required verification and completion boundary

- Contracts: shared Unicode length/empty validation, explicit old/new note decoding, malformed/cross-owner parent IDs, forbidden date/owner mutations and consistent errors/OpenAPI projections.
- D1: concurrent creates at the per-edition/storage boundary; same-key lost-ack replay; edit/edit and edit/delete CAS races; stale deletion preconditions versus accepted-receipt replay; exact old-revision replay after later edits; seven-day uncertainty handling (no stale-key automatic create retry); atomic revision/parent/key guards; saved-only creation and unsave protection; no quota/provider calls.
- Privacy: snapshot-consistent paginated export and invalidation at parent/account deletion admission; cursor owner/epoch/edition tampering and epoch changes between pages; withdrawn-parent annotations, current plus archived erasure, same-note versus other-note isolation, parent/account cascades, ledger outage, repeated interruption, and two stale-restore passes proving deleted notes cannot reappear.
- Keys/accounting: nonempty migration including unsaved/expired legacy parents without retention extension, foreign-key graph, correct body AAD, rekey interruption/resume for both stores, inventory/retirement refusing referenced old keys, exact byte counters after create/edit/delete and bounded tombstone cleanup.
- Browser: two dated notes and unchanged original reading/reflection; edit/cancel/conflict/offline/expired-session drafts; AI-off add/edit/export/delete; return/sign-in/recovery; correct dates and focus; 320/390/768/1280 px, both themes, enlarged text and existing cross-browser journeys.
- Run `npm run verify`, the cross-browser journey suite and updated comparison screenshots after implementation. Record actual environment and gaps; this increment does not itself qualify physical authenticators, screen readers or production hosting.

The review decision is the proposed note/revision limits, retention of old edited text, saved-parent requirement/unsave behavior, and associated disclosure. After those defaults and the separate-resource approach are approved, write the implementation plan and implement the entire storage/export/erasure slice before exposing create in the client. Production domain/budget/validator decisions remain separate; this draft does not introduce new production or human-review gates.
