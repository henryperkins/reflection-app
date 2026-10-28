# Local key rotation

The local application accepts an explicit active key and retained keyring through its `IDENTITY_SECRETS` binding. New account wraps, checkpoints and erasure-ledger objects use the active bundle. Existing envelopes select their named retained key. Deletion receipts keep working after rotation, including when the D1 status projection survives or is rebuilt from R2.

This is synthetic local implementation and verification. The operator does not deploy, generate secrets, contact a provider, remove old keys or qualify hosted key recovery. Runtime keys remain server-readable.

## Configuration

The former flat `{environment,keyId,wrapKey,recoveryKey,hmacKey}` configuration remains readable. The versioned configuration is:

```json
{
  "v": 1,
  "environment": "synthetic-local",
  "activeKeyId": "local-v2",
  "identityHmacKey": "<the unchanged identity HMAC secret>",
  "keys": [
    {
      "keyId": "local-v1",
      "wrapKey": "<retained wrapping secret>",
      "recoveryKey": "<retained recovery encryption secret>",
      "hmacKey": "<retained recovery authentication secret>"
    },
    {
      "keyId": "local-v2",
      "wrapKey": "<new wrapping secret>",
      "recoveryKey": "<new recovery encryption secret>",
      "hmacKey": "<new recovery authentication secret>"
    }
  ]
}
```

Place supplied material in protected JSON files outside the checkout. Each key is a canonical base64url encoding of exactly 32 bytes. Key IDs are unique and immutable. There are at most 32 retained/current bundles. On the first migration from a flat configuration, `identityHmacKey` equals that configuration's `hmacKey`. It remains unchanged: session, CSRF, recovery-kit and idempotency verifiers have no per-row key ID. Ledger HMACs can rotate independently. Configuration errors never print submitted material.

The operator refuses all key retirement, even when current account wraps have moved. Database backups and offline copies can retain old wraps; pending ledger references retain their keys indefinitely. This local runner has no complete inventory proving that the documented 30-day backup window plus margin or checkpoint/ledger retention has elapsed. Do not bypass that guard by omitting keys from the current file.

## Local procedure

1. Keep protected copies of the current and candidate configurations and of the local D1/R2 store. The candidate retains every current key with identical material and selects the new active ID. The command supplies no key generator.
2. Validate the supplied configuration without opening the store:

   ```sh
   npm run key:rotate -- --check-config --current /secure/current.json --candidate /secure/candidate.json
   ```

3. Stop the local application and maintenance runner. Only one operator may own the store. Rewrap the existing local store and reserve a new audit receipt:

   ```sh
   npm run key:rotate -- --rewrap --current /secure/current.json --candidate /secure/candidate.json --persist-to .wrangler/identity-development/v3 --receipt /secure/rotation-operation.json
   ```

   `--persist-to` names the existing **v3 resource directory**, one level below Wrangler's `--persist-to` directory. Local binding IDs match `wrangler.identity.jsonc`: D1 `DB` and R2 `reflection-identity-local-checkpoints`. No production configuration or remote-binding option is accepted.

4. The command fences writes and generation, flushes accessible pending security/erasure operations, then verifies account wraps, retained security snapshots, checkpoint prefixes/epochs, complete erasure chains and cleanup state. It rewraps up to 20 account-key rows per D1 batch with comparisons against the old wrap ID and ciphertexts. Both DEK and stable index bytes are decrypted and checked before updating. Each row keeps its account key version; private reading bodies are unchanged. Interruptions resume by scanning remaining old wrap IDs. Retry with the same current/candidate files and a new receipt path.
5. The successful receipt contains operation ID, times, key IDs, counts and an inventory digest. It contains no keys, account IDs or personal bodies. A started-only receipt means completion was not recorded. The database remains offline and generation remains disabled. Do not start it with a stale binding: install the candidate `IDENTITY_SECRETS` through the trusted local runtime configuration before the existing offline restore validation/replay reopens local reads. `dev:identity` continues to read its checked-in public synthetic configuration until that binding is explicitly changed.

`--check` with the same file/path arguments validates an already fenced store without changing account wraps. `--help` works without keys or a database. A process crash can leave `.key-rotation.lock` in the resource directory; remove it only after confirming that no local operator, app or maintenance process is running.

## Supported scope

KEK rotation rewraps existing account keys; recovery encryption/HMAC rotation selects a new bundle for new immutable objects and keeps all old verification/decryption keys. New security mutations checkpoint under the new recovery key. Existing checkpoints and erasure intents are never rewritten for retirement.

The cryptographic layer authenticates explicit account data-key versions and preserves the legacy version-one wrapping format on read. This operator does **not** perform an account DEK rewrite across every personal field, migrate the stable account index/HMAC identity, retire an identity verifier secret, or remove a recovery key. Those operations require their own complete migrations and backup evidence.

Targeted verification covers retained wraps, explicit key-version binding, rotated receipts, shared-HMAC checkpoint prefixes, resumable rewrap, corruption/online-write refusal, add-only key retention, and the standalone CLI against persistent synthetic D1/R2. Hosted secrets, offline backup recovery and production concurrency remain external qualifications.

## Account data-key replacement

The explicit `AccountRekey` operator complements add-only environment-key rewrap.
It inventories every reviewed account-data encrypted field in batches of at most
20, replaces the DEK, and retains exactly the same stable account index key.
Recovery-key ciphertext stays in its own family. The journal stores field
identities, ciphertext hashes and keyed value hashes, with no raw key or record.
Each rewrite and its progress commit in one compare-and-swap D1 batch.

