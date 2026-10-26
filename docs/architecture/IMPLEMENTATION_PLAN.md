# Dependency-ordered implementation and rollout gates

No dates, staffing estimates, deployed resources or completed model qualification are implied. Implement a new repository/codebase; the package is a specification, not a partially implemented product. An owner may authorize later work separately. GitHub Actions remains unavailable.

## Milestone 1 — local contracts and deterministic proof, synthetic only

Deliverables: initialize strict TypeScript/Hono/React/Vite/Zod project, exact lockfile/runtime date, import authoritative schemas and generated OpenAPI/model schema, proposed D1 migration/registry, tarot draw/plan/fact renderer, approved-status synthetic canon fixtures, intercepted WritingProvider, leases/assertion publication prototype, repository `npm run verify` and release wrapper definition. Local SQLite + workerd D1 harness uses actual migrations/guard, fake time/randomness/network, malicious/benign corpus fixtures. No real credentials/data/paid inference, no production resources.

Acceptance: strict contracts parse, generated schema drift fails, registry catches a new private column, approved content with null review fails; owner FKs and quota bounds fail correctly; stale lease/permission/source/parent-content/key changes abort the entire publication batch; duplicate intent produces one request/dispatch/publication; all synthetic privacy markers stay within selection; deterministic composition uses exact same plan as model projection; source citations make only their stated guarantee. Gate completes under proposed9-minute deadline locally/hosted-image-equivalent measurements recorded. Outcomes from CHECK_RESULTS here are initial artifact checks, not completion of this milestone's application implementation.

Deadline proof uses the database execution clock in dispatch/publication assertions and final state updates. Delay SQL past lease/absolute expiry after the worker's eligibility sample and verify the whole batch rolls back; equality is expired. A Worker abort or late acknowledgement never substitutes for that database predicate.

## Milestone 2 — first real-user slice

Dependencies: milestone1, stable domain/RP ID, exact runtime and library compatibility, minimal reviewed/cleared launch canon, provider privacy/access/pricing confirmation. Build identity/recovery and checkpoint saga, a downloadable kit with both recovery handle and codes, server-readable encryption/index keys/write fences, same-origin sessions/CSRF, requests/quotas/spend/guarded publication, precise reading+basis/source UI, distinct Save reading with optional reflection add/edit, a simple dated Saved readings list, exact reopening, export/deletion and erasure ledger, and accessible interruption/conflict/offline states. Disclose Start's 24-hour processing/recovery storage separately from Save's retention until deletion and AI permission. With AI permission declined/revoked, preserve owned saved-record actions and deny new generation or consent-bypassing fallback. Implement default templates and non-reading outcomes with human-reviewed English copy; describe encryption as server-readable, not end-to-end. Global generation starts disabled until the gates pass. Follow-ups, selected-context controls, imports, and separate dated revisit notes remain milestone3.

Implement SECURITY_RESTORE's independent encrypted targets and immutable pass/completion chain before the restore exercise. Include missing D1 jobs, exact revision erasure, retained older keys and repeated restore extending deadlines; pending passes prohibit cleanup.

Rollout gates **before any real private persistence/provider egress**: working identity/ownership/privacy/export/delete; passkey/recovery/CSRF/cross-owner checks; intercepted egress proof; approved content/rights; bounded provider qualification under explicit separate authorization; hosted main failing-test proof and preview separation; D1 hosted batch/race proof; actual synthetic restore with erased record, used recovery code, removed credential and pre-dispatch bookmark; monitored pending jobs/erasure/security saga/spend; runbooks including incident, deletion lag and key recovery; manual keyboard/screen-reader/mobile/a11y checks. Owner selects geography/age policy and accepts budgets. Private pilot uses real identity/data only after all applicable gates; “small pilot” does not waive privacy obligations.

First-slice product acceptance: Start displays its temporary-storage disclosure; an unsaved reading follows the 24-hour recovery deadline, while an explicitly saved reading remains after that window. Save reading succeeds with no reflection and does not submit an optional editor draft. Sign out, sign in, use the dated Saved readings list to find the entry, and reopen the exact accepted text with no new model call; add/edit the reflection afterward. Repeat history/reopen/reflection/export/delete with AI permission declined/revoked, and prove that new generation and fallback cannot bypass the missing permission. Download the recovery kit, clear all browser state and make the original passkey unavailable, then use the kit's handle plus one unused code through the existing recovery flow to enroll a new passkey and find the saved reading again. These are required browser/contract checks to implement, not results claimed by this specification.

Pilot conditions: invitations/limited admission only if implemented as an explicit policy (not assumed user count), or low published admission limits; no production content sampling; capture content-free metrics and opt-in product interviews. Increase exposure only after measured latency/fallback/cost and support burden fit operator budget. Revert to saved-record read/write and disabled dispatch on incident; do not delete data to roll back a feature.

## Milestone 3 — completed v1

