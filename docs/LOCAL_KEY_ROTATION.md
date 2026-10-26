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
