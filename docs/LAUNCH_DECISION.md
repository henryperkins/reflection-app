# Production release preparation

The approved local implementation is ready for review and verification. Production activation remains disabled. Launch geography, minimum age and human-review sign-offs are excluded by owner instruction; untested physical authenticator and screen-reader behavior is recorded as a limitation.

## Implemented candidate

The branch includes isolated runtime manifests, persistent offline coordination, bounded security/erasure-first maintenance, retained account-key versions, journaled DEK replacement, authenticated backup/reference inventory, checkpoint rollover, guarded retirement, signed automated content validation, authenticated synthetic-only build commands, private hosted scenario orchestration, content-free monitoring and automated browser checks. The [qualification plan](superpowers/plans/2026-10-27-production-qualification.md) and [key plan](superpowers/plans/2026-10-27-production-key-lifecycle.md) identify the boundaries.

Use the final commit and `artifacts/verify.json` for exact candidate identity, all 14 stage outcomes, source digest, duration and test reports. `qualificationDigest` excludes only qualification records to avoid circular evidence hashes. The full verification digest includes them. Reverify after source or evidence changes; never rewrite a receipt to make an older run appear current.

## Concrete release packet

| Item | Prepared result | Remaining dependency |
| --- | --- | --- |
| Preview | Existing development preview and content-free [eight-check smoke](superpowers/evidence/2026-10-27-hosted-preview-smoke.json), one live Terra Start, test account deleted | New foundations have not replaced that deployed version |
| Domain/RP ID | Exact HTTPS origin/RP validation and closed production rendering | Stable production domain |
| Accounts/resources | Separate-account enforcement and [manifest examples](../config/README.md) | Separate production account; exact D1/R2/DO identities and restricted tokens. Only Henry Flare is currently connected |
| Build/deploy | [Pinned Workers Builds configuration](../config/hosted-builds.json), full gate, byte-hashed synthetic artifact, authenticated build checks | Actual clean-cache build, failing-main proof, non-main rejection and direct credential boundary probes |
| Content | Signed v3 automated status, exact catalog/copy hashes, unknown provenance preserved, generation off | Automated validation and signed artifact for the final launch catalog; independent hosted trust key |
| Provider/budgets | Current GPT-6.1 Terra policy and development smoke; durable cost reservations and no deliberate redispatch | Evaluation/hosting/production caps, actual project privacy/access settings, full frozen-corpus evaluation and billing reconciliation |
| Recovery/keys | [Operator procedures](PRODUCTION_KEY_LIFECYCLE.md), persistent fence, complete inventory and [scenario protocols](HOSTED_RESTORE_RUNBOOK.md) | Actual D1 Time Travel/R2/secret-copy drills, accepted RPO/RTO and protected backup custody |
| Monitoring | Completed heartbeat, three missed wakes detection, [exact unsent notification](../config/monitoring.json) | Independent monitor, metadata/retention inspection, incident contacts/channel and explicit delivery instruction |
| Browser | [Automated Chromium coverage and limitations](BROWSER_QUALIFICATION.md) | Same journeys against the frozen hosted candidate |

All ten production acceptance records remain pending. Local tooling tests and restore-format fixtures do not establish hosted credentials, custody, paid provider qualification or alert delivery. `npm run release -- --check` reports those gaps and always returns `deploymentAllowed:false`; `milestone2Complete` remains false until every required evidence record is valid. The synthetic staging command has no production deploy path.

## Activation and rollback

Complete the exact target, caps and protected resource/secret configuration first. Run the recorded synthetic hosted procedures, freeze the application/configuration, bind genuine content-free evidence bytes and runner identity to the candidate, and reverify. Present the exact artifact, qualification digest, admission/dispatch settings and bounded smoke budget for a separate production launch decision. No real-user admission or production provider traffic is enabled by this work.

Activation should change only reviewed admission/dispatch controls. A change requiring new code creates a new candidate and qualification cycle. Rollback disables new generation/admission while preserving safe owned-record access, immutable recovery objects, erasure intents and financial liabilities. Never restore obsolete private data or reset spend to make an incident look resolved. Recovery resumption requires the independently validated epoch and keeps generation off.
