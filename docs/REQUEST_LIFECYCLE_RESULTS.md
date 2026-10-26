# Local request lifecycle and inspection

Application baseline: `7c1d981`; implementation branch: `codex/milestone-2-request-lifecycle`. Milestone 2 remains open. Deployment and live-provider traffic remain disabled.

## Behavior

Start commits its encrypted question, draw, request, quota reservation and QUEUED event before returning 202. A Worker continuation performs the synthetic writing step. Duplicate body/key or client intent joins the existing request; status and intent lookup never dispatch. There is no new transport or dependency. A Worker loss leaves durable status and eventually expires unfinished work through maintenance; this is not a hosted durable-execution qualification.

Request status reads the row and bounded events in one D1 batch. It honors `after`, preserves the watermark through pruning and handles pre-watermark records. QUEUED, WRITING, ACCEPTED and STOPPED events are committed with their state transitions. This addresses the minor cursor race from the retention review.

Cancellation uses the documented current revision, owner/session/CSRF guards and idempotency key. Its transaction fences publication, releases held quota once and records STOPPED. A published reading returns conflict and remains intact. Refusal, expired request, withdrawn consent, writer failure and uncertain response have distinct statuses; none causes an automatic provider retry.

The UI keeps private drafts and mutation bodies in RAM. Before Start, it records only an opaque intent URL; after acknowledgement, it uses the request URL. Reload and sign-in resolve that owned URL without another Start. A never-received intent remains explicitly uncertain and permits a deliberate empty new draft, without silently sending a new request. Explicit retry retains the same original body/key. Lost Save responses are reconciled by reopening the same accepted session. Late progress after navigation/sign-out cannot reopen a departed view.

Drawn card, interpretation and reflection prompt have semantic headings; the expandable traditional-source snapshot is separate from personal reflection. Completion focus is applied after React commits the result and only for explicit completion, not reload or editor refresh.

## Evidence and limits

`tests/db/request-lifecycle.test.ts` adds 12 real-D1 cases: interleaved pruning, old watermarks and pagination, deferred admission/owned lookup, cancellation before dispatch/publication, owner/revision/published guards, three intercepted writer outcomes, consent revocation and expiry. Ten initial failures and the additional old-watermark regression were observed before the corresponding fixes. Domain/D1 verification passed 84 + 172 tests.

`tests/browser/request-lifecycle.spec.ts` exercises lost Start acknowledgement/reload, lost Save/reopen, same-body/key retry, sign-in at an unsaved request URL, late progress after navigation, keyboard source inspection, cancellation response loss, consent revocation and distinct stopped copy. The first nine cases failed before the UI implementation. The sign-in route regression was separately verified RED→GREEN against the former navigation behavior. Further races cover the displayed allowance after progress unmount and a never-received Start after reload.

The first integrated gate passed **13 stages and 284 tests**, zero skipped, in **90.50 seconds**. Later regression additions and review corrections are covered by the current source-bound receipt. `npm run verify` writes source digest, stage results and duration to `artifacts/verify.json`; executed counts are in `artifacts/domain-tests.json`, `artifacts/db-tests.json` and `artifacts/browser-tests.json`. `npm run release -- --check` verifies the source-bound receipt and must continue reporting `deploymentAllowed:false`.

Real browser journeys use the local Worker, D1 and virtual passkeys. The cancellation/outcome UI cases explicitly inject **content-free status responses**; the corresponding backend transitions and late-publication fences are separately exercised with real D1 barriers. Those UI fixtures are not evidence of a real provider refusal, remote abort or billing reconciliation.

Browser plugin not available; validation uses the installed Playwright Chromium workflow at `http://localhost:8787`. Desktop (1100px) and mobile (320px) screenshots were inspected, with keyboard source expansion, exact card/source assertions, no horizontal page overflow and no page errors in that inspection journey. Screenshots are outside source at `/tmp/reflection-request-inspection-desktop.png` and `/tmp/reflection-request-inspection-mobile.png`. Full VoiceOver/TalkBack/NVDA, zoom, non-Chromium and physical-passkey acceptance remain open.

The prior complete-kit recovery, exact saved-reading return, consent-off reflections/export/deletion, privacy restore and retention/cleanup tests remain regression requirements. No deployment or real AI call was performed. The requested application ZIP remains pending until **all** Milestone 2 gates close.

## Review and decisions

An independent fresh-context reviewer examined `7c1d981..65db587`, passed the 12 lifecycle D1 cases in an isolated archive, and reproduced two Important browser findings. The pre-review source-bound gate passed **13 stages and 286 tests**, zero skipped, in **100.71 seconds**. No Critical or Minor findings were reported.

| Finding | Correction and regression |
|---|---|
| Explicit New reading reused a stopped request's cached intent/key when the question was unchanged | The deliberate New reading action retires the old Start identity. A browser test verifies a distinct client intent, key and request, and `joined:false`; the separate Retry the same Start test still verifies reuse. |
| Browser Back left progress/accepted-result loading active, allowing a late response to restore the departed URL/view | Native navigation invalidates the parent operation epoch, stops polling and reconciles the destination view. Progress also checks its owned route before applying a response. Tests hold both status and accepted-reading responses across Back, then verify Forward can reopen the same request. A further regression protects a dirty reflection until discard is explicitly confirmed. |

All four correction regressions were observed failing before the fixes and passing afterward (4/4, 14.3 seconds). The correction pass includes the complete existing verification gate; its final source-bound result is the current receipt. The reviewer did not perform a second review; regression evidence and the full author-run gate establish the disposition. No identified material finding is deferred.

- Proceeded under the user's existing approval in the separate application checkout and a new local branch. No additional design/worktree approval was needed. Cost if wrong: local implementation choices can require revision; nothing was published.
- Used the already specified `GET /requests?intentId=...` endpoint instead of adding an API route. It provides the required owner-scoped lookup; the opaque browser path is independent of the API path. There is no behavioral cost to this correction.

The reviewer explicitly declined to qualify these boundaries; the author accepts those limits:

- Worker termination: waitUntil is a local continuation, so unfinished work can expire rather than complete. Hosted durable execution remains open; treating this as a guarantee would mislead users about interruption recovery.
- Real-provider candidate fidelity: the local generator publishes synthetic template text. Outcome injection tests lifecycle handling, not real-provider fidelity. A real transport must remain disabled until its accepted-output and provider qualification evidence exists.
- Screen readers and physical passkeys: keyboard/focus and virtual-authenticator tests do not establish those behaviors. Unverified accessibility or device compatibility cannot be counted as launch acceptance.
- Verification wording: corrected the result record to distinguish source/stage/duration metadata from executed-test reports. This has no runtime effect and avoids attributing evidence to the wrong artifact.

Deferred minors: none from this review. The former retention cursor minor is covered by the D1 regression in this branch.

The local branch is preserved for subsequent Milestone 2 work. Identity account controls are the next implementation target; production/provider/content/hosted/manual gates remain open as listed in `MILESTONE_2_ACCEPTANCE.md`.
