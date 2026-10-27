# Production Key Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Support resumable account data-key replacement and evidence-based retirement of obsolete data/wrapping/recovery keys without losing saved records, recovery access or deletion receipts.

**Architecture:** Extend the existing retained keyring and add-only rewrap. During an enforced offline maintenance window, journal bounded account-DEK rewrites, preserving stable index keys and immutable payload revisions. Retire a key only after a complete authenticated inventory proves no supported live, recovery or backup object needs it.

**Tech Stack:** Existing TypeScript/Web Crypto AES-GCM/HKDF/HMAC, D1 batches, R2 immutable recovery objects and the hosted offline coordinator introduced by P2.

**Spec:** [Security/restore](../../architecture/SECURITY_RESTORE.md), [data lifecycle](../../architecture/DATA_LIFECYCLE.md), [local key rotation](../../LOCAL_KEY_ROTATION.md), [production acceptance](../../PRODUCTION_ACCEPTANCE.md), and [production qualification plan](2026-10-27-production-qualification.md).

## Global Constraints

- Baseline `a553695` already supports retained keys, retained receipts and add-only KEK rewrap. Do not repeat that implementation as new work.
- Preserve `256-bit` account DEKs and a separate stable `256-bit` account index key. Ordinary DEK rotation carries the same index bytes across versions.
- AAD retains environment, owner, table, column, record identity, immutable `aadRevision` and `keyVersion`. Save/status/lease revision changes must not change field AAD.
- Identity/session/recovery-verifier HMAC identity remains stable. Compromised index or identity-verifier replacement requires a separate versioned reindex/verifier migration; ordinary DEK/KEK rotation must not silently perform it.
- Never rewrite immutable erasure targets to remove a key dependency. Pending references retain keys indefinitely. Superseded identity checkpoints have a `45-day` minimum retention, extended by any other reference.
- Retain the existing `32`-bundle keyring bound; reaching it requires planned retirement or a reviewed schema change, never dropping a referenced key.
- R2 recovery checkpoints contain no account DEKs, journals, prompts, raw recovery codes, sessions or exports. Keep secret backups separate from D1 and from public receipts.
- Local in-process exclusion is valid only for the single-process local runner. Hosted work requires P2's independently enforced offline fence and exclusive coordinator.
- Rotation and cleanup finish offline. Generation resumes only after restore validation, financial reconciliation and an explicit operator state change.

## Review Focus

- Mixed key versions after a crash must remain decryptable without returning partially validated data; test K1/K2.
- A forgotten encrypted column, embedded version or stale version-one guard must stop completion; registry closure tests in K1/K2.
- Stable intent/import/deduplication HMACs and recovery kits must survive ordinary DEK rotation; test K2.
- An old backup or a current identity checkpoint can still need an apparently unused key; test K3/K4.
- Lost coordinator leases and delayed R2 writes must not allow purge, rekey or key removal from a stale inventory; test K3/K4 and P2.

---

## Dependency and file boundaries

K1/K2 can first be proven against synthetic local stores. Hosted execution of K2–K4 depends on P1/P2 runtime isolation, persistent exclusion and the independent backup inventory. These tasks produce the code and procedures for the `keys` gate; P4 supplies real hosted evidence.

| Unit | Responsibility |
| --- | --- |
| `readings/crypto.ts` | Authenticate field envelopes and select an explicitly named account key version |
| `recovery/private-fields.ts` | Reviewed, registry-complete map of fields and their encryption family/AAD |
| `recovery/account-rekey.ts` | Durable, bounded, resumable DEK rewrite and final validation |
| `recovery/key-inventory.ts` | Reference inventory across D1, immutable recovery storage and independent backups |
| `recovery/key-retirement.ts` | Check retirement eligibility and produce a reviewed next-keyring plan |
| `scripts/key-rotate-account.ts`, `scripts/key-retire.ts` | Trusted offline operator entrypoints; no public HTTP mutation routes |

## K1 — Make active record access aware of retained data-key versions

**Files:** Modify `src/worker/readings/crypto.ts`, `base.ts`, `records.ts`, `reflections.ts`, `export.ts`, `generation.ts`, `erasure.ts`, `erase-data.ts`, `src/worker/identity/crypto.ts`, `src/worker/recovery/restore.ts`, `src/worker/db/publication_guard.sql` and its generated TypeScript projection. Create `src/worker/recovery/private-fields.ts`, `tests/db/data-key-versions.test.ts`.

