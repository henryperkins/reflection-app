# Saved-reading return journey: local implementation evidence

Scope: the application checkout on `codex/milestone-2-saved-reading`, based on the completed identity/recovery slice at `13125ae`. The merged architecture and accepted Milestone 1 evidence remain historical baselines. Milestone 2 and deployment remain open/disabled respectively.

## Implemented journey

1. A separately enabled local simulated writer creates one accepted tarot artifact. Start requires current AI permission and acknowledgement of a complete recovery kit; it discloses 24-hour temporary processing/recovery storage.
2. Save reading retains the existing question, text, cards and source/provenance snapshot without a reflection. It creates no empty reflection, preserves any draft in browser RAM, and does not change AI permission.
3. After logout/login, the dated saved list opens that same artifact. Reopening performs no generation request, simulated dispatch or quota consumption.
4. Browser acceptance removes the old virtual authenticator, clears original origin storage, closes the original page and opens a fresh context. Only the downloaded handle and an unused code begin recovery. A replacement passkey and replacement complete kit lead back to the same subject and saved reading. Exact reading JSON and rendered text match before and after recovery.
5. Turning off AI permission leaves history/reopening, reflection creation/editing, export and deletion available. New generation is blocked server-side and disabled in the UI. Authored reflection revisions never rewrite the accepted reading.

These are local synthetic proofs for the five agreed MVP behaviors, not a declaration that every Milestone 2 or real-user acceptance gate is complete.

## Storage and authorization

- Uses existing registered D1 fields and existing wire contracts; no schema migration or unregistered personal field was added.
- Per-account DEK encrypts bodies with fresh AES-GCM nonces and exact environment/table/column/owner/record/revision/version AAD. Stable account index-key HMACs bind private request/idempotency payloads. Identity recovery preserves those same keys.
- Owner-qualified reads and commit-time authentication/epoch/permission/CAS checks protect every operation. Exact accepted text is decrypted and returned; it is not re-rendered or generated on reopen.
- Default saved history uses bounded dated keyset pagination and authenticated cursors. Unsaved access stops at the database-clock retention deadline; scheduled maintenance fences and erases expired unsaved content.
- Reflection saves append immutable revisions and atomically keep the parent reading. Conflicting browser edits retain the local draft and display the current saved text.
- Export requires recent authentication, uses a 60-minute revision-bound ticket, and emits at most 100 records / under 1 MiB per page. The client downloads NDJSON only after all pages succeed. Account revision, authentication and record availability are checked again after decryption. Exports contain owned reading/reflection/permission/generation records and credential metadata, never recovery factors, bearer tokens or account keys.
- Session deletion first fences access, records an immutable independently encrypted R2 intent and authenticated pass, erases active private copies, then writes the completion. An R2 interruption leaves the deletion pending and inaccessible; scheduled maintenance resumes it. Consumed quota is not refunded. The receipt uses a scoped random token whose keyed verifier alone is persisted. Conservative 30-/45-day backup/ledger deadlines do not prove a hosted restore or backup purge.
- Browser private state stays in RAM. Logout, account invalidation and unmount invalidate delayed responses. Save does not silently persist a reflection draft. Browser acceptance checks localStorage, sessionStorage, IndexedDB and Cache Storage remain empty.

## Verification recorded before independent review

`npm run verify` passed all 13 stages and **173 executed tests** (82 domain/tooling, 83 actual D1, 8 Chromium browser tests), zero skipped, in **23.99 seconds** on Node 26.12.1. This is a recorded run; `artifacts/verify.json` contains the current source digest and measured duration of the latest complete run. `npm run release -- --check` returned `deploymentAllowed: false`.

Browser plugin not available; used the existing Playwright workflow at `http://localhost:8787`, Chromium virtual authenticators, 1100×850 desktop and 390×844 mobile viewports. The complete interaction passes with no page errors or outbound browser requests. Desktop/mobile screenshots were inspected outside the repository at `/tmp/reflection-saved-reading-desktop.png` and `/tmp/reflection-saved-reading-mobile.png`; no horizontal overflow was observed. These are functional layout checks, not full browser/device/accessibility qualification.

Additional fault/interleaving evidence:

- Consent revoked immediately before dispatch or publication blocks the result and releases held quota exactly once.
- Authentication expiring after reflection encryption rolls the write back.
- New retry-key aliases cannot be reused to generate another reading; concurrent deletion retries join one durable job.
- Unsaved expiry after decryption prevents both a reading response and an export page from releasing the expired content.
- Export changes after decryption return `EXPORT_CHANGED`; pages/cursors remain bounded and scoped to the owner/ticket.
- Cross-account access and ciphertext field transplantation fail; R2 interruptions remain fenced until maintenance completes.
- Browser save-with-draft, stale-reflection conflict and delayed-response-after-sign-out tests pass.

The first browser build uncovered a Worker bundling issue: importing common SQL helpers also imported a Vite-only raw SQL module. Common helpers now live in `db/core.ts`; the existing prototype retains its publication-guard module. The actual browser build and Worker dry-run both pass.

## Review and remaining gates

Independent review is pending for this implementation; its findings and dispositions will be recorded here before handoff.

This slice is explicitly gated by `READING_MODE=synthetic-local` and the existing localhost identity configuration. Its catalog contains labeled synthetic approval fixtures, and its writer never invokes a transport or external provider. Simulated dispatch rows retain the proposed provider/model contract values with `syntheticOnly:true`, `externalCall:false`, and returned model `synthetic-local-writer.v1`; they are not evidence of an actual OpenAI call, provider compatibility, quality, safety or cost. Local accepted simulations consume the local product allowance so return journeys can verify it does not change.

Intentional scope boundaries:

- Follow-ups, selected context/grants, imports, revisits, account-wide deletion, credential add/remove settings and the complete generation recovery pipeline remain separate work. Unsupported routes fail closed. Local exports/deletion also refuse unsupported imported/context families rather than silently omitting them or claiming complete erasure.
- Production keys/configuration, provider and editorial qualification, broader lifecycle/retention cleanup, operational alerts, full restore/replay and ledger/key rotation/purge remain open. The local session-erasure implementation handles its first live pass; it is not the offline multi-pass restore executor.
- Physical/synchronized authenticators, Safari/Firefox, full keyboard/screen-reader/a11y acceptance, hosted resource isolation and release failure proofs remain unqualified.
- Default Worker private routes remain disabled without explicit local configuration. No live inference, push, PR, merge, hosting change or deployment occurred.

The branch stays local for review and the next Milestone 2 integration.
