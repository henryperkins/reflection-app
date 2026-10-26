# Local privacy lifecycle and restore evidence

Scope: branch `codex/milestone-2-privacy-restore`, based on `7874fa2`. The verified local identity/recovery and five saved-reading journeys remain required regressions. Deployment stays disabled; Milestone 2 and hosted launch acceptance remain open.

## Implemented behavior

- Account deletion requires current ownership, CSRF and recent authentication; it fences the account, revokes sessions and stops unfinished generation before erasure. The independent encrypted intent precedes acknowledgement. Owned bodies, keys, credentials, verifiers and checkpoint payloads are removed; numeric cost aggregates are detached. Empty terminal objects at the former checkpoint keys prevent delayed create-only writers from recreating deleted material. Other accounts survive.
- Reflection deletion targets an exact immutable revision with current-revision CAS. Erasing an old revision preserves the current reflection; erasing the current one leaves older unselected revisions accessible through explicit reads/export. Accepted reading text is unchanged. Unsupported imported/context copies block completion.
- Session deletion retains its existing retry and completion protections. Shared ledger code verifies canonical targets and contiguous numeric pass chains, named keys, MACs and digest links. Every new restore pass extends retention deadlines; a later pending pass takes precedence over an older completion.
- Offline restore reads independent R2 targets even when a stale D1 snapshot has no deletion job. Account erasure takes precedence over identity checkpoints. Surviving identity state comes from the highest authenticated checkpoint, without manufacturing lost journal data or keys.
- Replay clears sessions/challenges/exports and mutation keys; forces AI permission off; revokes grants; blocks restored nonterminal work regardless of visible dispatch rows; releases held quota once; and conservatively exhausts existing uncertain spend buckets. Global generation remains off.
- The new registered `system_state.restore_in_progress` field persists failure isolation. HTTP and scheduled work refuse operation while offline. Commit-time session guards also prevent an already-running private reading response from crossing the fence.
- Browser controls let users review and erase a specific reflection revision without submitting a draft, and explicitly delete an account. Downloadable scoped receipts remain usable after sign-out or a lost deletion response. Tokens stay in RAM until explicit download and appear only in request headers for status checks.

## Evidence and verification

Task 1: six HTTP/D1 tests failed on absent deletion behavior, then passed. Task 2: the restore suite initially could not import the unimplemented service, then its actual D1 snapshot scenarios passed. An additional in-flight-read regression failed on a successful response crossing the offline fence; the commit-time guard made it pass.

The original restore rehearsal contains 13 checks: the complete stale-bookmark scenario, offline HTTP/scheduling, in-flight reads, overlapping local runners, repeated and interrupted passes, five corruption/missing-key/checkpoint conditions, retained recovery keys, and pagination/spend preservation. The `restore:rehearse` command now also includes the six review regressions described below.

Three new browser checks first failed on missing controls. They cover exact old-revision erasure with AI consent off and an unsubmitted draft, account deletion/receipt download, and a real completed deletion whose HTTP response is deliberately lost. They join the 13 existing identity/saved-reading browser checks.

The pre-review committed branch passed all 13 stages and 202 tests in 31.24 seconds. After review corrections, the complete gate passed all 13 stages and **208 tests** (82 domain/tooling, 110 D1, 16 browser; zero skipped) in **36.26 seconds**. `npm run release -- --check` confirmed `deploymentAllowed:false`. These are recorded runs; `artifacts/verify.json` is the authoritative source-bound receipt for the most recent run, including final documentation/command changes. Its scope is synthetic local only.

## Browser QA

Browser plugin not available; used repository Playwright at `http://localhost:8787`, Chromium virtual authenticators, desktop 1100×850 and mobile 390×844. Tests assert real server deletion/status, exact surviving reading/reflection data, cleared authenticated UI, no page errors in the receipt journeys, and no localStorage/sessionStorage/IndexedDB/Cache Storage persistence. The lost-response test deliberately aborts one HTTP response after the actual server commit.

Screenshots were visually inspected and are outside the repository: `/tmp/reflection-privacy-revision-desktop.png`, `/tmp/reflection-privacy-receipt-complete-mobile.png`, `/tmp/reflection-privacy-receipt-lost-mobile.png`. The draft, exact-revision controls and receipt remain legible at desktop width; mobile receipt controls fit without horizontal overflow. This is functional Chromium/layout evidence, not full accessibility or physical/synchronized-passkey qualification.

## Review and remaining gates

One fresh independent reviewer examined `7874fa2..61a702b`, including the plan's five review focus areas, and reproduced two Important findings in an isolated copy. No Critical or Minor findings were raised. The author fixed both in one correction pass, with six tests observed failing before the fixes and passing afterward, followed by the complete green gate. There was no reviewer re-review; closure is supported by the author-run regressions and full verification.

