# Deferred production acceptance

The local delivery proceeds without production deployment. The owner explicitly deferred public-domain, country, age and budget decisions for this delivery. `qualification/acceptance.json` records open production gates rather than blocking a local ZIP or pretending that production is approved.

| Gate | Concrete evidence needed before a real-data rollout |
| --- | --- |
| Identity | Exact stable origin/RP ID, supported browser/device versions, additional-passkey enrollment/removal, last-factor protection, logout-all, physical/synced passkeys, downloaded-kit recovery after browser clearing, identical saved-content reopening. |
| Key custody | Provisioned production keys, secret access restrictions, tested retained-key receipts/restore, wrap rotation and independent inventory of every backup needing old keys. Local add-only rewrap is not complete key retirement or account-DEK rotation. |
| Editorial content | Human approval of the exact 156 source entries, positions, fallback/refusal copy and privacy disclosures; rights/territory/attribution decisions tied to hashes. The staged draft has no human approval. |
| Provider | Project/model access, actual privacy settings and retention, frozen-corpus evaluation, schema/refusal/timeout behavior, latency and token distributions, actual usage/cost reconciliation and accepted hard limits. An injected response is not a live evaluation. |
| Release isolation | Controlled hosted main build with an intentional failing test that prevents release; rejected non-main production attempt; preview markers proving separate resources/keys/tokens. GitHub Actions is not assumed available. |
| Database and scheduler | Actual hosted D1 batch rollback/races, overlapping and missed Cron wakes, crash before/after dispatch and after durable receipt, bounded recovery and no duplicate publication/quota charge. |
| Restore and backup | Synthetic stale-bookmark drill described in the operations runbook; independent storage missing/loss behavior; backup inventory and retention; measured recovery-point and recovery-time evidence. |
| Browser/accessibility | Human keyboard, 320px mobile, 200% text/zoom, VoiceOver/NVDA announcements, focus and conflict/offline flows; supported browsers and actual authenticators. Automated Chromium checks are part of the evidence, not the entire gate. |
| Operations | Confirmed heartbeat/alert delivery, deletion/security/spend monitoring, named incident responsibility and successful restore/key-recovery practice. |
| Owner decisions | Domain, launch countries, minimum age, production/evaluation budgets, editorial rights and operational responsibility. Deferred at the owner's instruction for local delivery. |

Current official provider documentation was checked on 2026-10-26. The selected [GPT-5.6 Terra model](https://developers.openai.com/api/docs/models/gpt-5.6-terra) documents Responses, structured output and reasoning `none`, with $2 input and $12 output per million text tokens. This confirms the documented model contract, not the user's project access or evaluation results. The [structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs) requires handling refusals outside the output schema. The [data-controls guide](https://developers.openai.com/api/docs/guides/your-data) distinguishes response storage from abuse-monitoring retention; `store:false` alone must not be described as zero retention.

No external messages, hosted resources, production secret provisioning or live inference are performed by this delivery. Deployment stays disabled even if every evidence record later passes: enabling deployment is a separate explicit action.

## Recording evidence

Run `npm run release -- --check` after verification to obtain the application digest and open gates. For each completed production gate, place a content-free review record in `qualification/evidence/`, record its SHA-256 and named reviewer/date, use the gate's required evidence scope, and bind it to the reported application digest. Review records must contain the actual procedure, environment, observed result and limitations. Do not put keys, real personal records or recovery codes into the evidence.

The checker rejects stale application digests, changed evidence bytes, missing review identity, wrong evidence scope, duplicate gates and paths outside the evidence directory. It verifies the integrity of recorded evidence; it cannot replace the human or hosted activity the record describes. Never promote a synthetic fixture or agent editorial review into a human approval.
