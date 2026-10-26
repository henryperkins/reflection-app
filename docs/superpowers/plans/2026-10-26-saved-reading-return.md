# Saved-reading return journey implementation plan

> **For agentic workers:** Use superpowers:executing-plans. The user has authorized this integration against the merged architecture; execute locally without another design approval round.

**Goal:** Save without a reflection, return through sign-in or complete kit recovery, reopen identical content, and keep personal-record operations usable with AI permission off.

**Architecture:** Extend the existing localhost-only application with account-key encrypted records and owner-qualified routes. Use an explicitly simulated local writing adapter; no live provider, production configuration, deployment, or editorial approval is enabled. Read and export stored accepted artifacts; never regenerate on retrieval.

**Tech stack:** Existing TypeScript, Hono, D1/R2, Web Crypto, React, Vitest Workers and Playwright.

**Spec:** `docs/architecture/USER_EXPERIENCE.md`, `DATA_LIFECYCLE.md`, `PRIVACY_OPERATIONS.md`, `SECURITY_RESTORE.md`, authoritative contracts and DDL in `src/`.

## Global constraints

- Carry all five MVP requirements forward; record evidence only for implemented local behaviors.
- Account DEK encrypts personal bodies with field/owner/record/revision/version AAD. Index-key HMACs identify private payloads. No plaintext personal columns or browser persistence.
- Start discloses 24-hour temporary processing/recovery storage. Save retains until deletion, requires no reflection, and cannot imply AI consent.
- AI permission defaults false and blocks all new generation including templates. Existing records, reflections, export and deletion remain accessible.
- Accepted reading text, cards and source/provenance are immutable. Recovery retains the same subject and data keys.
- Owner authorization and execution-time session/epoch/CAS checks guard writes. Revision changes invalidate exports. All private responses are no-store.
- Explicit local configuration only. Synthetic content/writer labels remain visible; full production privacy, provider, restore and browser qualification stay open.

## Review focus

1. A stale response after logout/recovery/account switch must not repopulate private UI state.
2. Parallel retries, stale revisions and expired authentication must not duplicate content, overwrite reflections or charge quota twice.
3. Consent revocation during preparation/publication must block publication and release held quota; historical reads must still work.
4. Export concurrent with edits/deletion must fail clearly instead of mixing snapshots or leaking erased data.
5. Interrupted deletion must stay inaccessible and resume from an immutable independent ledger intent before reporting completion.

### Task 1: Encrypted reading records and local generation

**Files:** Create `src/worker/readings/{crypto,base,local-content,generation,records,routes}.ts`; integrate Worker, session summary and local config; create `tests/fixtures/reading-client.ts` and `tests/db/readings.test.ts`.

**Interfaces:** Consumes existing IdentityService sessions, account keys and wire contracts. Produces owner-qualified `ReadingRecords` and `LocalGeneration` operations; `/requests`, `/sessions`, `/sessions/:id`, `/sessions/:id/save`, `/readings/:id`, `/permissions/model`.

- [ ] Add HTTP/D1 tests: permission gate before persistence; acknowledged kit required; create/save without reflection; exact stored artifact survives logout/login/recovery; no additional requests/dispatches/quota consumption on read; ciphertext owner/field binding; retry joins and stale CAS fails; temporary expiration and indexed dated pagination.
- [ ] Run `npm run test:db -- tests/db/readings.test.ts`; expect missing-route failures before implementation.
- [ ] Implement account encryption, guarded operations, local simulated generation with unique dispatch and quota accounting, history/save/reopen and permission CAS.
- [ ] Run the targeted tests and `npm test`; expect all pass. Commit this deliverable locally.

### Task 2: Reflections, export and session deletion

**Files:** Add `src/worker/readings/{reflections,export,erasure}.ts`; extend routes, maintenance and D1 tests.

**Interfaces:** Reuses Task 1 record crypto/authorization. Existing Reflection, ExportTicket/ExportPage and DeletionReceipt contracts; append-only reflection revisions, snapshot export tickets and session-scope erasure intent/pass/completion in R2.

- [ ] Add failing tests: consent-off add/edit preserves reading; conflicts preserve current revision; foreign owner denial; export includes exact content and reflection revisions without credentials/secrets; concurrent edits invalidate ticket; deletion removes private bodies and reads, preserves quota consumption, retries after R2 failure resume safely.
- [ ] Run targeted tests; expect unimplemented-operation failures.
- [ ] Implement optional reflection writes, bounded export pages and durable local session deletion; schedule expiration/deletion maintenance. Explicitly reject unsupported follow-ups/context/imports instead of silently dropping them.
- [ ] Run targeted tests and `npm test`; expect all pass. Commit locally.

### Task 3: User journey and browser acceptance

**Files:** Add `src/client/readings.tsx`; extend API helper/identity integration/styles; add `tests/browser/readings.spec.ts`; document local results and remaining gates.

**Interfaces:** SessionView and existing identity invalidation own the lifetime of private reading UI; all reading actions use established wire contracts and mutation headers.

- [ ] Add a browser test for the user's five-step sequence with an actual fresh browser context, unavailable old authenticator and replacement passkey. Assert identical JSON/text/cards/sources, no new generation request, unchanged quota, download content, edit and deletion with consent off.
- [ ] Add interruption tests for stale private responses and retention of unsaved reflection drafts after Save reading/conflict. Run browser tests; expect missing UI controls.
- [ ] Implement concise storage/AI consent copy, dated history, immutable reader, separate Save reading and Save reflection, consent-off controls, explicit export/deletion and lifecycle clearing.
- [ ] Run browser tests, inspect desktop/mobile screenshots, run `npm run verify` and `npm run release -- --check`; expect a green local receipt and deploymentAllowed=false.
- [ ] Record exact evidence, limitations and review outcome. Commit locally; keep branch unpushed.

## Final review

Fresh reviewer checks the whole change from `13125ae`. Fix material findings with reproducing tests and run the complete gate. Preserve accepted Milestone 1 and identity evidence; do not declare Milestone 2 or launch complete.
