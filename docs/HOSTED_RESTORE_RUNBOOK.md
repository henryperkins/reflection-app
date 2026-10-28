# Hosted synthetic recovery qualification

Status: the application recovery/key services and private orchestration harness are implemented and tested locally. Actual hosted D1 rollback, Cron crash, Time Travel, independent backup and credential-isolation drills have not run. A passing local fixture is not hosted qualification.

## Explicit executor and target

`npm run hosted:qualify -- --plan` prints the six scenario protocols. `npm run hosted:restore -- --plan` limits the same harness to recovery/key scenarios. Execution requires absolute paths to `--request`, `--adapter` and a new `--receipt`. Keep requests, binding adapters and raw proofs outside the checkout. Receipts are created exclusively with mode 0600; errors report no raw exception or private inputs. No public application route imports these commands.

The request contains the exact P3 `candidate`, a protected `authorization` and one `scenario`. Authorization fields are version 1, accountId, environmentId, applicationDigest, artifactDigest, configurationDigest, expiresAt (within 24 hours), allowedScenarios, acceptedRpoMs and acceptedRtoMs. Agree the recovery targets before running, rather than choosing them from the result. Missing authorization, production mode, changed resources/artifacts, expired context or incomplete evidence fail closed.

The trusted adapter exports `hostedQualificationAdapter` with `inspect()`, `run(scenario)` and `readEvidence(sha256)`. It must authenticate directly to the allowlisted synthetic account, inspect the current deployed artifact/configuration/resource bindings, verify paid-provider credentials are absent, and use an isolated provider stub with an independent durable call counter. No deployed adapter or synthetic fault endpoint has been provisioned. This is an explicit operator trust boundary: schemas and evidence hashes cannot establish that an adapter really performed a procedure. Keep its implementation and captured proofs for audit; never treat a hand-authored observation JSON as execution evidence.

The harness compares deployment identity before and after each scenario, requires every prescribed assertion, checks proof bytes against their SHA-256, and emits only fixed assertion/limitation codes, digests, environment identity, times and numeric measurements. Proof bytes may be private and are never printed. A resulting receipt has `evidenceAuthority:trusted-operator-adapter`; qualify its authenticity from the protected executor and actual captured queries/counters. It never grants production activation or automatically closes a gate.

## Scenario procedures

| Scenario | Required actual procedure |
| --- | --- |
| `batch-rollback` | Inject failure mid-publication in the normal primary D1 batch. Compare reading, evidence, quota and event rows before/after; all preceding changes roll back. |
| `request-races` | Race duplicate Start, cancellation, permission revocation, deletion, key change and lease expiry against dispatch/publication. Lose an acknowledgement. Prove one publication/dispatch and compensation in original quota buckets. |
| `scheduler-crash` | Overlap Cron, miss a wake and terminate separate processes before dispatch, after authorization, after response and after durable candidate. Compare the external stub counter and durable journal. Never resend an authorized call. |
| `stale-restore` | Save a marker and bookmark; remove a factor, spend a recovery code, revoke permission, delete the marker and retain the receipt. Include an admitted pre-dispatch request. Disable ingress and egress independently, restore, replay, then prove absent marker, rejected factor/code, consent off, no redispatch and preserved liability/receipt. |
| `recovery-loss` | Repeat with absent/corrupt recovery objects, partial listings, missing retained key and missing inventory. Every variant stays closed. Repeat completed deletion and interrupted cleanup after restore; retention cannot shorten. |
| `key-lifecycle` | Rotate wraps, replace all account DEKs, roll the checkpoint and interrupt/resume. Reject referenced retirement, accept genuinely unused retirement, then restore each backup class and prove exact saved content, kit identity and deletion receipts. |

The code's `scenarioAssertions` is the exact machine-readable assertion list. Each requires a captured proof hash; missing, duplicate or unknown assertions fail. Recovery/key success additionally requires measured RPO/RTO within the predeclared limits and evidence for D1 Time Travel, recovery objects and protected secret copies. Any exported/offline copy expands the supported inventory and requires an additional drill; do not claim it was tested by exercising D1 alone.

## Persistent recovery fence

Use the environment's `HostedCoordinator` and explicit `OfflineContext`. Independently close ingress/egress before restoring D1; acquire the persistent coordinator fence, drain whole-invocation registrations and require actual quiescence. A crashed writer registration does not expire open. Coordinate external termination/reconciliation before proceeding. An offline operation has a bounded lease and durable epoch; expiry never authorizes ingress.

Construct `OfflineRestore` with the exact hosted runtime, coordinator/context, retained keys, approved-content validator and independent `ProtectedBackupInventory`; never infer bindings from database IDs or local environment defaults. Call `prepare()` before restoring the bookmark, then `replay()` against the restored database. The separate signed inventory must include the complete backup list and current recovery-object attestation. Missing/partial inventory, invalid chain, unavailable key or unsupported content leaves the environment closed. Follow [key lifecycle procedures](PRODUCTION_KEY_LIFECYCLE.md) for replacement/retirement dependencies.

Record the actual provider restore window, captured bookmarks, backup class/copy inventory, RPO loss interval and measured RTO in protected proofs. The local SQLite snapshot fixtures do not establish Time Travel behavior, physical secret custody or exported-copy availability. Checkpoint/erasure replay must survive a second restore and interrupted cleanup.

Completion alone does not reopen ingress. Resumption requires a protected byte-verified `RecoveryValidation`, matching D1 validation mirror and independent coordinator epoch, drained writers and generation off. Resume keeps generation disabled. A failed CLI receipt says offline state is unverified; inspect the coordinator rather than assuming the error established a fence. Preserve every retained key/copy until the independent inventory proves it is unused.

## Evidence and limits

Record exact source, configuration, artifact and environment identities, runner/build identity, scenario times, raw-proof custody and limitations. Always distinguish stub protocol behavior from the single live GPT-6.1 Terra development smoke. Do not run crash injection against a paid provider. Hosted release, database, restore and keys gates remain pending until these actual scenarios have run on the frozen candidate.