**Interfaces:** Define `RecordFieldIdentity = {ownerId: string; table: string; column: string; recordId: string; aadRevision: number}`. Change `RecordCrypto.seal(field: RecordFieldIdentity, value: unknown, keyVersion: number): Promise<string>` to require the write version. Change `RecordCrypto.open<T>(field: RecordFieldIdentity, ciphertext: string, schema: z.ZodType<T>): Promise<T>` to authenticate the envelope's retained version against the owner's wrapped-key row; it must not trust an arbitrary unregistered key. Export a reviewed `PRIVATE_FIELD_HANDLERS` list with explicit `account-data` or `recovery` key family and identity/revision extraction for each encrypted column.

- [ ] Add failing tests opening authenticated v1 and v2 records for the same account, rejecting cross-owner/AAD/version tampering, and creating a reflection/new reading at current v2. Assert exact saved JSON and export values are unchanged.
- [ ] Add a registry-closure test: every class `E` column has one reviewed handler; every handler names an actual registry column with the correct AAD rule. Recovery-key ciphertext is never passed to the account-DEK rewriter. Include encrypted fields in deferred-feature tables if records exist; this does not enable those routes.
- [ ] Run `npm run test:db -- tests/db/data-key-versions.test.ts` and confirm the existing version-one assumptions fail the new cases.
- [ ] Update call sites to use account/request versions explicitly and retained envelope versions on read. Replace `key_version=1` predicates in reflection and generation with current expected-version comparisons. Keep stale-request/key-fence rejection in publication and dispatch; do not remove version guards merely to accept v2.
- [ ] Add missing version/AAD details to the field registry if discovered, regenerate mirrors and the publication-guard projection, then run registry/SQL/type checks and existing readings, reflection, export, privacy and key-rotation tests. Commit the version-aware access slice.

## K2 — Journal and resume complete account-DEK replacement

**Files:** Create `src/worker/recovery/account-rekey.ts`, `src/worker/db/migrations/0012_account_rekey.sql`, `scripts/key-rotate-account.ts`, `tests/db/account-rekey.test.ts`, `tests/tooling/account-rekey.test.ts`. Modify `src/worker/db/column-registry.json`, `scripts/package.ts`, `package.json`, `src/worker/recovery/restore.ts` and the key runbook. This follows L1's `0009`, L4's `0010` and P2's `0011`; renumber consistently if another migration lands first.

**Interfaces:** `AccountRekey(base: RecordBase, coordinator: OfflineCoordinator)` exposes `begin(ownerId: string, expectedVersion: number): Promise<{operationId: string; targetVersion: number}>`, `step(operationId: string, limit: 20): Promise<{phase: 'rewriting' | 'validating' | 'complete'; rewritten: number}>`, and `validate(operationId: string): Promise<RekeyReceipt>`. `OfflineCoordinator` comes from P2; local tests use an explicitly local implementation. `RekeyReceipt` has operation identity, versions, counts, registry/inventory hashes and `stillOffline:true`; public summaries omit account IDs and ciphertext.

- [ ] Add tests with a saved reading, multiple reflection revisions, unsaved draft, prepared request, durable candidate and all applicable registry fields. Crash after each batch, resume with a new service instance, and assert no record loss or skipped field.
- [ ] Assert identical decrypted records, unchanged stable-index HMACs/idempotency, unchanged field `aadRevision`, fresh nonces and incremented data-key versions. Refuse changed source ciphertext, missing keys, changed registry, unexpected pending security/erasure jobs and a stale coordinator lease.
- [ ] Run `npm run test:db -- tests/db/account-rekey.test.ts` and `npm run test:domain -- tests/tooling/account-rekey.test.ts`; confirm the new operator behavior fails before implementation.
- [ ] Under P2's offline fence, drain or terminalize in-flight generation conservatively, flush security/erasure operations, and persist the expected account version plus registry snapshot. Generate a fresh DEK, rewrap the **same** index bytes for the new version, and retain the prior account-key row. Persist only wrapped keys; no raw key enters a journal or receipt.
- [ ] Rewrite in bounded compare-and-swap batches using K1's explicit handlers. Commit field changes and progress together; validate complete coverage and hashes before the final account-version transition. Reconcile any account-owned operational version fields deliberately; historical model/source/prompt provenance stays unchanged. The offline fence prevents all normal reads/writes during mixed state.
- [ ] Validate every surviving ciphertext and original record value, then mark the operation complete and invalidate stale sessions/requests as required through the existing checkpoint/epoch mechanism. Do not release the offline fence. On deletion, erase job state and both wrapped keys without recreating the account from the journal.
- [ ] Verify restore on snapshots taken before, during and after replacement, including the same stable-index identity. Run schema/registry checks and the affected record/recovery tests; commit code and resumable operator instructions.

## K3 — Inventory every live, recovery and backup key reference

