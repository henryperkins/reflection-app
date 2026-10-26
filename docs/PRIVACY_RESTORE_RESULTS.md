# Local privacy lifecycle and restore evidence

Scope: branch `codex/milestone-2-privacy-restore`, based on `7874fa2`. The verified local identity/recovery and five saved-reading journeys remain required regressions. Deployment stays disabled; Milestone 2 and hosted launch acceptance remain open.

## Implemented behavior

- Account deletion requires current ownership, CSRF and recent authentication; it fences the account, revokes sessions and stops unfinished generation before erasure. The independent encrypted intent precedes acknowledgement. Owned bodies, keys, credentials, verifiers and security checkpoints are removed; numeric cost aggregates are detached. Other accounts survive.
- Reflection deletion targets an exact immutable revision with current-revision CAS. Erasing an old revision preserves the current reflection; erasing the current one leaves older unselected revisions accessible through explicit reads/export. Accepted reading text is unchanged. Unsupported imported/context copies block completion.
- Session deletion retains its existing retry and completion protections. Shared ledger code verifies canonical targets and contiguous numeric pass chains, named keys, MACs and digest links. Every new restore pass extends retention deadlines; a later pending pass takes precedence over an older completion.
- Offline restore reads independent R2 targets even when a stale D1 snapshot has no deletion job. Account erasure takes precedence over identity checkpoints. Surviving identity state comes from the highest authenticated checkpoint, without manufacturing lost journal data or keys.
- Replay clears sessions/challenges/exports and mutation keys; forces AI permission off; revokes grants; blocks restored nonterminal work regardless of visible dispatch rows; releases held quota once; and conservatively exhausts existing uncertain spend buckets. Global generation remains off.
- The new registered `system_state.restore_in_progress` field persists failure isolation. HTTP and scheduled work refuse operation while offline. Commit-time session guards also prevent an already-running private reading response from crossing the fence.
- Browser controls let users review and erase a specific reflection revision without submitting a draft, and explicitly delete an account. Downloadable scoped receipts remain usable after sign-out or a lost deletion response. Tokens stay in RAM until explicit download and appear only in request headers for status checks.

## Evidence and verification

Task 1: six HTTP/D1 tests failed on absent deletion behavior, then passed. Task 2: the restore suite initially could not import the unimplemented service, then its actual D1 snapshot scenarios passed. An additional in-flight-read regression failed on a successful response crossing the offline fence; the commit-time guard made it pass.

The current restore rehearsal contains 13 checks: the complete stale-bookmark scenario, offline HTTP/scheduling, in-flight reads, overlapping local runners, repeated and interrupted passes, five corruption/missing-key/checkpoint conditions, retained recovery keys, and pagination/spend preservation. Domain and D1 verification after these additions passed 82 + 104 tests.

Three new browser checks first failed on missing controls. They cover exact old-revision erasure with AI consent off and an unsubmitted draft, account deletion/receipt download, and a real completed deletion whose HTTP response is deliberately lost. They join the 13 existing identity/saved-reading browser checks.

The pre-review complete gate passed all 13 stages and 202 tests (82 domain/tooling, 104 D1, 16 browser; zero skipped) in 31.74 seconds. `npm run release -- --check` confirmed `deploymentAllowed:false`. `artifacts/verify.json` is the authoritative source-bound receipt; its scope is synthetic local only. Final review disposition and any subsequent regression results are recorded below before handoff.

## Browser QA

Browser plugin not available; used repository Playwright at `http://localhost:8787`, Chromium virtual authenticators, desktop 1100×850 and mobile 390×844. Tests assert real server deletion/status, exact surviving reading/reflection data, cleared authenticated UI, no page errors in the receipt journeys, and no localStorage/sessionStorage/IndexedDB/Cache Storage persistence. The lost-response test deliberately aborts one HTTP response after the actual server commit.

Screenshots were visually inspected and are outside the repository: `/tmp/reflection-privacy-revision-desktop.png`, `/tmp/reflection-privacy-receipt-complete-mobile.png`, `/tmp/reflection-privacy-receipt-lost-mobile.png`. The draft, exact-revision controls and receipt remain legible at desktop width; mobile receipt controls fit without horizontal overflow. This is functional Chromium/layout evidence, not full accessibility or physical/synchronized-passkey qualification.

## Review and remaining gates

Fresh independent whole-branch review is pending. Findings will be addressed with reproducing tests; author verification will be distinguished from reviewer re-review.

The [local restore runbook](LOCAL_RESTORE_RUNBOOK.md) describes the supported operator boundary and failures. This is a single trusted local runner over synthetic D1/R2, not a hosted restore controller or cross-process locking protocol. The snapshot fixture is actual local D1 row restoration, not hosted Time Travel. Current account body-key version remains 1; named older ledger keys can be supplied to replay, but live general key rotation/purge is not qualified. No independent backup inventory assurance or general R2 purge executor is claimed.

Broader retention/metadata accounting, passkey management/logout-all/failure-only recovery throttling, production identity/privacy/configuration, full generation recovery, content/rights and provider qualification, physical/browser/accessibility acceptance, hosted isolation/failing-test/D1/Cron/restore proofs, monitoring and operational approval remain open. Follow-ups, selected context, imports and dated revisit workflows remain Milestone 3.

No live inference, hosted resource changes, push, PR, merge or deployment is part of this slice.
