# Local retention and safe cleanup implementation plan

> **For agentic workers:** Use superpowers:executing-plans for native implementation and one final fresh review. The user has approved this local slice; retain the existing isolated application checkout and disabled deployment gate.

**Goal:** Reclaim expired private/operational storage accurately, and purge independent recovery records only with verified deadlines, writer exclusion and a recoverable fresh backup boundary.

**Architecture:** Registered D1 accounting triggers replace approximate service deltas. Bounded maintenance applies the current-family retention policies. A local offline cleanup service shares recovery writer exclusion, authenticates R2 candidates, captures a fresh epoch-stamped backup and uses a durable purge journal so retries and older snapshots fail safely.

**Tech Stack:** Existing pinned TypeScript, D1/R2, Web Crypto, Vitest Workers and Playwright. No dependency changes or hosted services.

**Spec:** `docs/superpowers/specs/2026-10-26-retention-cleanup-design.md`; authoritative lifecycle in `docs/architecture/DATA_LIFECYCLE.md`, `PRIVACY_OPERATIONS.md`, `SECURITY_RESTORE.md`, current column registry. Base `894f7a7`.

## Global constraints

- Synthetic localhost only; no deployment, production keys, paid inference, push or merge. Carry forward the 208-test baseline.
- Exact encrypted UTF-8 byte lengths plus 1,024 bytes per owned row; 20 MiB content admission cap. Deletion/export/recovery/consent-off access must remain usable at capacity.
- Unsaved sessions 24 hours; terminal-failure bodies/candidates 24 hours; events/idempotency 7 days; applied security operations and unreferenced failure metadata 30 days; resolved cost detail 90 days; current plus previous quota month and referenced periods retained.
- Never erase accepted saved text or authored revisions due to age. Pending security/erasure operations and unresolved financial liabilities cannot expire. Every exported change invalidates old export tickets.
- R2 lists at most 100 objects/page. Validate targets, named keys, MACs, complete chains and maximum deadlines. No purge from D1 status alone or missing objects.
- Offline-only purge requires writer quiescence and verified fresh backup; interrupted purge blocks restore/reopening. New recovery epoch excludes every earlier snapshot. Preserve the explicit offline binding throughout snapshot operations.
- Hosted/time-travel/cross-process qualification, key retirement, imports/context/revisits and live provider liability reconciliation remain outside this slice.

## Review focus

1. Cleanup delayed across a save/publication/restore fence must reevaluate eligibility at commit and must not erase a saved reading or permit new R2 writes after retirement.
2. Body nulling, repeated cleanup, cascades and nullable-owner cost detachment must release exactly the actual bytes/row overhead once, without allowing content admission above the cap.
3. Expiring metadata must preserve accepted provenance, current checkpoint state, held product quota and unresolved financial liabilities; expired financial export must not become a zero-cost claim.
4. A later pending pass, changed object or missing named key must block purge even when an older completion and D1 projection say complete.
5. A crash after some R2 deletions must remain resumable, while a restored older database cannot bypass the independent cleanup epoch or resume paid work.

### Task 1: Transactional storage accounting

**Files:** `src/worker/db/migrations/0003_storage_accounting.sql`, accounting coverage check, `src/worker/readings/{base,generation,records,reflections,export,erase-data,erasure}.ts`, `src/worker/db/prototype.ts`, generated schema mirrors, `tests/db/storage-accounting.test.ts`.

**Interfaces:** Triggers account for `accounts.id` and every registered `owner_id` row and every E/K column. SQL publication/admission reads the resulting `accounts.storage_bytes`; callers no longer supply estimates. Add a structural coverage check for all relevant tables/columns.

- [ ] Write tests for literal UTF-8/1 KiB deltas, rollback, owner detachment/cascade, exact initial identity costs, repeated body erasure and operation retry, capacity rejection and export/deletion at capacity. Update the existing rollback test to compare the pre-batch balance instead of assuming uncharged seed rows.
- [ ] Run `npm run test:db -- tests/db/storage-accounting.test.ts`; observe accounting failures before implementation.
- [ ] Add the forward migration/backfill and coverage check. Remove manual counter updates, retain data-revision changes and atomic admission guards. Generate schema mirrors.
- [ ] Run targeted tests then `npm test` and TypeScript; expect green. Commit locally.

### Task 2: Bounded D1 retention

**Files:** `src/worker/maintenance/retention.ts`, `src/worker/index.ts`, `src/worker/identity/service.ts`, `src/worker/readings/{base,export}.ts`, `tests/db/retention.test.ts`.

**Interfaces:** `RetentionMaintenance(db).run()` processes at most 100 eligible rows per family per invocation, uses execution-time SQL predicates, and returns content-free counts. Every batch checks the offline fence. Saved/source references and pending/held states are guard predicates, not assumptions from an earlier read.

- [ ] Write failures for 24h/7d/30d/90d boundaries, bounded pages, saved accepted text/provenance preservation, failure/candidate body purge, financial expiry, unresolved costs, referenced buckets/attempts, exporter invalidation and retry accounting.
- [ ] Run targeted retention tests; expect missing behavior. Implement guarded batches and scheduled integration, replacing unbounded overlapping identity TTL cleanup.
- [ ] Add a delayed-maintenance fence regression and observe RED before the commit-time guard. Verify current consent-off history/reflection/export remain available after cleanup.
- [ ] Run `npm test` and TypeScript; expect green. Commit locally.

### Task 3: Offline recovery-record cleanup and evidence

**Files:** `src/worker/recovery/{coordination,cleanup-state,cleanup,restore}.ts`, `src/worker/identity/checkpoint.ts`, `src/worker/readings/erasure.ts`, new registered recovery-epoch migration, `tests/db/recovery-cleanup.test.ts`, snapshot/backup fixtures, `docs/RETENTION_CLEANUP_RESULTS.md`, `docs/LOCAL_CLEANUP_RUNBOOK.md`, README/package commands.

**Interfaces:** Recovery writer/exclusive coordination is keyed by the local recovery environment. `OfflineCleanup(env, backupAdapter, retainedKeys?).run()` requires explicit offline bindings. The backup adapter captures and verifies actual epoch-stamped D1 state. Independent signed cleanup state has pending/complete phases, epoch, verified backup hash and bounded exact object/ETag candidates; complete state drops object identifiers. Restore checks this state and rejects pending cleanup or a database epoch below its floor.

- [ ] Write failing D1/R2 scenarios for completed/expired chain purge, latest pending/deadline extension, superseded versus current checkpoints, deleted-account empty markers, unknown keys/corruption, >100-object pagination, fresh-backup failure and old-snapshot rejection.
- [ ] Add delayed checkpoint writer, overlapping cleanup/restore, interrupted deletion and same-plan retry cases. Run targeted tests; expect missing service/behavior.
- [ ] Implement shared exclusion, independent authenticated journal and recovery epoch, backup verification, exact candidate deletion/resume and terminal receipt; keep private routes and Cron offline throughout. Recheck target erasure before retiring evidence. Keep over-bound groups retained.
- [ ] Run targeted tests and `npm test`; expect green. Document exact limits, backup-boundary consequence and remaining gates; commit locally.
- [ ] Run full `npm run verify` and `npm run release -- --check`; expect all stages/tests pass and `deploymentAllowed:false`. Obtain one fresh whole-branch review; fix material findings with RED→GREEN regressions in one pass, rerun the full gate and commit locally.
