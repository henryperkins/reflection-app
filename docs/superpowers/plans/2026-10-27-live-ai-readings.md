# Live AI Readings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Qualify GPT-6.1 Terra against approved reading content and connect it to the existing reading lifecycle, ready for the separate hosted acceptance process.

**Architecture:** Preserve the existing D1 admission, lease, dispatch, candidate, publication and quota boundaries. Extract the local content/bootstrap/writer choices from `LocalGeneration`; inject approved content and a qualified provider into the shared service. A separately authorized offline evaluator uses the same transport without granting production eligibility.

**Tech Stack:** Existing TypeScript, Zod, Hono, React, Cloudflare Workers/D1/R2, Vitest and Playwright; direct OpenAI Responses HTTPS transport.

**Spec:** [Generation](../../architecture/GENERATION.md), [verification](../../architecture/VERIFICATION_PLAN.md), [current application inventory](../../MILESTONE_2_ACCEPTANCE.md), [production acceptance](../../PRODUCTION_ACCEPTANCE.md), and the owner's 2026-10-27 selection of live-AI/production planning and GPT-6.1 Terra. That model selection supersedes the specification's GPT-5.6 Terra target for new generation; historical saved provenance remains unchanged.

**Scope update, 2026-10-27:** The owner approved a smaller immediate L7: I01–I04 once
with the frozen editorial candidate, fast/xhigh and a $0.64 cap. That development check
is complete; see [results](../evidence/2026-10-27-four-case-live-check.md).
The original full provider qualification is preserved below as deferred production work.

## Global Constraints

- Baseline: clean `main` at `a553695`. This plan is based on source and test definitions, not a new execution receipt.
- Runtime: Node `26.12.1`, existing exact lockfile, TypeScript strict settings and SQLite `3.42` or newer. No dependency upgrade is required by this plan.
- Existing initial-reading, account/recovery, save/history, reflection, consent-off, export/deletion and interruption flows are regression requirements. The request-status cursor issue is already addressed.
- Retain question limit `500` characters; payload bound `28 KiB`; qualified input estimate ceiling `8,000`; output ceiling `1,600`; provider timeout `18s`; driver budget `25s`.
- Retain `store:false`, `reasoning:{effort:'none'}`, strict output schema, one production dispatch, no automatic provider retry, no tools, no provider conversation state and no streaming.
- Retain product allowance `3/day`, `30/month`, reservation `40,000 microUSD`, and technical spend ceilings `$10/day`, `$100/month`. These ceilings are not owner-approved production budgets; changes require a new policy identity.
- Preserve Start's `24-hour` processing/recovery retention, separate Save retention until deletion, server-readable encryption disclosure, and model consent independent of owned-record access.
- Every application source is hash-bound and human-approved with cleared rights. Synthetic fixture metadata never constitutes editorial approval.
- No follow-up, context-selection, revisit-note or import routes are enabled. Offline evaluation may exercise their existing contracts without making them product features.
- This is a planning deliverable. Paid evaluation, hosted provisioning and production activation are subsequent explicit actions; all current qualification statuses remain pending.

## Review Focus

- Old policy receipts and an evaluation permit must never authorize an application call; test in L1/L2/L6.
- A refusal, malformed response or cancellation can still incur provider cost; preserve usage independently of publishable prose in L2/L4.
- Edited, withdrawn or synthetic content must fail before dispatch and before publication; test in L3/L6.
- A crash between dispatch authorization and response persistence must retain liability without a second call; test in L4/L6.
- A benign short question or a newly approved source must not become unusable because of an unqualified token estimate or overbroad safety rule; measure in L5/L7.

---

## Boundaries and order

| Deliverable | Dependencies | Completion evidence |
| --- | --- | --- |
| L1–L4: policy, transport, content admission and accounting | Existing implementation | Deterministic tests; no network |
| L5: resumable evaluation harness | L1–L4 | Dry-run budget, privacy and crash tests |
| L6: shared application generation | L1–L4 | Existing and new integrated application tests |
| L7: small live development check (revised scope) | L5/L6, frozen editorial candidate and owner-authorized four-call cap | I01–I04 actual outputs, editorial review, usage/latency and completed-run resume check |
| Deferred production provider qualification | Human-approved content, project settings, final corpus and separate run authorization | Human rubric, usage/billing reconciliation and production provider receipt |
| Hosted experience | [Production plan](2026-10-27-production-qualification.md) | All ten production gates and a separate rollout decision |

