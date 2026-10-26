# Recoverable request lifecycle implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the local reading request recoverable, cancellable and inspectable while preserving saved-content guarantees.

**Architecture:** Retain the encrypted D1 request ledger, add atomic status/event handling and cancellation, return Start after durable admission, and continue with Worker waitUntil. The browser resumes by opaque intent/request URL; status lookup never starts work.

**Tech Stack:** Existing TypeScript, React, Hono, Cloudflare D1, Vitest/workerd and Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-request-lifecycle-design.md`, with `docs/architecture/USER_EXPERIENCE.md` and existing API contracts.

## Global Constraints

- Deployment and live-provider traffic remain disabled.
- All private drafts stay in RAM; only opaque identifiers enter URLs.
- Preserve owner, session, consent, retention, quota, encryption and offline-restore guards at commit time.
- No implicit provider retry or new intent on ambiguous response; no new generation/quota charge when reopening.
- Run commands with the installed Node 26.12.1 path. Keep work in the existing separate application checkout on a new codex branch.
- Browser plugin not available; use the installed Playwright workflow. Synthetic browser evidence does not establish manual/device acceptance.

## Review Focus

- Cancellation racing publication or consent revocation must preserve the winner and never double-release quota (Task 1).
- Pruning between status reads must not regress the cursor or skip unread events (Task 1).
- Lost Start response followed by reload or sign-in must resolve the owned request without retaining its question in storage (Task 2).
- Delayed progress after navigation/sign-out must never reopen another view or reveal another subject's content (Task 2).
- Lost Save response, source expansion and result focus must preserve exact accepted content and any active reflection draft (Task 2).

### Task 1: Durable request observation and cancellation

**Files:** `src/worker/readings/generation.ts`, new `src/worker/readings/request-state.ts`, `src/worker/readings/base.ts`, `src/worker/readings/routes.ts`, `src/worker/index.ts`, `docs/architecture/openapi.yaml`, fixtures and `tests/db/request-lifecycle.test.ts`.

**Interfaces:**
- Consumes existing RecordBase ownership/atomic/crypto/mutation guards and WritingProvider outcomes.
- Produces `LocalGeneration.status(session,id,after=0)`, `resolveIntent(session,intent,after=0)`, `cancel(session,id,revision,key)`, and `start(session,input,key,defer?)` returning StartResponse after admission when defer is supplied. Optional writer dependency stays at the service constructor, not request/env fixture controls.
- Route GET `/requests?intentId=:id` returns owned RequestStatus; GET `/requests/:id?after=N` returns a snapshot; POST `/requests/:id/cancel` consumes `{}`, If-Match and idempotency key.

- [ ] Write failing real-D1 tests: cursor survives interleaved retention; `after` excludes old events and rejects invalid input; deferred Start returns before completion; owned intent resolution; cancel returns cancelled and allowance 3, late completion publishes nothing, retry has one release; foreign/stale/missing-revision/published cancellation rejected; refusal/unavailable/uncertain outcomes distinct with no redispatch; consent and expiry win over delayed publication.
- [ ] Run `npm run test:db -- tests/db/request-lifecycle.test.ts`. Expected: behavior assertions fail before implementation.
- [ ] Implement snapshot reads, atomic event watermarks, cancellation and precise terminal outcomes; split continuation from admission and wire Worker waitUntil. Default service callers may await completion. Document lookup with existing RequestStatus schema. Preserve offline fence.
- [ ] Run targeted tests then `npm test`. Expected: all domain and D1 tests pass, including old privacy/accounting/retention regressions. Update historical cursor expectations for additional WRITING events without weakening watermark assertions.
- [ ] Commit `feat: add recoverable local request lifecycle and cancellation`, then task-done with `npm test`.

### Task 2: Resumable browser progress and reading inspection

**Files:** new `src/client/request-progress.tsx`, `src/client/readings.tsx`, `src/client/identity.tsx` only if route preservation needs it, `tests/browser/request-lifecycle.spec.ts`, existing browser fixtures/tests, `README.md`, `docs/MILESTONE_2_ACCEPTANCE.md`, new `docs/REQUEST_LIFECYCLE_RESULTS.md`.

**Interfaces:**
- Consumes Task 1 status/intent/cancel API; owner-scoped request IDs contain no prose.
- Produces a request progress component with bounded polling, current-status cancellation, explicit retry/reconnect, distinct outcome copy and accepted-session callback guarded by component lifetime.

- [ ] Write failing browser tests for Start acknowledgement lost then reload, status disconnection and reconnect, cancellation race, consent revoked during request, lost Save followed by reopen, keyboard source expansion and result focus. Assert one durable request/dispatch and unchanged accepted text/allowance through the public APIs where available. Use D1 tests for controlled provider outcomes; browser-test outcome copy through content-free API status fixtures.
- [ ] Run `npm run test:browser -- tests/browser/request-lifecycle.spec.ts`. Expected: missing progress/reconnect/cancel/semantic assertions fail.
- [ ] Replace submit-handler polling with the request component. Set opaque intent path before submit, replace with request path after acknowledgement, preserve same in-memory body/key on retry, and prevent a late callback after leaving the view. Focus result heading only for explicit completion, not reload/editor refresh. Add semantic draw/interpretation/source headings.
- [ ] Run targeted browser tests; inspect desktop/mobile screenshots, errors and actual controls. Then `npm run verify`. Expected: all 13 stages pass with no skipped tests.
- [ ] Record exact local evidence and remaining gates in result/acceptance docs, refresh the source-bound gate and release check, commit `feat: resume reading requests and clarify reading sources`, and task-done with `npm run verify`.

## Final review and handoff

One fresh whole-branch review compares against base `7c1d981`. Re-grade findings, correct material issues once with RED→GREEN regression tests and a full gate. Record rulings and deferred minors, preserve the local branch, run the source-bound release check, and leave Milestone 2/ZIP pending with deployment disabled.
