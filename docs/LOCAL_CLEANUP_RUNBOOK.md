# Local synthetic retention and recovery cleanup

This runbook covers one trusted local runner with synthetic D1/R2 data. It neither deploys resources nor operates a hosted backup system. The application remains in synthetic mode and deployment stays disabled.

## Rehearse

```sh
npm run cleanup:rehearse
npm run verify
npm run release -- --check
```

Use the pinned Node 26 runtime. The rehearsal captures actual local D1 rows, verifies their SHA-256 and recovery epoch in a separate test-owned snapshot store, and leaves R2 independent. It tests byte/row accounting, timed database retention and offline recovery-record purge. It does not contact a provider or hosted service.

## Normal database retention

Scheduled maintenance uses the database clock and execution-time eligibility predicates. Each family selects at most 100 eligible roots per pass; dependent updates can affect more rows. Every mutation batch refuses the persistent restore fence. Account storage is a transactional admission estimate: exact UTF-8 ciphertext/wrapped-key bytes plus 1,024 bytes per owned row, including indirectly owned cost adjustments. It is not a physical D1 or R2 billing measurement.

Expired auth challenges/sessions, rate buckets, export tickets and idempotency keys follow their recorded deadlines. Request events expire after seven days while their sequence cursor survives. Applied security-operation projections and eligible terminal failure/attempt metadata expire after 30 days. Failed input/plan/transmission bodies and terminal candidates expire after 24 hours; accepted saved reading text, basis, source data and authored reflection revisions survive until deletion. Saved-record actions and recovery remain available at the content-admission cap.

After 90 days, settled cost detail can expire; unresolved cost attribution is detached while numeric liability remains reserved. Exports distinguish expired detail from a zero/absent charge. Held quota and referenced quota/spend periods are preserved. Deleted session shells require 30 days, erased bodies and no blocking references. Unsupported later record families are retained conservatively.

## Offline recovery-record purge

`OfflineCleanup(env, backupAdapter, retainedKeys?).run()` is a local operator API, with no HTTP or Cron entry point. It requires synthetic identity/reading bindings and `RESTORE_MODE=offline`.

1. Stop ingress and competing processes. Keep the explicit offline binding present throughout cleanup and any snapshot replacement. The environment-keyed coordinator rejects overlapping local restore/cleanup or active checkpoint/erasure writers, even through a different binding wrapper. This does not exclude another process or hosted Worker isolate.
2. Supply a trusted adapter that captures the actual fenced D1 snapshot outside R2, returns its SHA-256, and independently re-reads and verifies that snapshot and its recovery epoch. The test fixture demonstrates this contract; a durable hosted adapter is not qualified.
3. Authenticate the entire recovery inventory, named keys and contiguous erasure pass chains. Refuse pending passes/operations, unknown paths, missing referenced evidence, changed objects, missing current checkpoints or unavailable account keys. Verify every target is actually erased, including evidence that is too recent to purge; a D1 completion label alone is insufficient. All ordinary identity/generation writes, including failure/expiry/backoff paths, recheck the persistent fence at execution so row capture cannot mix those mutations.
4. Select completed erasure chains only after their latest signed backup and purge deadlines, at least 45 days after completion. A new restore pass extends these deadlines. Keep the latest identity checkpoint; older checkpoints require 45 days since their successor. An erased account's empty checkpoint markers retire only with all its qualifying erasure evidence, as one group.
5. Bound each plan to 1,000 objects and 512 KiB. Lists use pages of at most 100 objects. A group that cannot fit stays intact; another eligible group can proceed. No key material is retired.
6. Remove selected completed D1 projections and advance `system_state.recovery_epoch`. Capture and verify the new snapshot before deleting any R2 object. A confirmed failed capture or journal write rolls those database changes back and leaves access offline. A lost journal-write response is checked before deciding whether rollback is safe.
7. Write a signed, conditional pending journal at `maintenance/v1/cleanup.json`, containing exact candidate keys/ETags, the retained-inventory digest, new epoch and verified backup digest. Delete only that durable plan. An interruption preserves the pending state and blocks ordinary restore. Retry with the same backup and keys; missing already-deleted candidates are allowed, changed candidates or retained inventory are refused.
8. After confirming every candidate is absent and the retained inventory is unchanged, replace the pending journal with a signed completion receipt. It retains only version/phase, epoch, key identifier, backup hash, timestamp, count and authentication; no subject, job or candidate identifiers. Keep both the persistent fence and explicit offline binding in place. A complete purge receipt does not authorize reopening.

9. Run `OfflineRestore.replay()` after cleanup to perform the complete readiness checks. Only successful replay clears the persistent fence; it invalidates sessions and requires fresh passkey sign-in. Then the trusted runner may remove the explicit offline binding. Global generation remains disabled. A preexisting or failed restore cannot be reopened through cleanup.

**Backup consequence:** successful purge retires every database snapshot with a lower recovery epoch. Ordinary restore rejects those snapshots, pending cleanup, tampered receipts, or a missing receipt when D1 has advanced. Restore the newly verified snapshot (or a later compatible one), preserve the independent receipt and keys, and follow the restore runbook. Age alone never proves that a hosted backup has physically disappeared.

## Failure and qualification limits

Keep access offline on every failed verification. Never edit the epoch, erase the journal, discard unknown evidence or fall back to an older checkpoint to force progress. A hard process loss before the pending journal is durable can leave an advanced D1 epoch without a matching independent receipt; this is deliberately blocked and requires recovery from preserved independently verified operator state. Do not infer permission to reset the epoch from a missing object.

The rehearsal qualifies caught dependency failures and interruption after a durable plan. It does not qualify durable process-crash recovery before journal publication, total independent storage loss, backup deletion/replication, hosted Time Travel/RPO, distributed locking, production key rotation/retirement or live financial reconciliation. Current account body-key version remains 1. Imports, selected context and revisits remain outside this local cleanup. Those limitations keep production acceptance and deployment closed.
