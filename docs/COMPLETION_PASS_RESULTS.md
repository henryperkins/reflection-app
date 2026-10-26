# Local completion pass

Baseline: `011b21e`, branch `codex/milestone-2-completion-pass`. Deployment and live-provider transmission remain disabled. The owner clarified during this pass that public-domain, geography, age and budget decisions are unimportant to this local delivery; the verified local ZIP is delivered without waiting for production approval. This is not a claim of completed real-user rollout qualification.

## Implemented

- Account passkey listing, additional enrollment, removal, recent existing-passkey proof, ten-passkey limit and last-factor protection. Factor changes preserve recovery material and saved-content keys, advance the independent security checkpoint, and revoke other sessions. Logout-all now records its epoch through the same checkpoint saga before acknowledging success. Recovery rate counters count failed attempts rather than successful recovery.
- Generation uses durable request/plan/candidate records for bounded recovery. Before-dispatch work can resume; a committed dispatch is never deliberately sent again. Persisted candidates survive worker-memory loss and are checked before atomic publication. Accepted interpretation uses the validated candidate, with separately code-rendered facts and exact source information. Enumerated failures may produce a labelled template that releases product quota; uncertain provider liability remains reserved.
- Local admission and candidate checks have a versioned, bounded safety policy. These are mechanical checks, not a guarantee of semantic correctness. A disabled OpenAI Responses adapter has intercepted protocol/timeout/refusal/response-size tests. It is not wired to live credentials in the local application.
- Strict active/retained environment keyrings preserve stable identity/index verifiers; previous wraps and deletion receipts remain verifiable. A local add-only key-rotation operator inventories retained recovery state and CAS-rewraps unchanged account DEK/index bytes. It leaves the database offline. Full account-DEK rewriting and key retirement remain unsupported, rather than being partially enabled.
- Scheduled maintenance reports aggregate queue/security/erasure/spend health without selecting private bodies or identifiers. Operational runbooks identify incident, erasure-delay, backup/restore and key-recovery procedures.
- A 78-card/156-entry textual launch-canon draft is prepared with exact source/bundle hashes. Its human approval and rights are explicitly pending; ordinary content guards reject activation of this draft.
- Release checking validates source-bound external evidence records and keeps deployment disabled. Packaging produces deterministic archives with per-file and archive SHA-256, verification records and explicit local-delivery status; completed-production acceptance cannot be inferred from a local ZIP.

## Verification evidence

The final `npm run verify` writes a source digest, all stage results and elapsed time to `artifacts/verify.json`. Executed counts are in `artifacts/domain-tests.json`, `artifacts/db-tests.json` and `artifacts/browser-tests.json`; the gate rejects failed, skipped and flaky cases. The ZIP includes these records. `npm run release -- --check` rejects stale verification and reports remaining production gates.

Targeted RED→GREEN checks cover account controls, crashed/restarted generation, candidate fidelity, intercepted provider behavior, retained-key receipts/rotation, and delivery qualification/packaging. A new generation SQL projection check ensures the Worker-bundle-safe TypeScript string exactly matches the authoritative publication guard SQL.

Browser validation uses the existing Playwright workflow because the Browser plugin is unavailable. The integrated tests use real local Worker/D1 routes with virtual authenticators. Additional rendered checks covered the account controls at 1100×850 and 320×850, 200% text sizing without horizontal overflow, disabled last-passkey removal, logout-all, and starting/saving a reading. There were no page exceptions or unexpected HTTP failures; the initial signed-out `/me` 401 is expected. Screenshots were inspected outside the source archive. Physical authenticators and human screen-reader acceptance remain unperformed.

## Independent review corrections

The independent review of this pass identified delivery/runtime regressions that fresh databases alone did not cover:

- Packaging initially omitted `.node-version` and `.npmrc`, so extracted source could not match the verification digest. A failing extraction regression now protects both dotfiles and digest equality.
- Logout-all advanced the live auth epoch without an independent checkpoint. That blocked key rotation and offline restore. It now uses checkpoint commit/apply; both restoration and rotation regressions cover the behavior.
- A baseline persistent database could retain the older synthetic provider-policy hash and block new work after upgrade. The migration path must preserve offline/generation/financial fences while rejecting unknown policy identities.
- Bounded safety matching initially misclassified an ordinary personal name and nonmedical “treatment of others.” Explicit benign-context cases accompany the sensitive-input cases.
- Concurrent accounts could propose the same credential ID and leave the losing account security-fenced. Credential IDs are reserved atomically with the initial checkpoint fence so uniqueness failure rolls back before an impossible pending checkpoint can be committed. Provisional credentials remain unavailable until checkpoint application.

The final review result and final executed counts are reported with the delivered ZIP. [Production acceptance](PRODUCTION_ACCEPTANCE.md) lists the external evidence this local pass cannot supply. [Local delivery](LOCAL_DELIVERY.md) gives the run commands and archive contents.
