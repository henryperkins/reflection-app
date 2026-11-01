# Dated Revisit Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let people add, edit, return to, export and erase separately dated notes on saved readings without changing the accepted reading or making an AI request.

**Architecture:** Enable the dormant revisit family with a current encrypted snapshot in `revisits` and immutable prior snapshots in `revisit_revisions`. Use the existing authenticated record service, transactional accounting, durable erasure ledger and registry-driven key lifecycle. Expose routes only after export/erasure work is complete, then mount a focused notes component inside the existing reading workspace.

**Tech Stack:** Existing TypeScript/React/Zod, Cloudflare Workers/D1/R2, Vitest workerd tests and Playwright; Node 26.12.1/npm 11.20.0. No new dependencies.

**Spec:** [Approved implementation contract](../specs/2026-11-01-dated-revisit-notes-design.md). User authorization: “Approve these defaults and implement”. Execute the plan without another method/plan approval round.

## Global Constraints

- Text: 1–2,000 Unicode code points, with at least one non-whitespace character; preserve authored text without trimming/normalizing.
- Stance: `resonates`, `unsure`, `disagree`, `unspecified`; omission becomes `unspecified`.
- At most 100 active notes per exact reading edition and 100 saved revisions per note, including creation.
- Retain prior saved revisions until whole-note, reading or account deletion; no individual old-revision delete UI.
- New notes require an explicitly saved parent. Active notes block unsaving; whole-reading deletion remains available.
- Chronological ascending `(createdAt, id)` pagination, default 20/max 50, with owner/auth-epoch/edition/order-bound cursors and independent authorization checks.
- Existing 20 MiB account admission estimate: encrypted UTF-8 bytes plus 1 KiB per owned row; reads/deletes remain available at capacity.
- Existing seven-day idempotency window; stop every automatic submission after that window and require explicit reconciliation/new intent.
- Notes work with AI off; no provider calls, context grants, generation quota use or persisted browser drafts.
- Old valid note ciphertext retains its AAD identity/date; unsaved legacy parents retain existing expiry, with no implicit saving.
- Use the approved disclosure verbatim. Preserve original readings, sources and reflections; retain notes on editorially withdrawn readings.
- All source/registry/generated artifacts change together. Never edit generated mirrors by hand.
- Work in a clean isolated checkout with no dotenv credentials for verification; use existing synthetic fixtures only. Keep production activation and physical-device claims separate.

## Review Focus

- Astral emoji, combining marks and whitespace-only input: count code points consistently and preserve exact authored text (Task 1 contract tests, Task 4 counter test).
- Lost acknowledgement followed by another edit or deletion: resolve the exact old revision, never resurrect erased text; stop expired-key automatic retries (Tasks 2–4).
- A note's interpretation is withdrawn while its owner is writing: retain the user's draft and annotations while showing unavailable generated content (Tasks 2 and 4).
- Recovery/logout-all or parent deletion between pages: reject stale auth/cursors and abort export before releasing a mixed/private snapshot (Tasks 2–3).
- Nonempty migration with import aliases and legacy notes on unsaved/expired parents: preserve ciphertext/FKs and original retention without consent expansion (Tasks 1 and 5).

---

## File and interface map

The five tasks are sequential integration boundaries; each receives a focused review before the next starts. Do not parallelize edits to shared contract/route/registry files. Service and privacy tasks may exercise direct services before public routes are enabled.

| Unit | Files and responsibility |
| --- | --- |
| Contract/storage | `src/contracts/index.ts`; new `src/contracts/revisit-policy.ts`; `checks/generate-openapi.ts`; new `src/worker/db/migrations/0017_revisit_notes.sql`; `src/worker/db/column-registry.json`; generated `docs/architecture/` artifacts |
| Key coverage | `src/worker/recovery/private-fields.ts`; existing registry-driven `account-rekey.ts`/`key-inventory.ts`; relevant inventory fixtures/checks |
| Record service | New `src/worker/readings/revisits.ts`; existing `base.ts`, `records.ts`, `routes.ts` |
| Privacy | `readings/export.ts`, `readings/erasure.ts`, `readings/erase-data.ts`; `recovery/cleanup.ts`, `recovery/restore.ts`, `recovery/ledger.ts`; `maintenance/retention.ts` |
| Client | New `src/client/revisit-notes.tsx`; existing `readings.tsx`, `style.css`, `deletion.tsx`, `api.ts`; copy in existing `src/contracts/product-copy.ts` |
| Tests | New contract, migration, service, privacy and browser suites named per task; extend existing storage/key/restore/journey fixtures rather than duplicate their harnesses |

