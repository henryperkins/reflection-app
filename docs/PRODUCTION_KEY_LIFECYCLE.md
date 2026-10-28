# Key lifecycle operator procedures

Retained account DEKs, journaled replacement, authenticated current/backup reference inventory, checkpoint rollover and guarded retirement are implemented. Local synthetic tests cover interruption and restore using database snapshots, recovery objects and secret-copy formats. Actual Time Travel, hosted backup access and physical secret custody remain unqualified. These tools do not install or destroy production secrets.

Keep keys, requests, adapters and account receipts outside the checkout. Use separately protected backup/inventory storage and an independent signing authority for its complete manifest. Missing objects/listings never mean an empty inventory. Preserve the stable identity HMAC and account index key. Never place raw secrets in command arguments, stdout, Git or public evidence.

## Add and rewrap

Follow the [keyring format](LOCAL_KEY_ROTATION.md). Add a new active immutable key ID while retaining identical material for every old ID. The local `key:rotate` command accepts only its explicit local store. Hosted execution requires a binding-bearing operator, persistent coordinator fence and independent complete backup inventory. Rewrapping a DEK differs from replacing the encrypted records.

## Replace account data keys

`npm run key:rotate-account -- --help` documents `--request /private/request.json --adapter /private/bindings.mjs --receipt /private/new-receipt.json`. The request includes version 1, environmentId, ownerId, expectedVersion, sourceDigest, configurationDigest and `action:begin`; `action:resume` also includes operationId. The trusted adapter exports `withAccountRekey(request,execute)` inside the fenced executor and invokes the supplied service callback exactly once. No production bindings are inferred.

Independently close ingress/egress and establish the current `OfflineContext`. Replacement inventories every registered account-encrypted field, rewrites at most 20 fields per step with source-cipher comparisons, validates unchanged plaintext/provenance/AAD and stable index, then commits an immutable identity checkpoint. Sessions end; kit/factor identity remains. Prepared/authorized generation terminalizes conservatively, preserving liability. Deferred encrypted field families are covered without exposing their routes.

Retain old wraps through interruption and validation. Explicitly adopt a current lease when resuming; stale leases fail. Resume the journal rather than beginning another migration. Deleted accounts cannot resurrect. Success receipts contain counts/digests/version transitions and leave ingress/generation off. Failure records offline state as unverified; inspect protected progress and preserve both versions.

## Inventory and retirement

`inventoryKeyReferences(runtime,context,backups)` performs two authenticated scans under one persistent offline invocation. It authenticates D1 envelopes/wrap bytes, operational references even with null ciphertext, checkpoint/erasure chains and signed backup copies. Current recovery objects require an independent signed exact-name/digest attestation at the coordinator epoch. Paginated listing alone is insufficient. Pending journals/security/erasure, missing keys, partial lists or changing inventory retain keys conservatively.

`npm run key:retire -- --help` exposes plan, account-DEK plan, apply and candidate-check modes through an explicit trusted adapter. Operator requests record source/configuration; plans pin epoch, installed material, two-scan references and a short validity window. Apply rescans; active, referenced, backup-dependent or incomplete candidates fail. Account DEK deletion and its audit are atomic. Bundle retirement writes a protected candidate only; it neither installs nor destroys material. Candidate checking preserves stable verifier material and exactly the remaining keys.

`rolloverIdentityCheckpoint` creates a new immutable current checkpoint under the active bundle, preserving factors, spent codes and kit verifiers. Old objects remain dependencies until independently proven unused. Never assume local retention covers provider backups, exports or physical copies. Restore each declared backup class and verify exact saved content, kit identity, rejected old factors/codes and surviving deletion receipts.

## Resume and evidence

Follow [hosted recovery](HOSTED_RESTORE_RUNBOOK.md). Completion never opens ingress. Protected `RecoveryValidation`, matching D1 mirror/coordinator epoch, drained writers and generation off are required. Secret installation/destruction remain separate explicit operations after backup verification.

Public evidence contains environment/build identity, artifact/source/configuration digests, counts, fixed assertions, times and limitations. Protect account/record IDs, key files, raw queries and detailed journals separately. The `keys` acceptance gate stays pending until actual hosted lifecycle and every supported backup class have been exercised.
