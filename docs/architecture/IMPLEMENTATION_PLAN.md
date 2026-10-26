# Dependency-ordered implementation and rollout gates

No dates, staffing estimates, deployed resources or completed model qualification are implied. Implement a new repository/codebase; the package is a specification, not a partially implemented product. An owner may authorize later work separately. GitHub Actions remains unavailable.

## Milestone 1 — local contracts and deterministic proof, synthetic only

Deliverables: initialize strict TypeScript/Hono/React/Vite/Zod project, exact lockfile/runtime date, import authoritative schemas and generated OpenAPI/model schema, proposed D1 migration/registry, tarot draw/plan/fact renderer, approved-status synthetic canon fixtures, intercepted WritingProvider, leases/assertion publication prototype, repository `npm run verify` and release wrapper definition. Local SQLite + workerd D1 harness uses actual migrations/guard, fake time/randomness/network, malicious/benign corpus fixtures. No real credentials/data/paid inference, no production resources.

Acceptance: strict contracts parse, generated schema drift fails, registry catches a new private column, approved content with null review fails; owner FKs and quota bounds fail correctly; stale lease/permission/source/parent-content/key changes abort the entire publication batch; duplicate intent produces one request/dispatch/publication; all synthetic privacy markers stay within selection; deterministic composition uses exact same plan as model projection; source citations make only their stated guarantee. Gate completes under proposed9-minute deadline locally/hosted-image-equivalent measurements recorded. Outcomes from CHECK_RESULTS here are initial artifact checks, not completion of this milestone's application implementation.

## Milestone 2 — first real-user slice

Dependencies: milestone1, stable domain/RP ID, exact runtime and library compatibility, minimal reviewed/cleared launch canon, provider privacy/access/pricing confirmation. Build identity/recovery and checkpoint saga, server-readable encryption/index keys/write fences, same-origin sessions/CSRF, requests/quotas/spend/guarded publication, precise reading+basis/source UI, separately authored reflection+save/reopen, export/deletion and erasure ledger, accessible interruption/conflict/offline states. Implement default templates and non-reading outcomes with human-reviewed English copy. Global generation starts disabled.

Rollout gates **before any real private persistence/provider egress**: working identity/ownership/privacy/export/delete; passkey/recovery/CSRF/cross-owner checks; intercepted egress proof; approved content/rights; bounded provider qualification under explicit separate authorization; hosted main failing-test proof and preview separation; D1 hosted batch/race proof; actual synthetic restore with erased record, used recovery code, removed credential and pre-dispatch bookmark; monitored pending jobs/erasure/security saga/spend; runbooks including incident, deletion lag and key recovery; manual keyboard/screen-reader/mobile/a11y checks. Owner selects geography/age policy and accepts budgets. Private pilot uses real identity/data only after all applicable gates; “small pilot” does not waive privacy obligations.

Pilot conditions: invitations/limited admission only if implemented as an explicit policy (not assumed user count), or low published admission limits; no production content sampling; capture content-free metrics and opt-in product interviews. Increase exposure only after measured latency/fallback/cost and support burden fit operator budget. Revert to saved-record read/write and disabled dispatch on incident; do not delete data to roll back a feature.

## Milestone 3 — completed v1

Add keyset history and deliberate revisits, exact-parent follow-ups and source grants/list/preview/revoke, context-copy erasure, canonical/tarot selected legacy imports and aliases, portable metadata/tombstone export and import round trips. P exports may be preserved as unverified structured legacy records using the bounded adapter; native X adapter remains explicitly unsupported until its schema is inspected and fixtures added. Real legacy access is unnecessary: synthetic/versioned export fixtures prove behavior first.

Acceptance: all R10/R11 cases, parent A/new content B withdrawal race, old reflection supersession, missing-provenance import, per-group partial failure and exact re-import idempotency; no automatic biography or permission restoration; history resumes pending sessions with nullable edition IDs; long permission/grant history exports page-by-page; deletion removes raw imported copies; current state and public error messages align. Repeat hosted restore proof only if schema/key/lifecycle changes affect it. Qualify selected-context prompt variant independently before enabling follow-ups.

## Milestone 4 — later methods and commercial features

Astrology requires owner scope decision, exact calculation-engine/dependency licensing, service boundary and credentials, uncertainty/time-zone/fold/interval fixtures, source/editorial qualification and new model schema/validators. Billing requires separate entitlement/subscription reconciliation design, no retrofit of v1 provider cost as invoices. MCP requires explicit auth/scopes and adapter over existing services. Check-ins, narration, recognition, coaching, Time Travel, astrocartography and portraits only acquire storage/egress/schema resources for concrete accepted requirements. No unused services or endpoint scaffolding in v1.

## First-slice module map

| Planned files | Deliverable / dependency |
|---|---|
| `src/contracts/index.ts`, `src/contracts/provider.ts` | Move authoritative Zod definitions, inferred types and schema projection; no duplicated handwritten DTOs. |
| `src/worker/index.ts`, `http/app.ts`, `http/errors.ts`, `http/security.ts` | Hono + fetch/scheduled handlers, error envelope/body limits/origin/CSP/cookies. |
| `src/worker/identity/passkeys.ts`, `sessions.ts`, `recovery.ts` | Maintained library verification, challenge CAS, stable subject and factor recovery; use security checkpoint service. |
| `src/worker/crypto/envelope.ts`, `keys.ts`, `registry.ts` | AES-GCM AAD/key/index-key policy and field coverage. |
| `src/worker/db/queries.ts`, `guards.ts`, `migrations/0001.sql` | Direct D1 statements/assertions; schema here becomes authoritative migration; docs schema generated/checksummed from it after implementation. |
| `src/domain/tarot/draw.ts`, `facts.ts`, `plan.ts`, `render.ts` | Pure domain contracts/deterministic mechanics; no provider or SQL. |
| `src/domain/validation/candidate.ts`, `claims.ts`, `input.ts` | Closed schema/domain checks, bounded heuristic category analyzer and safe outcomes. |
| `src/worker/services/generation.ts`, `reflections.ts`, `exports.ts`, `deletion.ts` | Ownership, idempotency, CAS and atomic application services. |
| `src/worker/provider/openai.ts`, `src/worker/jobs/driver.ts`, `scheduled.ts` | Single egress interface and durable recovery, no hidden retry. |
| `src/worker/recovery/ledger.ts`, `security-checkpoint.ts`, `restore.ts` | D1/R2 sagas and operator-only restore procedure; no public restore endpoint. |
| `src/client/routes/`, `components/`, `api.ts`, `state.ts`, `service-worker.ts` | USER_EXPERIENCE route/component states; private memory-only state, static-cache allowlist. |
| `content/editions/`, `content/manifests/` | Hash-bound source/copy/deck approval and rights evidence; optional cleared art. |
| `tests/domain/`, `tests/db/`, `tests/privacy/`, `tests/browser/`, `tests/fixtures/` | Traceable A01–A18 checks/corpus and barriers, synthetic provider. |
| `scripts/verify.ts`, `release.ts`, `content-activate.ts`, `restore-check.ts` | Reproducible gates and constrained operator procedures, settings fingerprints and receipts. |

When implementation starts, move specification schemas/SQL into planned authoritative source locations and make docs reference/generated projections; do not keep two independently edited copies. Choose exact dependency versions from compatible current releases and record them in lockfile. Resolve external IDs/secrets through environment provisioning, never commit fabricated values. First action is milestone1's contract/schema/intercepted-provider harness, not deployment or legacy migration.
