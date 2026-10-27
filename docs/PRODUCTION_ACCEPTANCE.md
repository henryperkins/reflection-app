# Deferred production acceptance

Production acceptance remains open. The current development application supports live GPT-6.1 Terra readings locally and on an isolated hosted preview. The merged application at `6b9b1fc` passed 14 local verification stages and 724 tests; its [hosted preview smoke record](superpowers/evidence/2026-10-27-hosted-preview-smoke.json) covers one live reading, save/reopen, passkey sign-in, fresh-browser recovery, consent-off export and test-account deletion. These are development results; all ten entries in `qualification/acceptance.json` remain pending. Production domain, budgets and operational ownership still require owner decisions. At the owner’s instruction, launch-country and minimum-age requirements and human-review sign-offs are excluded. Automated evidence records actual coverage; untested physical-device and screen-reader behavior remains a documented limitation.

| Gate | Concrete evidence needed before a real-data rollout |
| --- | --- |
| Identity | Exact stable origin/RP ID, supported browser/device versions, additional-passkey enrollment/removal, last-factor protection, logout-all, automated passkey flows and downloaded-kit recovery after browser clearing, identical saved-content reopening. |
| Key custody | Provisioned production keys, secret access restrictions, tested retained-key receipts/restore, wrap rotation and independent inventory of every backup needing old keys. Local add-only rewrap is not complete key retirement or account-DEK rotation. |
| Editorial content | Automated validation of all 156 source entries, positions, fallback/refusal copy and privacy disclosures; source provenance, attribution and signed artifact hashes. Unknown provenance remains visible; no human approval is required. |
| Provider | Project/model access, actual privacy settings and retention, frozen-corpus evaluation, schema/refusal/timeout behavior, latency and token distributions, actual usage/cost reconciliation and accepted hard limits. An injected response is not a live evaluation. |
| Release isolation | Controlled hosted main build with an intentional failing test that prevents release; rejected non-main production attempt; preview markers proving separate resources/keys/tokens. GitHub Actions is not assumed available. |
| Database and scheduler | Actual hosted D1 batch rollback/races, overlapping and missed Cron wakes, crash before/after dispatch and after durable receipt, bounded recovery and no duplicate publication/quota charge. |
| Restore and backup | Synthetic stale-bookmark drill described in the operations runbook; independent storage missing/loss behavior; backup inventory and retention; measured recovery-point and recovery-time evidence. |
| Browser/accessibility | Automated keyboard, 320px mobile, 200% text/zoom, accessibility-tree, focus and conflict/offline flows on the supported automated browser matrix. Physical authenticators and VoiceOver/NVDA experience are unverified limitations. |
| Operations | Confirmed heartbeat/alert delivery, deletion/security/spend monitoring, named incident responsibility and successful restore/key-recovery practice. |
| Owner decisions | Domain, production/evaluation budgets and operational responsibility. Geography, age and human-review requirements are excluded by owner instruction. |

The active development provider policy is defined in [`src/contracts/provider-policy.ts`](../src/contracts/provider-policy.ts): GPT-6.1 Terra with separately versioned parameters, accounting and provenance. The completed four-case development check and one-reading hosted smoke do not establish production project privacy settings, approved launch content, a reviewed final corpus or reconciled production billing. `store:false` does not establish zero provider retention.

The hosted development preview uses its own D1 database, recovery bucket and server secrets. Production admission/dispatch and deployment authorization remain separate; completed evidence does not itself activate production.

## Recording evidence

Run `npm run release -- --check` after verification to obtain the application digest and open gates. For each completed production gate, place a content-free review record in `qualification/evidence/`, record its SHA-256 and runner identity/date, use the gate's required evidence scope, and bind it to the reported application digest. Review records must contain the actual procedure, environment, observed result and limitations. Do not put keys, real personal records or recovery codes into the evidence.

The checker rejects stale application digests, changed evidence bytes, missing runner identity, wrong evidence scope, duplicate gates and paths outside the evidence directory. It verifies the integrity of recorded evidence; it cannot prove activity that did not run. Automated results must identify their actual environment and limitations; never describe them as physical-device or human screen-reader results.