Type names below are part of the handoff. Keep existing `Revisit` as the legacy decoder; introduce `RevisitV2`, `AnyRevisit = z.union([Revisit, RevisitV2])` and exported inferred `RevisitNote`. `apiSchemas.Revisit`/`RevisitPage.items` use V2 for new endpoints; portable `revisit.value` uses the explicit old/new union. `RevisitWrite` is `{editionId, note, stance?}`; `RevisitUpdate` is `{note, stance?}`. New responses always normalize to V2; archived/exported legacy decoding remains explicit.

### Task 1: Versioned note storage and complete encryption/accounting coverage

**Files:** Create `src/contracts/revisit-policy.ts`, `src/worker/db/migrations/0017_revisit_notes.sql`, `tests/domain/revisit-contracts.test.ts`, `tests/db/revisit-migration.test.ts`. Modify `src/contracts/index.ts`, `checks/generate-openapi.ts`, `src/worker/db/column-registry.json`, `src/worker/recovery/private-fields.ts`, `tests/db/storage-accounting.test.ts`, `tests/db/account-rekey.test.ts`, `tests/db/key-inventory.test.ts`, necessary existing registry fixtures and generated mirrors.

**Interfaces:**
- Produce `REVISIT_LIMITS = {textCodePoints: 2000, activePerEdition: 100, revisionsPerNote: 100, pageDefault: 20, pageMax: 50, idempotencyMs: 604800000}` and `revisitTextLength(text: string): number` from `revisit-policy.ts`.
- Produce `RevisitV2`/`RevisitNote` with `kind: 'revisit.v2'`, `id`, `sessionId`, `editionId`, `revision`, `note`, `stance`, `createdAt`, `updatedAt`; schemas above plus `RevisitUpdate`.
- Produce errors `NOTE_LIMIT_EXCEEDED`, `REVISION_LIMIT_EXCEEDED`, `STORAGE_LIMIT_EXCEEDED`, `DEPENDENTS_EXIST`. Extend `SessionRecord` with optional nullable `retentionExpiresAt`: old portable records may omit it, while the current session endpoint must return the actual database expiry (or null for saved parents).
- Schema: `revisits` retains current `note_enc` and `key_version`, adds `session_id`, `current_revision`, `updated_at`, `deleted_at`; null body requires deletion state. `revisit_revisions(revisit_id,owner_id,revision,body_enc,key_version,created_at,erased_at)` holds prior revisions with owner-qualified PK/FKs and nullable body only after erasure. Extend `deletion_jobs.scope` for `revisit` without changing existing ledger envelopes.

- [x] **Write failing contract/migration tests.** Pin assertions including:
  ```ts
  expect(revisitTextLength('😀'.repeat(2000))).toBe(2000);
  expect(apiSchemas.RevisitWrite.safeParse({editionId, note: '😀'.repeat(2000)}).success).toBe(true);
  expect(apiSchemas.RevisitWrite.safeParse({editionId, note: 'x'.repeat(2001)}).success).toBe(false);
  expect(apiSchemas.RevisitWrite.safeParse({editionId, note: ' \n\t'}).success).toBe(false);
  // Migration fixture assertions: byte-identical old note_enc, original dates/expiry,
  // preserved import_identities reference, revision 1, no FK errors, exact counters.
  ```
  Use `env.MIGRATION_DB` and `env.TEST_MIGRATIONS` to apply through 0016, insert valid encrypted saved/unsaved/expired-parent notes plus an import alias, then apply 0017. Keep invalid low-level crypto fixtures distinct from public legacy Revisit values.
- [x] **Run red:** `npm run test:domain -- tests/domain/revisit-contracts.test.ts` and `npm run test:db -- tests/db/revisit-migration.test.ts`. Expect missing new schemas/migration assertions to fail.
- [x] **Implement schemas and migration.** Preserve old `note_enc` bytes/AAD while deriving session only through the same-owner edition. Rebuild nullable columns/scope constraints with FK enforcement preserved; verify all imported links survive. Add ascending owner/edition/date/id index. Add body and row accounting triggers, recalculating estimates once without double-counting; all new private columns have registry policy/AAD. Register historical `body_enc` as record id `revisit_id:revision`; the existing current-body handler remains intact. Include the new schema in existing deployment/registry identity checks so older writer binaries cannot silently resume against changed key-registry state.
- [x] **Prove encryption/accounting coverage:** extend existing rekey/inventory cases with both current and archived note bodies; assert old-key references remain visible, round trips preserve plaintext and counter deltas include 1 KiB per row. Update bare legacy `INSERT INTO revisits VALUES(...)` fixtures to explicit column inserts. Run `npm run schemas`, `npm run check:registry`, `npm run check:schemas`, `npm run check:sql`, `npm run check:contracts`, `npm run check:openapi`, targeted tests above plus `npm run test:db -- tests/db/storage-accounting.test.ts tests/db/account-rekey.test.ts tests/db/key-inventory.test.ts`.
- [x] **Commit** the verified storage/contract slice with `feat: add versioned revisit note storage`; public create routes remain absent.

