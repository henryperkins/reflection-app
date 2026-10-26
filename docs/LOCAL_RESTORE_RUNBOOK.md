# Local synthetic restore rehearsal

This runbook exercises the local application only. It does not provision, restore or deploy a hosted database. Use synthetic accounts and text. The accepted identity, complete-kit recovery and saved-reading baseline remains `7874fa2`.

## Run the rehearsal

Use the pinned Node 26 runtime and installed project dependencies:

```sh
npm run restore:rehearse
npm run verify
npm run release -- --check
```

The rehearsal uses the existing Workers test runtime and actual local D1/R2 bindings. The fixture snapshots D1 table rows, including public credential BLOBs, and restores those rows in a foreign-key-deferred batch. R2 remains independent. No external provider transport or hosted Time Travel call is used; the suite denies outbound fetch.

The main scenario creates surviving and deleted records, two reflection revisions and a separate account. It captures a bookmark before a provider-dispatch batch, then permits the simulated request to complete, erases selected records, and completes kit recovery to replace the original passkey. Restoring the bookmark loses those later D1 changes and deletion jobs. Replay must restore their privacy/security effects from the independent R2 ledger.

## Operator service sequence

`src/worker/recovery/restore.ts` exports `OfflineRestore` for the trusted local runner; no HTTP route exposes it. Construction requires exact synthetic-local identity/reading configuration and `RESTORE_MODE=offline`.

1. Stop user ingress and all competing operators/cleanup. Keep the explicit offline binding present throughout snapshot replacement, because a historical snapshot can rewind the database's own fence. The local runner exclusively owns its bindings; the in-process guard rejects overlapping calls. This is not a distributed production restore lock.
2. Call `prepare()` before replacing an accessible database. It persists the offline flag, disables dispatch, and flushes accessible pending security operations and erasures to independent storage. An unavailable dependency aborts preparation and leaves access offline.
3. Restore the chosen synthetic D1 snapshot. Preserve R2 and all required recovery/HMAC/key material. A handle/code recovery kit cannot replace operator keys.
4. Call `replay()`. It reestablishes the persistent offline flag before inspecting data. It completely lists the ledger in pages of at most 100 objects, checks inventory stability, authenticates all erasure chains and identity checkpoint identities, and gives account erasure priority.
5. Each target gets a new immutable erasure pass, or resumes its pending pass. Rebuild missing D1 job/receipt projections from the independent intent. Exact revision identity is preserved; absence of the source does not skip copy checks. Complete only after active erasure. Repeated passes extend the maximum 30-day backup and 45-day ledger deadlines.
6. For surviving accounts, apply the highest authenticated checkpoint; reject missing checkpoints or unavailable account keys. Clear sessions, challenges, export tickets and stale mutation keys. Append AI permission off, revoke grants, block every nonterminal generation request and release held product quota once. No old request redispatches. Set existing uncertain spend buckets to their ceilings and keep global dispatch off.
7. Check content against the current synthetic catalog, ciphertext authentication and foreign-key ownership. Unsupported imported/context-copy/revisit records fail closed. Only a successful content-free verification receipt clears the persistent offline flag. The runtime remains offline until the runner deliberately removes its separate binding.
8. Require fresh passkey sign-in. Verify exact surviving reading text, erased-record denial, cross-owner denial, revoked-factor rejection and consent-off record management. Provider dispatch remains disabled; this slice has no financial-fence clearing operation.

## Failure handling

- Missing, tampered, noncanonical, gapped or unexpected ledger objects; missing named recovery keys; missing checkpoints; or unavailable body keys: stop, preserve the evidence and keep access offline. Do not use an older checkpoint as an assumed replacement for a missing required state.
- An incomplete erasure pass remains pending with no promised backup deadline. Retry with the same independent objects after fixing the dependency; never overwrite a pass or completion.
- A lost account-deletion response does not restore account access. The client can download a receipt and query the public status endpoint with its scoped `X-Deletion-Token` header. The capability grants no reading access and is never placed in a URL or silently stored in the browser.
- Deletion after a bookmark can remove account checkpoints. Its independently authenticated account-erasure intent overrides them; never fabricate that account or its data.
- Missing account creation or keys inside a recovery window is not silently repaired. A separately acknowledged recovery procedure would be required; none is enabled here.

## Qualifications still open

Actual D1 Time Travel/RPO, hosted R2 replication/listing behavior, independent backup inventory assurance, cross-process operator exclusion, production key provisioning/rotation, ledger purge, broad retention/accounting cleanup, telemetry/alert delivery, hosted release isolation and real-device/browser/accessibility qualification need their own implementation and evidence. The local receipt is not permission to run this against production or serve real private data. Deployment stays disabled.