Stop local processes or use the persistent hosted offline coordinator. Prepare
security and erasure work first. Supply a trusted binding adapter and a private
request with exact environment, account, expected version, source/configuration
digests and `action:begin` (or `action:resume` plus operation ID):

    npm run key:rotate-account -- --request /private/request.json --adapter /private/bindings.mjs --receipt /private/new-receipt.json

The adapter exports `withAccountRekey(request, execute)` and supplies the fenced
service to `execute`; it belongs to the controlled operator executor, outside
the product HTTP routes. The release/hosted drill workflow must validate its
source, target bindings and access. The CLI does not infer production bindings
or activate an environment. Malformed inputs are rejected before adapter code
loads; new receipts use mode 0600.

Stages are inventorying, rewriting, validating, checkpoint and complete. After
a crash, retain both wrapped versions and resume the recorded operation with a
fresh service instance. A lost/superseded lease requires a newly acquired rekey
context and explicit `adopt`; a D1-restored epoch never grants authority.
Missing keys, registry/source changes, unexpected pending security/erasure, or
extra/missing fields leave the target offline. Account deletion cascades the
journal and wraps and cannot be reversed by resume. Completion invalidates old
sessions through a serialized immutable identity checkpoint and keeps ingress
and generation off. A separate restore-validation and financial-reconciliation
receipt is required before resume. Production secret installation and hosted
qualification remain separate from these synthetic regression results.

Journal rows participate in the existing owned-row storage accounting. Retain
unfinished journals and both wrapped versions; completed audit retention and
capacity must be considered when planning large rotations. No journal is silently
purged to make a key appear unreferenced.

## Independent key-reference inventory

`inventoryKeyReferences(runtime, context, backups)` runs two authenticated scans
inside one persistent offline invocation. It authenticates every account wrap
and encrypted field, security operation, identity checkpoint, erasure chain,
cleanup state and unfinished rekey. It also verifies every registered D1,
recovery and offline-key backup against independently stored signed manifests.
Both missing copies and physically present unregistered copies fail closed.

The signed independent index must include exactly one current recovery-store
attestation: `kind:recovery`, `purpose:inventory`, the coordinator's exact
`coordinatorEpoch`, and the complete `recoveryObjects` key/SHA-256 list. Store
that metadata object separately from actual backup copies (`purpose:backup`).
`recoveryEpoch` remains the D1 cleanup floor; it never substitutes for the
coordinator epoch. A protected attestation must be refreshed after intentional
checkpoint/cleanup changes. It does not contain a recoverable copy by itself.

The full inventory is private operational data. Store it outside the repository
and public evidence. `summarizeKeyInventory` emits only counts, observation time
and digest. Its reference digest binds ciphertext and wrap bytes, not only key
IDs; any change between scans invalidates the result. Missing/incomplete
inventory conservatively retains every installed environment bundle.

An immutable checkpoint rollover under the active recovery bundle preserves
credentials, used-code state and the kit verifier while advancing the serialized
identity epoch and invalidating old sessions. It preserves prior objects. Current
checkpoints retain their keys for their entire lifetime; superseded checkpoints
have the existing 45-day minimum, with supported backup references retaining
needed keys for as long as those actual copies remain registered. No local
30-day assumption proves that hosted or offline backups have expired.

## Guarded retirement

`key:retire` is separate from the existing add-only rewrap command. Generate a
protected plan from a fresh complete inventory, then apply it inside the trusted
offline executor. Environment-bundle application rechecks the installed keyring,
coordinator epoch, registry, current object/backup evidence and every reference.
It writes an idempotent content-free audit and prepares a candidate; it does not
install a secret or destroy any retained copy.

    npm run key:retire -- --plan --current /private/keys.json --inventory /private/inventory.json --remove old-key --output /private/plan.json
    npm run key:retire -- --apply --plan /private/plan.json --adapter /private/bindings.mjs --candidate /private/new-keys.json --receipt /private/new-receipt.json
    npm run key:retire -- --check-candidate --current /private/keys.json --candidate /private/new-keys.json --receipt /private/new-receipt.json

The adapter exports `withKeyRetirement(plan, execute)` and supplies the exact
`{runtime, context, backups}` to `execute`. It cannot report success without
running the guarded operation. Keep adapters, full inventories, source keyrings
and candidate files outside public evidence. Outputs are new files with mode
0600. The candidate check is a file/material preflight; installation additionally
requires current authenticated references under the controlled executor. An
expired plan, changed evidence, referenced/active key, changed retained material
or changed stable verifier is rejected.

For obsolete account-DEK rows, `--plan-data --inventory /private/inventory.json
--owner account-uuid --version 1 --output /private/data-plan.json` prepares a plan.
Apply it with `--apply --plan … --adapter … --receipt …` and no candidate path.
The guard also checks operational key-version references, unfinished rekeys and
backup requirements, and compares the retired/current stable index bytes.
Deletion of the wrapped row and its receipt commit in one D1 transaction. A
retry verifies the same operation rather than deleting another version.

A prepared environment candidate must pass the same-kit, exact saved-content,
export, deletion/receipt and supported-backup restore rehearsal before any real
secret-store change. Synthetic tests cover D1, recovery-object and secret-copy
formats in isolated storage; they do not certify physical offline custody or
production recovery. Retain the installed material until controlled installation
and independent-copy destruction have their own actual evidence. Stable identity
and account index verifiers remain outside ordinary retirement. Every operator
path leaves admission/generation closed until explicit validated resume.