### Task 2: Authenticated note service with exact retries and bounded writes

**Files:** Create `src/worker/readings/revisits.ts`, `tests/db/revisit-records.test.ts`. Modify `src/worker/readings/records.ts` for unsave protection and `src/worker/readings/base.ts` only if a shared guard is necessary. Reuse `tests/fixtures/reading-client.ts`, `database.ts`, `barrier.ts` and existing record crypto.

**Interfaces:** Consume Task 1 schemas/constants and existing `RecordBase`, `Session`. Produce `class Revisits` with `constructor(base: RecordBase)`, `create(session: Session,input: RevisitWrite,key: string): Promise<RevisitNote>`, `read(session: Session,id: string,revision?: number): Promise<RevisitNote>`, `list(session: Session,editionId: string,cursor: string|null,limit?: number): Promise<RevisitPage>`, `update(session: Session,id: string,revision: number,key: string,input: RevisitUpdate): Promise<RevisitNote>`. Types for inputs/page are inferred from `apiSchemas`. Deletion is owned by Task 3.

- [x] **Write failing service tests.** Create saved parents with `ReadingClient`, then construct `RecordBase`/`Revisits` using the existing identity/session fixtures. Tests: `AI-off create preserves accepted reading and original reflection`; `exact old-revision retry after a later edit`; `100th active note succeeds and 101st fails`; `100th revision succeeds and 101st fails`; `parallel edit CAS leaves one archive`; `capacity rollback creates no note/idempotency row`; `cross-owner and mismatched edition are unavailable`; `withdrawal preserves existing notes but rejects new creation`; `unsaved legacy read/export eligibility uses original expiry`; `cursor rejects owner/epoch/edition/order changes`. Assert exact `RecordError.code`, remaining reading quota unchanged, and no network use.
- [x] **Run red:** `npm run test:db -- tests/db/revisit-records.test.ts`; expect missing Revisits behavior.
- [x] **Implement read/list normalization and guards.** Authenticated legacy decoding infers only revision 1, original date, parent session and unspecified stance. Read exact current versus archived revision; validate encrypted owner/id/edition/revision against columns. List uses ascending keyset and scope `['revisits', session.epoch, editionId, 'asc']`; apply owner-qualified SQL and final auth/parent/data-revision checks. A withdrawn edition's saved annotations stay accessible; expired/deleted parents do not. Populate `SessionRecord.retentionExpiresAt` from `reading_sessions.retention_expires_at` in the session reader, so the client displays actual legacy expiry rather than inferring it from creation time.
- [x] **Implement create/update atomically.** Seal current body under original AAD; an edit decrypts and reseals the prior value under historical AAD before one D1 batch inserts archive, CAS-updates current body, records `id:revision` idempotency and advances account revision. Recheck saved-parent/owner/key/version/limits inside the batch. Count only nondeleted notes; preserve all existing text/date/linkage. Classify limit/capacity errors with actionable typed errors after rechecking race winners; do not turn failed assertions into false success. Add unsave guard in `ReadingRecords.save` for active notes. Receipt replay reauthorizes and resolves exact historical revision.
- [x] **Run green:** targeted service tests plus `npm run test:db -- tests/db/reading-record-actions.test.ts tests/db/reading-interleavings.test.ts`; run typecheck. Ensure all failures roll back counters, archive rows, pointers and mutation receipts together.
- [x] **Commit** as `feat: implement revision-safe dated note service`; no client/create endpoint exposure yet.

### Task 3: Complete erasure, restore and export before enabling routes

**Files:** Modify `src/worker/readings/erasure.ts`, `erase-data.ts`, `export.ts`, `routes.ts`, `src/worker/recovery/cleanup.ts`, `restore.ts`, `ledger.ts`, `src/worker/maintenance/retention.ts`, `checks/generate-openapi.ts` and mirrors. Create `tests/db/revisit-privacy.test.ts`; extend `tests/db/privacy-restore.test.ts`/`privacy-erasure.test.ts` and existing retention/cleanup tests.

