# Local retention, storage accounting and recovery cleanup

Scope: `codex/milestone-2-retention-cleanup`, based on verified privacy/restore commit `894f7a7`. The identity, complete-kit recovery, saved-reading return and consent-off baseline remains required. This is local synthetic qualification; Milestone 2 and launch acceptance remain open. Deployment remains disabled.

## Implemented behavior

- A forward migration backfills storage accounting and installs 91 triggers covering every registered owned row and encrypted/wrapped-key field. UTF-8 bytes, 1 KiB row overhead, nullable ownership transfers and cascades are charged exactly once inside the mutation transaction. The 20 MiB content cap does not block recovery, save of existing content, consent revocation, export or deletion.
- Bounded scheduled retention rechecks deadlines, saved/terminal state, held quota, references and the restore fence inside SQL batches. It releases expired capability/operational metadata and private failed/candidate bodies, preserves saved text/basis/provenance/reflections, and invalidates exports when exported data changes. Expired financial detail is explicitly marked; unknown numeric liabilities remain reserved after ownership is detached.
- Offline cleanup authenticates complete recovery inventories and latest erasure deadlines; retains current checkpoints and pending operations; and removes eligible complete chains and deleted-account empty markers only with local writer exclusion, a verified fresh backup and a durable exact purge journal. Oversized groups remain whole.
- An independent signed recovery floor rejects older D1 snapshots. Interrupted purge resumes the same plan and backup; altered planned/retained objects, unknown keys or unavailable backups keep access offline. Completed journals drop per-account/job/object identifiers. Current factors, account keys and saved content survive.

## Evidence

Task 1 observed three behavioral accounting failures and two missing-coverage tooling failures before fixes. Its five D1 tests cover Unicode bytes, rollback, metadata ownership, erasure/idempotency, capacity exceptions and cost-adjustment cascades. Task 2 began with missing retention behavior and then reproduced an in-flight batch crossing the restore fence before adding the execution-time guard; eleven D1 scenarios now cover bounded expiry, saved records, financial state, cursors, quota and deleted shells.

Task 3 began with the missing offline service. Fifteen initial D1/R2 scenarios then passed; two additional tests reproduced acceptance of missing independent erasure evidence and unavailable account keys before the checks were added. Six further failure/boundary cases exercise journal-write rollback, a lost successful PUT response, missing/tampered recovery floor, a reappearing body, long chains and whole-group bounds. The final cleanup file contains 23 tests, including 105-object pagination and a 1,001-object group that stays intact while another group is purged.

An initial full gate passed all 13 stages and 248 tests (84 domain/tooling, 148 D1, 16 browser; zero skipped) in 37.44 seconds. A subsequent author boundary check reproduced failed-body selection drifting into a second owner after the first update; fixed bounded row identities with execution-time eligibility checks keep body cleanup and export invalidation aligned. Its 101-request regression was observed RED→GREEN. The updated full gate passed all 13 stages and **249 tests** (84 domain/tooling, 149 D1, 16 browser; zero skipped) in **37.29 seconds**. The release check confirmed `deploymentAllowed:false`. Independent review is pending; its findings and correction evidence will be recorded before handoff. The source-bound `artifacts/verify.json` receipt remains authoritative for the most recent full run.

## Boundaries and next gates

See [the cleanup runbook](LOCAL_CLEANUP_RUNBOOK.md) for exact operator steps, backup consequences and failure behavior. Snapshot capture is actual local D1 row capture/verification in a separate synthetic test store. The coordinator excludes local service writers in one process; it is not a distributed lock. A hard crash before durable journal publication, total independent inventory loss, hosted backups/RPO/replication and production key rotation remain unqualified. No key is retired, and no hosted restore point is claimed physically deleted.

See [Milestone 2 acceptance](MILESTONE_2_ACCEPTANCE.md) for the remaining work and the user's requested ZIP deliverable. No live inference, hosted change, push, PR, merge or deployment is part of this slice.

## Decisions

- Continue approved native execution and existing checkout without another permission round — the user approved retention/accounting/safe cleanup and has already accepted local-only execution. Cost: implementation choices remain local and reviewable; no external changes.
- Use database-trigger accounting rather than add more service estimates — it covers every registered owned row and encrypted/key field atomically, including cascades and identity metadata. Cost: a forward migration/backfill is required; old approximation assumptions in tests must become pre/post invariant checks.
- Require a verified new epoch-stamped local backup before R2 purge and retire earlier restore points — a monotonic independent epoch prevents missing erasure records from silently authorizing an old database. Cost: earlier snapshots become unsupported after purge; hosted backup retention and capture remain unqualified.
- Treat cost_adjustments as indirectly owned while their cost reservation has an owner — its row overhead follows ownership transfer/detachment and cascade. Cost: trigger ordering must preserve exactly-once debits; actual D1 regression verifies it.
- Add nullable provider_dispatches.cost_expired_at with a forward migration — removing or detaching old cost detail must not turn a paid history into a false zero/never-charged claim. Cost: schema expansion is required; historical unmarked rows remain as previously represented.
- After 90 days detach unresolved cost ownership while retaining numeric liability and referenced spend buckets — privacy retention does not forgive unknown charges. Cost: old liability loses user attribution but remains conservatively reserved for operator reconciliation.
