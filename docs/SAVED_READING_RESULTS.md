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
- Reflection saves append immutable revisions and atomically keep the parent reading. Conflicting browser edits retain the local draft and its base revision, display the current saved text/revision/stance, and require explicit reconciliation before saving. Focus refresh cannot silently rebase a draft. Leaving a dirty reflection for history or a new reading requires a local stay/discard choice.
- Export requires recent authentication, uses a revision-bound ticket lasting at most 60 minutes and no longer than the earliest unsaved-record retention deadline in its entire snapshot, and emits at most 100 records / under 1 MiB per page. The client downloads NDJSON only after all pages succeed. Account revision, authentication and record availability are checked again after decryption. Crossing the retention boundary between pages returns `EXPORT_CHANGED` instead of silently omitting remaining records. Exports contain owned reading/reflection/permission/generation records and credential metadata, never recovery factors, bearer tokens or account keys.
- Session deletion first fences access, records an immutable independently encrypted R2 intent and authenticated pass, erases active private copies, then writes the completion. An R2 interruption leaves the deletion pending and inaccessible; scheduled maintenance resumes it. Consumed quota is not refunded. The receipt uses a scoped random token whose keyed verifier alone is persisted. Conservative 30-/45-day backup/ledger deadlines do not prove a hosted restore or backup purge.
- Completed deletion is terminal even when a delayed concurrent retry loses R2 access. A definite revision conflict refreshes the reading and requires a new confirmation; an ambiguous lost response keeps the original receipt and idempotency key for retry.
- Browser private state stays in RAM. Logout, account invalidation and unmount invalidate delayed responses. Save does not silently persist a reflection draft. Browser acceptance checks localStorage, sessionStorage, IndexedDB and Cache Storage remain empty.

## Verification

After the review fixes, `npm run verify` passed all 13 stages and **180 executed tests** (82 domain/tooling, 85 actual D1, 13 Chromium browser tests), zero skipped, in **28.09 seconds** on Node 26.12.1. The earlier pre-review run passed 173 tests in 23.99 seconds. These are recorded runs; `artifacts/verify.json` contains the source digest and measured duration of the latest complete run, refreshed after documentation changes. `npm run release -- --check` verifies that receipt and keeps `deploymentAllowed: false`.

Browser plugin not available; used the existing Playwright workflow at `http://localhost:8787`, Chromium virtual authenticators, 1100×850 desktop and 390×844 mobile viewports. The complete interaction passes with no page errors or outbound browser requests. Desktop/mobile screenshots were inspected outside the repository at `/tmp/reflection-saved-reading-desktop.png` and `/tmp/reflection-saved-reading-mobile.png`; no horizontal overflow was observed. These are functional layout checks, not full browser/device/accessibility qualification.

Additional fault/interleaving evidence:

- Consent revoked immediately before dispatch or publication blocks the result and releases held quota exactly once.
- Authentication expiring after reflection encryption rolls the write back.
- New retry-key aliases cannot be reused to generate another reading; concurrent deletion retries join one durable job.
- Unsaved expiry after decryption prevents both a reading response and an export page from releasing the expired content.
- Export changes after decryption return `EXPORT_CHANGED`; pages/cursors remain bounded and scoped to the owner/ticket.
- Cross-account access and ciphertext field transplantation fail; R2 interruptions remain fenced until maintenance completes.
- Browser save-with-draft, stale-reflection conflict, both explicit reconciliation choices, clean focus refresh and delayed-response-after-sign-out tests pass.
- Concurrent deletion paused before its erase batch cannot regress another retry's completed job, including with R2 completion reads failing. A lost browser deletion response retries the exact original receipt/key; a definite revision rejection permits a freshly confirmed intent.
- Export expiry between pages invalidates the entire ticket, including when the first page contains a generation receipt and later pages would otherwise omit its expired reading/session.

The first browser build uncovered a Worker bundling issue: importing common SQL helpers also imported a Vite-only raw SQL module. Common helpers now live in `db/core.ts`; the existing prototype retains its publication-guard module. The actual browser build and Worker dry-run both pass.

## Review and remaining gates

A fresh independent reviewer examined `13125ae..a74368a` and independently reproduced five Important findings. All five were addressed in one author fix pass, with the original failure observed before the fix and passing regressions afterward. No identified material finding was deferred. The reviewer did not independently re-review the fixes; their disposition is supported by the author-run complete verification gate.

| Finding | Fix and regression evidence |
| --- | --- |
| Focus silently advanced the revision under stale reflection text | Preserve the draft's base revision, show the newer saved version and require a deliberate reconciliation choice. Browser coverage verifies the write uses the reviewed revision only after that choice. |
| Delayed concurrent erasure regressed a complete job to an unresumable state | Atomic terminal-state guard prevents the erasure batch from changing a completed job; a concurrent completed result joins successfully. D1 regression includes an R2 completion-read outage and another retry. |
| Natural retention expiry silently omitted records between export pages | Bound the whole ticket to the earliest relevant retention deadline. D1 regression requires `EXPORT_CHANGED`, not a partial successful final page. |
| Navigation silently discarded an unsaved reflection | Local stay/discard choice for both Saved readings and New reading; browser tests verify cancel preserves text and discard does not submit it. |
| A stale deletion intent kept sending the rejected revision after refresh | Clear only a definitely rejected intent, refresh and require confirmation again. Browser tests cover the corrected revision and the separate lost-response case that must preserve the old receipt/key. |

This slice is explicitly gated by `READING_MODE=synthetic-local` and the existing localhost identity configuration. Its catalog contains labeled synthetic approval fixtures, and its writer never invokes a transport or external provider. Simulated dispatch rows retain the proposed provider/model contract values with `syntheticOnly:true`, `externalCall:false`, and returned model `synthetic-local-writer.v1`; they are not evidence of an actual OpenAI call, provider compatibility, quality, safety or cost. Local accepted simulations consume the local product allowance so return journeys can verify it does not change.

Intentional scope boundaries:

- Follow-ups, selected context/grants, imports, revisits, account-wide deletion, credential add/remove settings and the complete generation recovery pipeline remain separate work. Unsupported routes fail closed. Local exports/deletion also refuse unsupported imported/context families rather than silently omitting them or claiming complete erasure.
- Production keys/configuration, provider and editorial qualification, broader lifecycle/retention cleanup, operational alerts, full restore/replay and ledger/key rotation/purge remain open. The local session-erasure implementation handles its first live pass; it is not the offline multi-pass restore executor.
- Physical/synchronized authenticators, Safari/Firefox, full keyboard/screen-reader/a11y acceptance, hosted resource isolation and release failure proofs remain unqualified.
- Default Worker private routes remain disabled without explicit local configuration. No live inference, push, PR, merge, hosting change or deployment occurred.

The reviewer declined to qualify live-provider/editorial behavior, production configuration, offline restore/multiple erasure passes and backup purge, unsupported record families, physical/synchronized/non-Chromium authentication and full accessibility, or broader retention/accounting longevity. These match the explicitly open acceptance gates above; passing this local journey does not close them.

The branch stays local for review and the next Milestone 2 integration.