**Interfaces:** Extend `ErasureTarget` in `src/contracts/index.ts` with `{scope: 'revisit', subjectId, revisitId}` in the same task as all its consumers. Add `SessionErasure.removeRevisit(session: Session,id: string,revision: number,key: string,receipt: z.infer<typeof apiSchemas.DeleteRequest>): Promise<z.infer<typeof apiSchemas.DeletionReceipt>>`. Add `EraseData.revisit(job: {id: string},target: Extract<Target,{scope:'revisit'}>): Promise<void>` and dispatch the new target through existing live/replay/cleanup paths. Expose create/list/read/edit/delete routes exactly as specified using Task 2; `ReadingExports` emits portable `revisit` records for every current/nonerased historical revision.

- [x] **Write failing privacy tests.** Pin `DELETE stale revision yields 409 without fence`, `matching accepted receipt retries after session loss through receipt status`, `ledger outage fences note but leaves pending job`, `export yields every exact revision and no keys`, `edit or parent/account deletion invalidates a partially read export`, `note deletion spares neighboring notes`, `reading/account deletion erases both stores`, `restore before create/edit/delete cannot revive erased notes`, `withdrawn parent notes export`, and `expired legacy parent excluded`. Use existing snapshot and failing-R2 fixtures; assert two restore passes and completion deadlines never shorten.
- [x] **Run red:** `npm run test:db -- tests/db/revisit-privacy.test.ts`; expect missing target/export/routes failures.
- [x] **Implement durable note erasure and retention.** Queue validates current revision, marks whole note unavailable and advances account revision in one admission/fence batch. Reuse independent encrypted ledger intent/pass/completion and receipt verification. Null current/archive bodies after durable intent; detach any erased import alias using existing metadata conventions without enabling import/context routes. Parent/account deletion includes archived rows. Cleanup checks both stores and rejects pending jobs; remove content-free note shells only after their completed-job/tombstone retention boundary and references permit it. Retain current 30-day metadata policy and existing backup deadline calculation, never delete pending evidence. Replay understands the new target while preserving old encodings.
- [x] **Implement snapshot export.** Remove only the revisits term from the unsupported-family guard. Add current/archive union rows ordered by `kind,id,revision`, metadata with exact session/edition/dates, and decoding via Task 2's normalization semantics. Preserve 100-record/950,000-byte pages, 60-minute ticket/earliest-retention expiry, post-decrypt auth and `data_revision` rechecks. Parent/account deletion admission invalidates tickets immediately; downloaded prior bytes remain outside server control.
- [x] **Enable routes after the privacy tests pass.** Use existing CSRF/rate/session/recovery wrappers, `Idempotency-Key`, `If-Match`, ETags and deletion status. Add typed note-limit copy and safe precondition parsing. Update OpenAPI operations for read/edit/delete, chronological list/epoch cursor and errors; run `npm run schemas`.
- [x] **Run green:** new privacy tests and `npm run restore:rehearse`, `npm run cleanup:rehearse`, `npm run test:db -- tests/db/privacy-erasure.test.ts tests/db/reading-record-actions.test.ts`, `npm run check:openapi`, `npm run typecheck`. Commit as `feat: integrate note export and durable erasure`.

### Task 4: Dated notes within the existing reading journey

**Files:** Create `src/client/revisit-notes.tsx`, `tests/browser/revisit-notes.spec.ts`. Modify `src/client/readings.tsx`, `style.css`, `src/contracts/product-copy.ts`, existing `tests/fixtures/browser-journey.ts`, `tests/browser/journey-layout.spec.ts` and `journey-forced-colors.spec.ts` as needed.

**Interfaces:** Export `RevisitNotesHandle {hasUnsavedChanges(): boolean}` and `RevisitNotes` React component with props `{ref?, sessionId: string, editionId: string, saved: boolean, parentExpiresAt: string|null, csrfToken: string, onExpired: () => void, onChanged: () => void}`. The workspace supplies `parentExpiresAt` from the fresh session response, never a guessed expiry. The component owns note list/editor/receipt state; the workspace queries its ref in existing `confirmLeave`, Back/reload and navigation guards, and unmounts it with private account state. Consume existing `api`, `ApiFailure`, `deletionIntent`/`DeletionReceiptPanel`; do not build alternate transport/auth logic.