| Finding | Correction and evidence |
|---|---|
| A delayed checkpoint put could recreate credential/verifier material after account deletion reported complete. | Account fencing and durable intent now precede retirement of every known checkpoint key, including keys recorded in D1 but not yet visible in R2. Retirement writes an empty terminal marker before the D1 cascade removes that inventory. Delayed create-only puts cannot replace the marker. A paused writer regression and an interrupted-retirement retry regression both failed before the fix and now pass. Completion remains pending until all marker writes and active erasure succeed. |
| Accepted uppercase receipt UUIDs prevented offline replay. | The authoritative DeleteRequest schema rejects uppercase/mixed-case receipt IDs before deletion side effects. Replay continues to honor previously accepted authenticated IDs using their original exact spelling and signed bytes. Uppercase and mixed-case admission tests cover all three deletion scopes; two legacy replay tests also verify scoped receipts and unchanged intents. All four failed before the fix and now pass. |

The empty markers contain no checkpoint payload. Their opaque key metadata remains, and marker purge is deliberately unavailable pending a qualified lifecycle that excludes delayed writers and supported backups. An account-erasure intent remains authoritative; a surviving account with an empty/corrupt checkpoint still fails restore validation.

The [local restore runbook](LOCAL_RESTORE_RUNBOOK.md) describes the supported operator boundary and failures. This is a single trusted local runner over synthetic D1/R2, not a hosted restore controller or cross-process locking protocol. The snapshot fixture is actual local D1 row restoration, not hosted Time Travel. Current account body-key version remains 1; named older ledger keys can be supplied to replay, but live general key rotation/purge is not qualified. No independent backup inventory assurance or general R2 purge executor is claimed.

Broader retention/metadata accounting, passkey management/logout-all/failure-only recovery throttling, production identity/privacy/configuration, full generation recovery, content/rights and provider qualification, physical/browser/accessibility acceptance, hosted isolation/failing-test/D1/Cron/restore proofs, monitoring and operational approval remain open. Follow-ups, selected context, imports and dated revisit workflows remain Milestone 3.

No material review finding remains unresolved within this local slice. Milestone 2 remains open. No live inference, hosted resource changes, push, PR, merge or deployment is part of this slice.

## Recorded scope and ordering decisions

- Continue approved native local implementation without another plan/worktree permission round — the user approved the concrete next slice and existing application isolation; developer instructions prioritize continued authorized work. Cost if wrong: local branch can be revised, no external side effects.
- Limit replay to supported Milestone 2 families and fail closed on unsupported context/import/revisit copies. General production key rotation/purge, broader retention and hosted qualification remain open — user approved deletion and synthetic restore acceptance. Cost: this local result cannot qualify those later capabilities.
- Add a registered system_state.restore_in_progress column and forward migration — the offline runtime binding alone would allow accidental reopening after a failed replay. Cost: deployments must apply the migration; deployment remains disabled and source/documentation mirrors are generated together.
- Retain zero-byte terminal markers at owned immutable checkpoint keys before account cascade — deleting the keys permits delayed create-only checkpoint writes to recreate credential material; the independent account intent and D1 fence precede marker retirement, and completion follows all erasure. Cost: opaque key metadata remains until a separately qualified purge; interrupted erasure is irreversible and remains fenced/pending.
- Reject noncanonical new receipt IDs but replay authenticated legacy IDs using their original exact casing — preserve both canonical admission and previously accepted deletion promises without rewriting signed objects. Cost: restore retains a bounded legacy spelling exception.
- Hosted Time Travel, R2 replication and distributed operator exclusion stay unqualified — only the documented trusted offline local runner was exercised. Cost: this result cannot authorize hosted restore.
- Independent inventory-loss detection remains a separate gate — stable complete listing cannot detect the total disappearance of a prefix without an independent inventory reference. Cost: catastrophic ledger loss is not qualified; deployment remains disabled.
- General production key rotation, retired-key HTTP receipt serving and ledger purge remain open — this slice verifies explicitly supplied retained keys for replay only. Cost: no production rotation/purge or old-key serving claim is made.
- Imported/context-copy/revisit workflows stay in Milestone 3 — unsupported copies block replay rather than being silently skipped. Cost: the current slice cannot accept that later data.
- Broader metadata accounting and retention longevity stay open — only the exact privacy/restore slice was authorized and implemented. Cost: broad cleanup and long-run storage bounds are not qualified.
- Live provider liability reconciliation and financial-fence clearance stay open — synthetic replay blocks old work and preserves conservative spend, with no live egress or clearance operation. Cost: generation cannot be enabled based on this receipt.
- Physical authenticators, other browsers and comprehensive accessibility stay open — Playwright Chromium and layout checks are the recorded evidence. Cost: device/browser/accessibility readiness is not established.
