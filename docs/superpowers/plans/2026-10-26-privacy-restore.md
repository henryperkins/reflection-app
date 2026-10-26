# Local privacy lifecycle and operator restore implementation plan

> **For agentic workers:** Use superpowers:executing-plans. The user approved this local integration; preserve the existing native execution method and disabled deployment gate.

**Goal:** Delete an account or exact reflection revision, then restore an older synthetic database without reviving erased records, revoked credentials, spent recovery codes, consent or inference.

**Architecture:** Extend the existing D1/R2 erasure implementation with independently authenticated targets and contiguous immutable pass chains. An operator-only offline restore service replays erasures before identity checkpoints and resets runtime access/consent/work; a local D1 snapshot rehearsal exercises the actual services. Existing account keys and accepted readings remain unchanged for surviving accounts.

**Tech Stack:** Pinned TypeScript, Workers D1/R2, Web Crypto, React, Vitest Workers and Playwright; no dependency upgrades or external services.

**Spec:** `docs/architecture/SECURITY_RESTORE.md`, `PRIVACY_OPERATIONS.md`, `IMPLEMENTATION_PLAN.md`, existing contracts/DDL and `docs/SAVED_READING_RESULTS.md`. Base commit `7874fa2`.

## Global constraints

- Synthetic localhost only; no deployment, production keys, hosted provisioning, live provider calls, push or merge. Preserve the 180-test identity/recovery/saved-reading baseline.
- Existing `ErasureTarget`, `ErasureIntent`, `ErasurePass`, `ErasureCompletion`, `IdentityCheckpoint` and deletion route contracts remain authoritative.
- Reflection deletion addresses the exact immutable revision with If-Match of the current reflection revision. Other authored revisions survive. Account deletion requires recent authentication and revokes access before durable erasure.
- Independent intent precedes deletion acknowledgement. Complete means all supported active copies/keys are erased and the authenticated completion exists. Missing keys or unsupported copies fail closed.
- R2 listing uses at most 100 objects/page. Validate canonical identities, named retained keys, MACs, hashes and contiguous pass order. Pending chains never expire; later passes extend 30-day backup and 45-day ledger deadlines.
- Restore runs offline with ingress, egress and maintenance disabled; no public restore route. Erasure takes precedence over checkpoints. Clear sessions/challenges/exports, force AI permission off, block every nonterminal request and preserve conservative spend.
- Imported/context/revisit workflows remain Milestone 3. Their presence blocks unsupported replay rather than silently dropping copies. Hosted restore, general key rotation/purge and broader retention work keep their own gates.

## Review focus

1. Lost account-deletion response after auth revocation must still permit only scoped receipt status; no private data or duplicate intent.
2. Erasing an old reflection revision must never target the current revision or resurrect another erased revision through export/history.
3. Missing D1 deletion jobs, pending or malformed R2 chains, pagination and unknown keys must not permit a restored database to reopen.
4. A restored bookmark predating recovery/dispatch must not revive removed credentials, consumed codes, permission or paid-work authorization.
5. Concurrent/repeated replay and interruption around pass completion must preserve terminal live deletion, exact targets and monotonic backup/ledger deadlines.

### Task 1: Exact revision and account erasure

**Files:** `src/worker/readings/{erasure,erase-data,reflections,routes}.ts`, `src/worker/recovery/ledger.ts`, `tests/db/privacy-erasure.test.ts`.

**Interfaces:** Retain `SessionErasure.remove(session,id,revision,key,receipt)`. Add `removeAccount(session,key,receipt)` and `removeReflection(session,id,targetRevision,currentRevision,key,receipt)`. Shared ledger exposes authenticated intent/target/chain loading and immutable begin/complete operations; the data eraser accepts an exact supported ErasureTarget.

- [x] Write HTTP/D1 regressions for old/current revision erasure, export exclusion and surviving revisions; ownership/CSRF/CAS/recent-auth; account key/body/auth/checkpoint removal; durable receipts and R2 failure/retry; existing session behavior.
- [x] Run `npm run test:db -- tests/db/privacy-erasure.test.ts`; observe missing-route failures.
- [x] Implement owner-qualified logical fencing, durable independent intent, active-store erase and coarse receipt reconstruction. Keep session deletion compatibility and monotonic completion. Bound ledger listings and reject unexpected objects.
- [x] Run targeted privacy and existing reading tests, then `npm test`; expect all pass. Commit locally.

### Task 2: Offline restore replay and synthetic snapshot rehearsal

**Files:** `src/worker/recovery/{ledger,restore}.ts`, `src/worker/identity/crypto.ts`, `src/worker/index.ts`, `tests/fixtures/snapshot.ts`, `tests/db/privacy-restore.test.ts`, `package.json`.

**Interfaces:** `OfflineRestore` consumes explicit synthetic offline bindings plus retained recovery key material; `replay()` returns a content-free verified receipt only after erasure/checkpoint/key/content/runtime checks. No handler exposes it. Rehearsal restores actual local D1 table snapshots while preserving independent R2 objects.

- [x] Write failing D1 tests for a stale snapshot with deleted account/session/exact revision, used code and removed credential; missing deletion jobs; one surviving identical reading; no new dispatch; auth/consent/export invalidation and conservative spend.
- [x] Add failures for paginated listings, interrupted/repeated passes, incomplete/gapped/tampered chains, missing retained keys/checkpoints and unavailable surviving content keys. Assert offline Worker refuses private routes and scheduled work.
- [x] Run `npm run test:db -- tests/db/privacy-restore.test.ts`; observe missing service/behavior failures.
- [x] Implement authenticated complete listing, numeric pass chains, independent target replay before highest checkpoint, exact key/version validation and runtime reset. Reuse pending passes; new restore executions append a pass even for absent targets. Add `npm run restore:rehearse` for the synthetic local exercise.
- [x] Run the restore and privacy tests plus `npm test`; expect all pass. Commit locally.

### Task 3: Deletion UI, evidence and review

**Files:** `src/client/{identity,readings,deletion}.tsx`, `tests/browser/privacy.spec.ts`, `docs/PRIVACY_RESTORE_RESULTS.md`, `docs/LOCAL_RESTORE_RUNBOOK.md`, `README.md`.

**Interfaces:** Reuse API deletion contracts and scoped status tokens. Reflection controls name the exact revision; account controls require recent passkey auth, explicit consequence confirmation and a downloadable receipt. No silent browser persistence.

- [x] Write browser failures for deleting a selected old revision while preserving the current reading/reflection, and account deletion with a usable receipt after logout/lost response.
- [x] Implement the controls, RAM-only receipt recovery and status; preserve consent-off access and dirty-draft protections.
- [x] Run browser checks and `npm run verify`; expect all stages and prior regressions pass. Run `npm run release -- --check`; expect `deploymentAllowed:false`.
- [ ] Record exact local evidence, restore limits and remaining gates. Obtain one fresh whole-branch review, fix material findings with reproducing tests, run the complete gate, and commit locally. Keep branch unpushed.