- [ ] **Write failing browser journey tests.** Add two notes with controlled server-time fixtures and distinct dates, verify ordering and original reading/reflection equality; edit while AI off; preserve draft through offline failure and 409; deletion with current versus stale revision; export current/history; sign-out/in and downloaded-kit recovery reopen the same notes. Assert single create after a lost response, no new automatic POST after advancing the attempt clock seven days, 2,000-emoji counter alignment, and zero provider requests from note actions.
- [ ] **Run red:** `npm run test:browser -- tests/browser/revisit-notes.spec.ts`; expect missing controls/states.
- [ ] **Build the focused component.** Render the section after the original reflection, chronological pages, local `<time>` dates and separate edited timestamp. Text/stance/Save note/Cancel order, exact disclosure, deterministic focus and status announcements. Preserve failed/conflicting drafts in memory; refresh shows latest saved content separately, then a deliberate save uses that revision. Reuse one idempotency key and attempt time per unchanged intent; after seven days stop same/new-key automatic retry and require list reconciliation. Display actual legacy expiry and require explicit parent save before editing it. Include complete whole-note deletion confirmation and receipt.
- [ ] **Integrate workspace lifecycle and unavailable-reading state.** Extend all existing dirty-draft/Back/Account/reload checks; don't overwrite the parent's existing `confirmLeave` protections. Suppress late responses after unmount/account/edition changes. Keep notes visible for a saved withdrawn reading using its exact session/edition identity even when accepted-reading rendering is unavailable. Use existing saved-parent controls; do not silently save a parent or issue generation requests.
- [ ] **Run green and refresh layout evidence:** targeted browser tests, existing reading/privacy navigation tests, `npm run test:journey` with note empty/populated/edit/conflict/deletion states added to the existing four-width/two-theme harness. Verify enlarged text, supported forced colors, focus, full disclosures, no horizontal overflow and screenshots. Commit as `feat: add dated revisit note interface`.

### Task 5: Whole-feature lifecycle qualification and delivery evidence

**Files:** Extend relevant new revisit tests plus `tests/db/account-rekey.test.ts`, `key-inventory.test.ts`, `hosted-restore.test.ts`, `recovery-cleanup.test.ts`, `tests/browser/revisit-notes.spec.ts`; update `docs/design/dated-revisit-notes.md`, `design-qa.md`, `docs/MILESTONE_2_ACCEPTANCE.md`, relevant privacy/runbook docs and new dated verification receipts.

**Interfaces:** Consume Tasks 1–4 only; produce completed local verification and comparison evidence bound to the final source. Existing synthetic-hosted fixture coverage remains distinct from an actual hosted deployment/drill.

- [ ] **Add remaining failing integration cases before fixes.** Interrupt account rekey between current/archive versions and resume; show inventory blocks retiring every referenced old key. Race parent deletion/key epoch against note edit and in-flight export; prove no plaintext escapes after final guard. Exercise a nonempty migration with valid encrypted legacy note/import linkage and a second stale restore after deletion. Assert tombstone cleanup preserves pending ledger state and accurate storage at/above 20 MiB; deletion remains usable there.
- [ ] **Run targeted red tests**, then make only fixes needed to satisfy the approved contract. Run affected privacy/key/storage/browser tests until green. Have reviewers explicitly trace create → edit → export → erase → stale restore across both current/history stores.
- [ ] **Update feature docs and comparisons.** Mark only implemented/verified acceptance items complete, record new migration and rollback compatibility, copy and exact limits, seven-day retry limitation, legacy retention behavior, test scope and remaining device/hosting gaps. No application data, kit contents, tokens or plaintext private records enter evidence.
- [ ] **Freeze and verify the final candidate:** `npm run verify` (all 14 stages) and `npm run test:journey`. Expect exit 0, no skipped/unexpected/flaky tests and fresh source-matched receipt. Run `npm run release -- --check` against that receipt; pending production gates are expected and do not prevent local feature completion. Do not rewrite old receipts; new changes after verification require appropriate fresh checks.
- [ ] **Commit** completed source/docs as appropriate, publish reviewable evidence, and perform the whole-branch review. Push the feature branch and open/update its PR with exact test counts and limitations. Use the user's existing implementation authorization to complete normal review/fix workflow; a new production deployment/paid evaluation decision is outside this plan.

## Self-review record

- Spec coverage: contracts/legacy decoding/limits → Tasks 1–2; saved-only and withdrawn-parent behavior → Tasks 2/4; encryption/accounting/rekey/migration → Tasks 1/5; idempotency/concurrency/cursors → Tasks 2–4; export/erasure/restore/retention → Tasks 3/5; interface/copy/accessibility → Task 4; evidence/delivery → Task 5.
- Interface consistency: service methods and schema/type names are defined before consumers; Task 3 owns whole-note deletion, Task 4 uses the existing HTTP/deletion helpers. Task 2 cannot expose new public creation before Task 3 closes export/erasure.
- Five review-focus cases each have named tests in their owning task. No product scope, approval condition or production gate has been added.
- Execution uses sequential subagent implementation/review, with isolated synthetic verification and commits at each meaningful boundary. The approved contract is the behavior authority; routine helper/component details remain the implementer's judgment.