**Files:** Create `src/worker/recovery/key-inventory.ts`, `tests/db/key-inventory.test.ts`, `tests/tooling/key-inventory.test.ts`. Modify `src/worker/recovery/key-rotation.ts`, `ledger.ts`, `cleanup.ts`, `cleanup-state.ts`, `src/worker/identity/checkpoint.ts` and `docs/LOCAL_KEY_ROTATION.md`. Hosted backup/coordination adapters are P2/P4 deliverables.

**Interfaces:** `inventoryKeyReferences(context: OfflineContext, backups: BackupInventory): Promise<KeyReferenceInventory>` enumerates account wraps/DEK versions, security operations, every erasure chain and completion, checkpoint prefixes, cleanup/rekey journals and supported database/recovery/offline-key backups. `KeyReferenceInventory` contains authenticated environment, coordinator epoch, registry hash, manifest digest, observed time, referenced key IDs, counts and `complete:boolean`; inaccessible stores produce an incomplete result, never an empty inventory. `BackupInventory` is defined in P2.

- [ ] Test multi-page and reordered listings, missing/duplicate manifests, missing offline copy, current and superseded identity checkpoints, unfinished erasure passes, wrapped old DEKs in an older database and objects arriving after the first scan.
- [ ] Run the targeted inventory tests and verify they fail before implementing the inventory.
- [ ] Reuse authenticated chain verification and cleanup epochs. Check named-object/count completeness against independently retained manifests, not only the bucket listing. Repeat the inventory under the same exclusive offline epoch; any change invalidates retirement eligibility.
- [ ] Add a supported rollover operation that creates a new immutable current identity checkpoint under the active recovery bundle at the next serialized epoch. Preserve the prior checkpoint through its retention and backup references; never overwrite it. Verify kit usability, removed-passkey rejection and used-code rejection across this rollover.
- [ ] Keep retention based on actual supported hosted backups and margins. The local `30-day` backup assumption cannot establish that hosted/offline copies expired. Run inventory, checkpoint, cleanup and restore regressions; commit the inventory and rollover slice.

## K4 — Retire only keys proven unnecessary, then rehearse recovery

**Files:** Create `src/worker/recovery/key-retirement.ts`, `scripts/key-retire.ts`, `tests/db/key-retirement.test.ts`, `tests/tooling/key-retirement.test.ts`. Modify `src/worker/recovery/key-rotation.ts`, `package.json` and the key/operations runbooks.

**Interfaces:** `planKeyRetirement(current: IdentityKeyring, inventory: KeyReferenceInventory, keyIds: string[]): RetirementPlan` returns candidate retained IDs, evidence hash, expiry and reasons for any rejection. `applyKeyRetirement(context: OfflineContext, plan: RetirementPlan): Promise<RetirementReceipt>` revalidates the inventory/epoch and creates a protected candidate keyring; a separate secret-store installation step uses the same reviewed plan. An obsolete account-DEK row is eligible only when neither active fields nor any supported backup require that version.

- [ ] Add failures for active key removal, a pending erasure dependency, lifelong current checkpoint, old supported backup, expired/incomplete inventory, changed secret material under an existing ID, changed stable identity/index key and lost coordinator epoch.
- [ ] Run targeted retirement tests to confirm those guards do not yet exist.
- [ ] Implement check/plan/apply with content-free receipts and idempotent operation identity. Keep the existing add-only rewrap API add-only; expose retirement only through this explicit evidence-bearing operator. Preparing a candidate file does not itself delete a secret or destroy an offline copy.
- [ ] Rehearse removal with synthetic keys: install the candidate, validate ordinary reads/export/deletion, rotate/verify deletion receipts, recover with the same kit and restore **every supported backup class**. Missing dependencies keep the application offline and retain the old protected key material for diagnosis.
- [ ] Prepare the concrete secret-retirement action for operator review only after the evidence exists. Destroy retired secret copies according to the approved inventory policy, record completion and validate the installed keyring. Keep stable verifier keys explicitly outside this ordinary retirement operation.
- [ ] Run the key/restore/privacy regression suites, then `npm run verify` on the integrated candidate. Deliver receipts and limitations to P4; a local success cannot mark the production `keys` gate verified.

## Completion criteria

The key implementation is complete when interrupted DEK replacement resumes safely, saved content and stable identity survive, every encrypted field is accounted for, all supported backups restore with their retained keys, and an actually unreferenced key can be retired through the guarded operator. Production acceptance additionally requires provisioned secrets, restricted access, independent inventory and a witnessed hosted recovery drill. The companion [production plan](2026-10-27-production-qualification.md) owns that evidence.