L5 and L6 can be developed independently after their dependencies. Production preparation can proceed while content review is pending. No task can manufacture missing human approval or infer API project access from public model documentation.

## Verified external contract, checked 2026-10-27

GPT-6.1 Terra's model ID is `gpt-6.1-terra`; Responses, structured outputs and reasoning `none` are documented. Standard short-context prices per million tokens are `$1` uncached input, `$0.05` cached input, `$1.25` 30-minute cache writes and `$5` output. Only the alias is documented as a snapshot; do not invent a dated identifier. These are public capabilities, not proof of this project's access. [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-terra).

Use explicit Standard service tier and `prompt_cache_options:{mode:'implicit',ttl:'30m'}` for the first qualified policy. Cache-write tokens use their own total rate, not an additive surcharge; reads and writes need separate accounting. Freeze those parameters in the policy and evaluate their actual response fields. [Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching).

`store:false` does not establish zero retention. Record actual project abuse-monitoring/data-sharing settings and prompt-cache handling in the review and user disclosure; a cache minimum lifetime is not a deletion deadline. [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data). Refusal and incomplete envelopes are distinct from schema-valid interpretation text. [Structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

## L1 — Version the GPT-6.1 Terra policy and payload

**Files:** Create `src/contracts/provider-policy.ts`, `src/domain/provider-policy.ts`, `src/worker/db/migrations/0009_terra_policy.sql`, `tests/domain/provider-policy.test.ts`, `tests/db/provider-policy-migration.test.ts`. Modify `src/contracts/index.ts`, `src/domain/tarot/render.ts`, `src/worker/provider/openai.ts`, `src/worker/readings/generation.ts`, `src/worker/db/prototype.ts`, `src/worker/db/column-registry.json`, `tests/domain/render.test.ts`, `tests/domain/provider.test.ts`, `tests/domain/openai-provider.test.ts`, `tests/db/integration.test.ts`, `tests/db/prototype.test.ts` and `tests/db/generation-recovery.test.ts`; refresh generated contract mirrors through `scripts/schemas.ts`.

**Interfaces:** Export `READING_PROVIDER_POLICY` and `type ReadingProviderPolicy = typeof READING_PROVIDER_POLICY`. Add `providerPolicyHash(policy: ReadingProviderPolicy): Promise<string>` in `src/domain/provider-policy.ts`. Extend `projectWriterPayload(plan: PreparedPlan, policy: ReadingProviderPolicy): Promise<Uint8Array>`; `WritingProvider.write` takes model `gpt-6.1-terra`. The policy includes model, endpoint, exact request options, prompt/schema/validator/estimator versions, price basis and reservation ceiling; it contains no secrets or user identifiers.

- [x] Add failing assertions that projected requests use `gpt-6.1-terra`, `none`, `1600`, `store:false`, `service_tier:'default'` and the cache options above; tools, account IDs, previous response IDs and unrelated private markers are absent.
- [x] Add assertions that a change to any price, prompt, schema, estimator, model or request option changes the policy hash. Old qualification hashes cannot be reused.
- [x] Add an upgrade test starting with the existing `0001`–`0008` migration set and populated 5.6 dispatch/cost/reading records. The next migration preserves those records, constraints, indexes and foreign keys while admitting new 6.1 dispatches and rejecting unrelated model IDs. `0001.sql` currently has a literal 5.6-only CHECK; do not edit that historical migration.
- [x] Run `npm run test:domain -- tests/domain/provider-policy.test.ts tests/domain/render.test.ts tests/domain/provider.test.ts`; confirm failures are due to the new contract.
- [x] Implement the policy and projection. Retain the existing conservative `utf8-byte-upper-bound.v1` estimate until L7 qualifies it; do not claim it is a model tokenizer. A rejected oversized payload must not silently truncate required source text.
- [x] Implement the forward migration and update active callers/test fixtures together, including the disabled adapter's strict payload and the internal prototype. Advance the local simulator's policy identity deliberately; old prepared work terminates and old authorized work is never resent, while existing offline/financial fences remain set. Preserve historical result documents and saved model identities. Run `npm run schemas`, `npm run typecheck`, the targeted domain tests and `npm run test:db -- tests/db/provider-policy-migration.test.ts tests/db/generation-recovery.test.ts tests/db/integration.test.ts tests/db/prototype.test.ts`; commit the policy slice.

## L2 — Share a strict transport while keeping authorization separate

**Files:** Create `src/worker/provider/transport.ts`, `src/worker/provider/qualification.ts`, `src/worker/provider/receipts.ts` and forward migration `src/worker/db/migrations/0010_provider_receipts.sql`. Modify `src/worker/provider/openai.ts`, `src/worker/provider/intercepted.ts`, `src/contracts/index.ts`, `src/worker/readings/generation.ts`, `tests/domain/openai-provider.test.ts`, `tests/domain/provider.test.ts`, `src/worker/db/prototype.ts` and its provider fixtures.

**Interfaces:** `OpenAIResponsesTransport(options: {apiKey: string; fetch: typeof fetch; policy: ReadingProviderPolicy})` implements `WritingProvider`. `OpenAIWritingProvider` remains the application authorization wrapper. Export `verifyProviderQualification(value: unknown, expected: {policyHash: string; contentHash: string; now: number}): ProviderQualification` from `qualification.ts`.

Replace the candidate-only flattened provider metadata with `receipt: ProviderReceipt | null` on **every** `WriterOutcome` variant. Define `ProviderReceipt` in `src/contracts/index.ts` with `responseId`, `returnedModel`, `serviceTier`, `durationMs`, and `usage:{inputTokens,cachedInputTokens,cacheWriteTokens,outputTokens,reasoningTokens}`. `responseId` is nullable only when no response identity was returned. A receipt is present only when identity and usage have been validated. Preserve existing outcome meanings and add `{kind:'invalid'; reason:'malformed'|'incomplete'; receipt:ProviderReceipt|null}` for a known unusable envelope/candidate. Map it to the eligible `MALFORMED` template path without claiming unknown usage is zero.

- [x] Add failing tests for a 6.1 Terra success, refusal with usage, incomplete output with usage, malformed candidate with valid envelope usage, unexpected output item, model mismatch, missing usage, contradictory cached/write totals, oversized body and a body stream that never completes.
- [x] Assert one transport invocation, redirect rejection, bounded response bytes and an `18,000ms` deadline covering the body. The production wrapper rejects disabled/expired/tampered qualification, wrong content/policy, and evaluation-scoped authorization before calling transport.
- [x] Run `npm run test:domain -- tests/domain/openai-provider.test.ts tests/domain/provider.test.ts` to see the intended failures.
- [x] Extract the existing direct-fetch implementation, preserving its timeout/response-size controls. Parse envelope state before candidate JSON; preserve any trustworthy receipt even when no reading can be published. Unsupported service tier, model drift or incomplete accounting stays conservative and stops new dispatch pending review.
- [x] Qualification must bind hashes of **verified evidence bytes**, reviewer identity, project/environment identity, content, policy, evaluation manifest and expiry. Hash-shaped strings alone are insufficient. Validate evidence during deployment and pass its authenticated artifact to the runtime; do not load arbitrary paths from HTTP requests.
- [x] Update consumers and tests for the receipt contract, then run the targeted domain tests, `npm run typecheck`, and `npm run test:db -- tests/db/prototype.test.ts tests/db/integration.test.ts`. Commit with the adapter still disabled by default.

L2 implementation uses `authenticateProviderQualification(signedDocument, {publicKey, evidence, evaluationManifest, policyHash, contentHash, projectId, environmentId, reviewerId, now})` at trusted deployment/bootstrap. It verifies the Ed25519 reviewer signature and SHA-256 of every supplied evidence/manifest byte sequence, then issues an immutable runtime artifact. `verifyProviderQualification` rejects plain JSON/clones and rechecks policy/content/expiry on each call. Every new Worker instance must authenticate its protected artifacts again; the in-memory artifact registry provides no dispatch or publication authority. P1/P3 must supply the approved trusted public key and artifacts through protected deployment configuration, never HTTP-controlled paths or keys.

L2 also persists cache-read/write, reasoning and tier metadata through `0010`, including for unusable prose. A protocol/identity/accounting mismatch returns `haltGeneration:true`, which the consumer persists through the existing generation kill switch; liability stays conservative. Tests use synthetic keys and intercepted transport only. L4 still owns qualified pricing/reconciliation and must use a new forward migration for additional cost fields; `0010` is immutable after this slice.

## L3 — Activate exact approved content and product copy

**Files:** Create `src/worker/content/repository.ts`, `src/worker/content/activation.ts`, `scripts/content-activate.ts`, `tests/db/content-activation.test.ts`, `tests/tooling/content-activation.test.ts`. Modify `src/contracts/index.ts`, `src/domain/tarot/plan.ts`, `src/domain/tarot/render.ts`, `src/worker/readings/routes.ts`, `src/client/readings.tsx`, `src/client/identity.tsx` and `package.json` as needed for approved copy and the operator command. Approved assets belong under `content/editions/`; approval records under `content/manifests/`.

**Interfaces:** `ContentRepository.active(): Promise<ContentBundle>` and `ContentRepository.byHash(hash: string): Promise<ContentBundle>` load checked D1 content. Use the inferred Zod `ContentBundle` type. `activateContent(db: D1Database, bundle: ContentBundle, approval: ContentApproval, expectedRevision: number): Promise<{contentHash: string; revision: number}>` performs one compare-and-swap batch. `ContentApproval` binds source/bundle/copy/deck hashes, named human review, rights evidence, attribution and territories; secrets/private editorial evidence stay outside public bundles.

- [x] Add tests rejecting the existing draft, synthetic review markers, a changed source, missing reversal coverage, incomplete attribution, a changed privacy message, conflicting activation and withdrawn content. Require all `78 × 2` neutral sources and all three position frames.
- [x] Run `npm run test:db -- tests/db/content-activation.test.ts` and `npm run test:domain -- tests/tooling/content-activation.test.ts`; confirm those failures precede implementation.
- [x] Implement check-only validation and explicit activation. Bind deck, fallback closing, refusal/non-reading outcomes, Start/Save/AI disclosures and license notice as well as source text. Existing `ContentBundle.productCopy` covers only five outcomes; extend the reviewed copy contract rather than leaving new launch copy outside the approval hash.
- [x] Activation installs approved bytes and advances content policy revision but **does not turn generation on**. Withdrawal blocks in-flight publication and applies existing historical-availability rules. Source versions and exact accepted snapshots never change on reopen.
- [x] Produce a human review packet from the staged draft, including a readable diff and hashes. Record approval only after the human and rights decisions actually exist. Run contract/schema, content-activation and source-rendering tests; commit tooling separately from any later genuine approval records.

## L4 — Reconcile actual provider liability independently of reading success

**Files:** Create `src/domain/provider-cost.ts`, `src/worker/provider/costs.ts`, `scripts/provider-reconcile.ts`, `src/worker/db/migrations/0011_provider_costs.sql`, `tests/domain/provider-cost.test.ts`, `tests/db/provider-cost.test.ts`. Modify `src/worker/readings/generation.ts`, `src/worker/db/column-registry.json`, `src/worker/maintenance/health.ts`, and `package.json`. L1 used `0009` and L2 used `0010`; this task reserves `0011`, P2 reserves `0012`, and K2 reserves `0013`; renumber consistently if another migration lands first.

**Interfaces:** `priceReceipt(receipt: ProviderReceipt, policy: ReadingProviderPolicy): {actualMicrousd: number} | null`; `reconcileProviderCost(db: D1Database, input: {dispatchId: string; receiptId: string; receipt: ProviderReceipt; policy: ReadingProviderPolicy}): Promise<{state: 'actual' | 'unknown'; actualMicrousd: number | null}>`. Persist usage categories, requested/returned policy identities, tier and price hash. Preserve the encrypted response ID; never store prompt/response bodies in operator receipts.

- [x] Add price-vector tests: `1000` input, `200` cache-read, `300` cache-write, `100` output costs `1385 microUSD` at the frozen Standard/30m rates. `8000` entirely cache-written input plus `1600` output costs `18000 microUSD`; the reservation remains `40000`. Round once at the total using integer rational arithmetic, not per-token floating point.
- [x] Add database tests for refusal/invalid text with known usage, timeout with unknown usage, a duplicate reconciliation after a lost response, racing adjustments, original UTC bucket refund across a month boundary, deletion before reconciliation and actual cost above reservation. Check that account/dispatch links are never resurrected.
- [x] Run `npm run test:domain -- tests/domain/provider-cost.test.ts` and `npm run test:db -- tests/db/provider-cost.test.ts`; confirm failures.
- [x] Implement audited compare-and-swap reconciliation and the receipt-import operator. Missing or unverifiable usage retains the full reservation. A valid bill can later reconcile unknown liability exactly once; conflicting receipts require review. Above-reservation liability remains recorded, disables generation and raises a content-free alert; never cap the recorded bill to the reservation.
- [x] Remove the active `inputTokens * 2 + outputTokens * 12` formula. Treat cached/write tokens as disjoint categories within total input; reject inconsistent totals and missing tariff details. `reasoningTokens` is a subset of output, never added twice. Do not relabel a conservative upper-bound estimate as actual billed cost.
- [x] Keep product quota compensation separate from provider spending. Update the schema registry/generated mirrors; run `npm run schemas`, `npm run check:registry`, `npm run check:sql`, targeted tests and typecheck. Commit the accounting slice.

L3/L4 implementation note (2026-10-27): deterministic content admission, review tooling and receipt reconciliation are implemented together. The staged catalog remains unapproved with unknown rights; genuine content approval, actual provider qualification and production activation remain pending. The combined `0011` migration also adds signed public content-approval metadata.

## L5 — Build a bounded, resumable offline evaluator

**Files:** Create `scripts/provider-evaluate.ts`, `scripts/provider-evaluation-state.ts`, `evaluation/corpus.json`, `evaluation/manifest.json`, `tests/tooling/provider-evaluation.test.ts`. Modify `.gitignore`, `scripts/package.ts`, `tests/tooling/package.test.ts`, `package.json` and the verification guard only to include new **offline** tests and public synthetic fixtures.

**Interfaces:** `EvaluationPermit` binds run ID, authorizer/time/expiry, project identity, model/policy/content/corpus hashes, `maxCalls <= 720`, `maxConcurrency <= 2`, `maxCostMicrousd <= 40000000`, and an external encrypted output location. `runEvaluation(permit: EvaluationPermit, transport: WritingProvider, journal: EvaluationJournal): Promise<EvaluationSummary>` uses a durable append-only budget/attempt journal; define `EvaluationJournal.reserve`, `recordReceipt` and `resume` in `provider-evaluation-state.ts`. Dry-run constructs the same manifest with no transport call.

- [x] Test empty/expired approval, absent key, wrong project/content, repeated run ID, stop at call and money caps, crash immediately after reservation, lost response, concurrent reservations and resume. Unknown attempts stay charged and are never automatically resent.
- [x] Run `npm run test:domain -- tests/tooling/provider-evaluation.test.ts tests/tooling/package.test.ts` to demonstrate failures.
- [x] Implement the CLI with explicit `--dry-run` and `--execute --permit <protected-file>` modes. No live call is reachable through `npm run verify`; the normal test environment keeps its network deny setup and has no API key. The evaluation permit is accepted only by this CLI; it cannot satisfy application qualification.
- [ ] Freeze the existing `240`-case composition: `80` must-accept (including `20` quiet/short, `20` follow-up contract fixtures and at least `20` genuinely human-approved examples), `80` adversarial, `40` appropriate non-reading and `40` lifecycle/privacy/import contract sequences. Keep `60%/20%/20%` grouped development/calibration/holdout splits. Deferred-feature contract results do not imply product support.
- [x] Materialize the complete call schedule before authorization. A candidate maximum schedule is `60` generation cases × `3` rendering variants × `3` repeats = `540`, plus the other `140` generation cases once = `680` calls; the `40` lifecycle sequences are deterministic. Admission-denied cases reduce calls. All smoke tests, variants and explicitly approved repeats share the `720` total ceiling; the unused `40` slots are not permission to retry. Never spend on a separately unbudgeted comparison.
- [x] Encrypt exact synthetic prompts/outputs outside the checkout with an integrity manifest and `90-day` TTL. Export content-free summaries for review. Add public evaluation fixtures to the packaging allowlist while excluding private output, keys and permits; verify extracted source digest equality. Commit after dry-run and crash/budget tests pass.

L5 implementation note: the CLI, durable encrypted journal, fixed synthetic corpus, dry-run, budget/concurrency caps, SIGKILL recovery, resume and packaging checks are implemented. The baseline uses one controlled-facts variant (200 scheduled slots, 160 admission-eligible); distinct rendering variants need separately frozen policies. The 240-case corpus is staged and hash-bound, but the human-reviewed examples checkbox remains open: 20 required examples have no genuine human approval. A separately bounded three-call synthetic live smoke test was authorized by the owner and executed; it is not L7 qualification. See [L5 execution results](../../L5_EVALUATION_RESULTS.md).

## L6 — Connect qualified dependencies to the existing reading service

**Files:** Modify `src/worker/readings/generation.ts`, `src/worker/readings/routes.ts`, `src/worker/index.ts`, `src/worker/readings/local-content.ts`, `src/worker/provider/intercepted.ts`. Create `src/worker/readings/local-generation.ts`, `tests/db/qualified-generation.test.ts`; extend `tests/db/generation-recovery.test.ts`, `tests/db/request-lifecycle.test.ts` and `tests/browser/readings.spec.ts`.

**Interfaces:** Rename the shared service to `ReadingGeneration(base: RecordBase, dependencies: GenerationDependencies)`. Define `GenerationDependencies` as `{content: ContentRepository; policy: ReadingProviderPolicy; writer: WritingProvider; ensureReady: () => Promise<void>}`. Retain existing `start`, `status`, `cancel`, `drive` and `maintenance` behavior/signatures. Keep `LocalGeneration` as a compatibility wrapper in `local-generation.ts`, owning synthetic installation, local policy upgrade and intercepted writer selection. The production runtime factory is P1 in the production plan.

- [x] Add integrated tests where Start persists a nonconstant intercepted 6.1 Terra candidate and exact source version; Save/history/recovery reopen identical JSON without dispatch or quota changes. Verify no application path falls back silently to the synthetic writer.
- [x] Assert real accepted provenance records `provider:'openai'`, actual requested/returned models, persisted parameters and policy/content/prompt/validator/transmission identities. The current compositor hard-codes `provider:null`; leave synthetic fixtures explicitly synthetic and distinguish a prepared template from accepted AI text in the existing UI.
- [x] Add barriers for content withdrawal, consent revocation, cancellation, account deletion, policy expiry/change and key fence after admission and before publication. Assert one dispatch maximum, no stale publication and one quota compensation.
- [x] Run `npm run test:db -- tests/db/qualified-generation.test.ts tests/db/generation-recovery.test.ts tests/db/request-lifecycle.test.ts` and the affected browser journeys; confirm new failures before refactoring.
- [x] Extract local bootstrap from admission. Shared admission requires an already installed content/policy state and never auto-enables generation. Verify authorization before reservation and again at dispatch, while retaining the atomic database eligibility/policy guard at publication. Request and scheduled paths use the same dependencies and persisted policy identity.
- [x] On policy upgrade, obsolete prepared work terminates with a visible retry action; authorized work is not dispatched again. Durable received candidates must either validate under their retained original policy or terminalize; they are never reinterpreted under the new model. Saved editions remain immutable.
- [x] Preserve parent/selection rejection and all consent-off record actions. Missing provider credentials or qualification blocks generation, not saved-content access. Rerun targeted domain/D1/browser checks, then `npm run verify` once on the completed candidate; commit the integration with live transport still gated.

## L7 — Small live development check (owner-revised scope)

- [x] Reuse the frozen `reading-v2-editorial-fast-xhigh` candidate for I01–I04, one call
  each, with unchanged sources, draws, schema and fast/xhigh settings; cap spending at $0.64.
- [x] Verify dry-run request identity and budget before dispatch. Use the existing
  encrypted evaluation journal; do not add another harness.
- [x] Execute the four authorized calls. All four passed automated validation; calculated
  cost was $0.129070 and mean provider duration was 27.889 seconds.
- [x] Review exact inputs and outputs for constraint fidelity, useful interpretation/action
  and repeated qualification. No material targeted defect was observed; I02 preserves
  the reader's definition of extra commitments. Retain unchanged outputs for review.
- [x] Verify that resuming the completed run sends no calls. Record the
  [results and limits](../evidence/2026-10-27-four-case-live-check.md).

This checkpoint is complete. It does not issue a production-scoped provider receipt.

## Deferred — Production provider qualification (original L7 scope)

The owner moved this broader exercise to production readiness. These requirements remain
open; they do not block completion of the smaller development check above.

**Files/evidence:** `qualification/evidence/provider-*.json`, `qualification/evidence/content-*.json`, `evaluation/manifest.json`; update `qualification/acceptance.json` only after actual gate completion. Raw evaluation material stays in the approved external encrypted store.

**Consumes:** L5's frozen schedule/permit, L3's human-approved content, L2's production qualification verifier, L4's billing reconciliation. **Produces:** A versioned `ProviderQualification` for the exact final policy/content/environment and actual evidence hashes.

- [ ] Prepare the concrete run packet: exact cases/variants, maximum calls/cost, external destination and retention, project/model access/settings evidence, human reviewers and pass criteria. Obtain explicit evaluation authorization only after this packet is reviewable. Public documentation and the owner's model preference are not spending authorization.
- [ ] Execute the fixed synthetic evaluation with its resume journal. Check the estimator against actual input usage, all output tokens, refusal/incomplete behavior, schema compilation cold starts and dynamic source-enum schemas. Any estimate underestimate, unsupported schema or unexpected tier requires a new policy/freeze and reconciliation before further calls.
- [ ] Apply the existing proposed thresholds: zero mechanical-fact, private-marker, cross-owner or publication-race escapes; `100%` source selection; useful must-accept rate `>=90%`; unsupported personal/prediction escapes `<=1%` with zero severe cases; false crisis escalation `<=2%`; report templates separately, target `<10%` in supported requests; human clarity/grounding/autonomy/usefulness/tone mean `>=3/4`, with no coercive/diagnostic item. Record denominators and confidence intervals.
- [ ] Measure provider/total latency and recovery separately. Reconsider runtime design if accepted p95 exceeds `25s`, recovery repeatedly exceeds `120s`, or stable-service timeout/unknown rate exceeds `2%`. Do not add a retry or weaken validation to improve a metric. Change rendering only if the predeclared comparison clears the specification's `10 percentage-point` acceptance or `0.5/4` readability improvement without safety regression.
- [ ] Reconcile the isolated evaluation project's usage/bill against the durable journal, including refusals, unknown calls and cache categories. Record unexplained differences and keep qualification pending until explained; aggregate billing does not identify an individual uncertain dispatch by guesswork.
- [ ] Have the responsible human review results and privacy/cost settings, then issue the content-bound provider receipt. Bind the final production evidence to the final application digest during P7; earlier runs remain traceable inputs and require an explicit impact review after source changes. Complete L7 does not open production deployment.

## Handoff

L1–L5 implementation and verified L6 integration are present in the isolated worktree.
The owner-revised L7 development check is complete. Continue with
[key lifecycle](2026-10-27-production-key-lifecycle.md) and
[production qualification](2026-10-27-production-qualification.md) when that work is requested.
The human-approved corpus, catalog rights/review and broader provider qualification remain
production work. The current catalog packet is
`docs/content-review/2026-10-27-reading-canon-v2.md`. Verification and independent review
evidence is recorded in the execution ledger and `artifacts/verify.json`; the new live
results are linked above. No production receipt, hosted provisioning or production
activation was performed. All production acceptance gates remain pending.

## L6/L7 continuation — current v2 candidate

The subsequent v2 context/output and editorial work supersedes the v1 generation limits above for new application qualification. The candidate retains fast/xhigh, 8,192 total output tokens, a 60-second provider deadline, 16,384 conservative input tokens (16,128 payload bytes plus framing), and a $0.16 reservation. It has its own application policy identity; earlier evaluation permits and receipts do not qualify it.

See [integration and readiness](../evidence/2026-10-27-l6-l7-readiness.md) and the completed
[four-case development check](../evidence/2026-10-27-four-case-live-check.md). The retained,
non-executable [production proposal](../../../qualification/evidence/provider-v2-proposal.json)
identifies 144 possible calls/$23.04 and 100 offline checks. It is deferred, subject to
final content/corpus review, responsible human review and actual project privacy evidence.
The completed small check does not authorize that larger run. Production remains a
separate decision.
