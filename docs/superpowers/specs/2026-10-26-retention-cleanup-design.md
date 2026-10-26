# Local retention, accounting and safe cleanup

The user approved this slice after the verified privacy/restore baseline `894f7a7` (13 stages, 208 tests). Preserve identity, complete-kit recovery, saved history/reopening, consent-off actions and deletion receipts. Deployment, live provider traffic and hosted changes remain disabled.

## Approach and scope

Use the existing D1/R2 services and synthetic local runner. Database triggers maintain the exact account admission estimate: UTF-8 bytes of registered encrypted/wrapped-key columns plus 1 KiB per owned row. This covers identity and operational metadata as well as readings, and makes insert/update/delete/cascade/retry accounting transactional. Replace hand-maintained service deltas. Enforce the 20 MiB cap on content growth; recovery, consent revocation, export and deletion remain available at capacity.

Bounded scheduled D1 retention removes expired capabilities/events/idempotency, terminal failed private bodies after 24 hours, unreferenced failed metadata/attempts after 30 days, and settled cost detail after 90 days. Keep saved accepted bodies/basis/provenance and all authored reflection revisions until explicit deletion. Preserve held quota, referenced quota buckets, unresolved liabilities and referenced attempt skeletons. Cost exports must say expired rather than zero after detail removal. Unsupported Milestone 3 families receive accounting coverage but no new workflows or unsafe cascading cleanup.

Independent R2 cleanup is an explicitly offline operator operation, never Cron or HTTP. It authenticates the complete current inventory and requires full pass-chain completion and conservative 45-day-or-later deadlines. Current identity checkpoints and pending operations remain; superseded checkpoints need 45 days since supersession. Account checkpoint markers can disappear only with the qualifying account-erasure evidence and after local checkpoint/erasure writers are quiescent.

A local recovery coordinator excludes cleanup, restore and active ledger writers. An independently authenticated cleanup state records pending object keys/ETags before any R2 deletion; interruptions stay offline and resume that plan. A monotonic recovery epoch in D1 and the independent state reject snapshots from before a purge. The trusted backup adapter must capture and verify a fresh snapshot at the new epoch before purge. This deliberately retires earlier local restore points; it is not a claim that hosted backups were physically deleted. Successful cleanup retains only a content-free epoch/backup receipt, and removes completed D1 deletion projections. Existing ledger keys are never retired by this slice.

Alternatives considered: routine Cron R2 deletion cannot establish writer quiescence or backup safety; manual-only D1 cleanup would leave the approved retention behavior unimplemented. Continuing approximate accounting makes duplicate/expired metadata charges drift. The chosen approach keeps normal retention automatic and the cross-store purge explicit and recoverable.

## Local qualification boundary

The backup adapter and coordinator are for one trusted local synthetic runner. The adapter's snapshot capture/verification is exercised against actual local D1 rows. Hosted snapshot capture, independent storage-loss assurance, cross-process exclusion, production key rotation and provider reconciliation still need their own evidence. A cleanup plan is bounded to 1,000 objects and 512 KiB; groups that cannot fit remain retained, with no partial purge. R2 listings use at most 100 objects per page. Cleanup never discards a malformed or unknown object to make verification pass.

## Required evidence

- Exact Unicode byte/row accounting, transactional rollback, owner transfer/detachment, repeated cleanup and released capacity; exported saved content remains identical.
- Deadline boundaries, pending/held/reference exclusions, rejected-candidate removal without accepted-text changes, export invalidation and unknown-cost preservation.
- Authenticated complete-chain purge only after the latest deadline; restore extends eligibility; current/pending/unknown-key/malformed inventories block unsafe cleanup.
- A paused checkpoint writer prevents purge, retired operation retries cannot recreate a purged checkpoint, and old snapshots are rejected after the independent epoch advances.
- Interrupted object deletion and failed backup/state writes stay offline and resume without overwriting immutable erasure evidence or claiming premature completion.
- Full verification and one fresh independent whole-branch review, with material findings reproduced and corrected before handoff.