Extend the existing basic saved-reading list with separate dated revisit-note workflows, exact-parent follow-ups and source grants/list/preview/revoke, context-copy erasure, canonical/tarot selected legacy imports and aliases, portable metadata/tombstone export and import round trips. Do not defer ordinary saved-reading discovery, reopening or reflection edits to this milestone. P exports may be preserved as unverified structured legacy records using the bounded adapter; native X adapter remains explicitly unsupported until its schema is inspected and fixtures added. Real legacy access is unnecessary: synthetic/versioned export fixtures prove behavior first.

Acceptance: all R10/R11 cases, parent A/new content B withdrawal race, old reflection supersession, missing-provenance import, per-group partial failure and exact re-import idempotency; no automatic biography or permission restoration; history resumes pending sessions with nullable edition IDs; long permission/grant history exports page-by-page; deletion removes raw imported copies; current state and public error messages align. Repeat hosted restore proof only if schema/key/lifecycle changes affect it. Qualify selected-context prompt variant independently before enabling follow-ups.

Implement stable source identities across chunks/exports, confirmed revision conflict recovery and explicit new-namespace re-import after erasure. Preserve full imported questions while history returns questionPreview/questionTruncated; verify the longer-than500-unit round trip and detached alias tombstones.

## Milestone 4 — later methods and commercial features

Astrology requires owner scope decision, exact calculation-engine/dependency licensing, service boundary and credentials, uncertainty/time-zone/fold/interval fixtures, source/editorial qualification and new model schema/validators. Billing requires separate entitlement/subscription reconciliation design, no retrofit of v1 provider cost as invoices. MCP requires explicit auth/scopes and adapter over existing services. Check-ins, narration, recognition, coaching, Time Travel, astrocartography and portraits only acquire storage/egress/schema resources for concrete accepted requirements. No unused services or endpoint scaffolding in v1.

## First-slice module map

| Planned files | Deliverable / dependency |
|---|---|
| `src/contracts/index.ts`, `src/contracts/provider.ts` | Move authoritative Zod definitions, inferred types and schema projection; no duplicated handwritten DTOs. |
| `src/worker/index.ts`, `http/app.ts`, `http/errors.ts`, `http/security.ts` | Hono + fetch/scheduled handlers, error envelope/body limits/origin/CSP/cookies. |
| `src/worker/identity/passkeys.ts`, `sessions.ts`, `recovery.ts` | Maintained library verification, challenge CAS, stable subject and existing handle-plus-code recovery; provision both factors for the downloadable kit and use the security checkpoint service. |
| `src/worker/crypto/envelope.ts`, `keys.ts`, `registry.ts` | AES-GCM AAD/key/index-key policy and field coverage. |
| `src/worker/db/queries.ts`, `guards.ts`, `migrations/0001.sql` | Direct D1 statements/assertions; schema here becomes authoritative migration; docs schema generated/checksummed from it after implementation. |
| `src/domain/tarot/draw.ts`, `facts.ts`, `plan.ts`, `render.ts` | Pure domain contracts/deterministic mechanics; no provider or SQL. |
| `src/domain/validation/candidate.ts`, `claims.ts`, `input.ts` | Closed schema/domain checks, bounded heuristic category analyzer and safe outcomes. |
| `src/worker/services/generation.ts`, `reflections.ts`, `exports.ts`, `deletion.ts` | Ownership, idempotency, CAS, explicit save and basic saved-list/read services; own reflection/export/delete operations remain independent of AI permission. |
| `src/worker/provider/openai.ts`, `src/worker/jobs/driver.ts`, `scheduled.ts` | Single egress interface and durable recovery, no hidden retry. |
| `src/worker/recovery/ledger.ts`, `security-checkpoint.ts`, `restore.ts` | D1/R2 sagas and operator-only restore procedure; no public restore endpoint. |
| `src/client/routes/`, `components/`, `api.ts`, `state.ts`, `service-worker.ts` | First-slice USER_EXPERIENCE states: dated Saved readings, distinct reading/reflection saves, AI-off access, and complete recovery kit; private memory-only state and static-cache allowlist. Later feature controls stay absent. |
| `content/editions/`, `content/manifests/` | Hash-bound source/copy/deck approval and rights evidence; optional cleared art. |
| `tests/domain/`, `tests/db/`, `tests/privacy/`, `tests/browser/`, `tests/fixtures/` | Traceable A01–A18 checks/corpus and barriers, synthetic provider. |
| `scripts/verify.ts`, `release.ts`, `content-activate.ts`, `restore-check.ts` | Reproducible gates and constrained operator procedures, settings fingerprints and receipts. |

When implementation starts, move specification schemas/SQL into planned authoritative source locations and make docs reference/generated projections; do not keep two independently edited copies. Choose exact dependency versions from compatible current releases and record them in lockfile. Resolve external IDs/secrets through environment provisioning, never commit fabricated values. First action is milestone1's contract/schema/intercepted-provider harness, not deployment or legacy migration.
