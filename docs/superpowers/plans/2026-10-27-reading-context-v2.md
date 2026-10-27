# Reading context and output v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build the owner's complete bounded interpretation package and v2 reading output while preserving v1 saved content.

**Architecture:** Keep deterministic exact lookup. Add explicit v2 contracts and focused domain modules; use version-aware adapters at generation, transport and presentation boundaries. Keep draft content and local/live evaluation explicitly separate from production approval.

**Tech Stack:** Existing TypeScript, Zod, React, Cloudflare D1, Vitest and Playwright; no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-10-27-reading-context-v2-design.md` (the supplied implementation decision, recorded with engineering bounds).

## Global Constraints

- Preserve exact current question, including negation and whitespace; selected history stays empty.
- Preserve old v1 hashes and stored-reading shape; new generation has separately bound v2 identities.
- Three interpretations <=650 characters; synthesis <=650; action <=500; one optional question <=200.
- Three exact meaning packages, three explicit frames, zero to two eligible relationships; no new lore/reversal framework.
- Drop relationships then imagery before a specific required-input size rejection; never truncate required text.
- Keep fast/xhigh fixed for evaluation; new conservative input/reservation bounds require separate qualification.
- No false human/rights approval, production activation, push or merge.

## Review Focus

1. A negated, quoted or hypothetical reader statement must not authorize an affirmative personal claim (Task 2).
2. A relationship matching only part of its cards/themes or citing an omitted note must fail eligibility/binding (Tasks 1–2).
3. A stored v1 candidate or interrupted dispatch must never be silently upgraded/reinterpreted (Task 4).
4. Optional budget omissions must not leak into cited synthesis or alter the reader/source qualification (Tasks 2–4).
5. New draft or forged review metadata must never pass production activation or leak private evidence (Tasks 1–3).

### Task 1: Versioned content and plan

**Files:** `src/contracts/index.ts`, new `src/domain/tarot/context-v2.ts`, `tests/domain/context-v2.test.ts`, `tests/fixtures/canon-v2.ts`.

**Interfaces:** Add `ContentBundleV2`, `CanonSourceV2`, `RelationshipSource`, `PreparedPlanV2`, `ModelCandidateV2`, `AcceptedReadingV2`; retain v1 exports. `buildPlanV2(input, diagnosticOnly=false)` freezes metadata, frames, meanings and eligible relationships. `validatePlanV2` recomputes selected source/relationship/frame identities.

- [x] Add tests for exact reader text, coverage and position-specific lookup, frame retention, all-condition relationships and stable selection, invalid source hashes, diagnostic vs reviewed eligibility.
- [x] Run `npm run test:domain -- tests/domain/context-v2.test.ts`; expected RED for missing v2 behavior.
- [x] Implement contracts and bounded deterministic plan assembly.
- [x] Run the targeted suite and typecheck; expected PASS. Commit the independently testable domain slice.

### Task 2: Projection, output and screening

**Files:** new `src/domain/tarot/writer-v2.ts`, `src/domain/tarot/safety-v2.ts`; `src/contracts/provider-policy.ts`, `src/domain/provider-policy.ts`, `src/worker/provider/transport.ts`; `tests/domain/writer-v2.test.ts`, `tests/domain/safety-v2.test.ts`.

**Interfaces:** `prepareWriterV2(plan, policy)` returns exact `payload` plus `receipt`; `composeTemplateV2(plan)` returns deterministic v2 output. `validateCandidateV2(plan, value, receipt, template=false)` checks schema, all references and prose. Policy schema hashing selects v1/v2 by explicit schema identity.

- [x] Write privacy, complete packet, budget-omission/rejection, reference, bounds, natural supported-fact and negative-scope tests; run for RED.
- [x] Implement the user's full writing contract, response-specific schema, receipt and safe fallback; keep v1 functions frozen.
- [x] Run both new suites plus transport/provider-policy tests and typecheck; expected PASS. Commit.

### Task 3: Substantive editorial draft and approval tooling

**Files:** new `content/reading-canon-v2-draft.json`, content build/review tooling, `src/worker/content/approval.ts`, repository/activation consumers as needed; `tests/tooling/content-v2.test.ts`, content activation tests.

**Interfaces:** Complete 78x2 neutral meaning coverage, source/package hashes and review export; `AnyContentBundle` supports existing v1 and new v2 without upgrading old bytes. Approval documents bind all optional relationships and spread definitions through exact bundle hashes.

- [x] Write coverage, substantive-field, unchanged-review-status, draft-rejection, approval-tampering and position-specific-source tests; observe RED.
- [x] Develop original bounded orientation packages from inventoried local editorial inputs; imagery and production relationships default empty until verified/reviewed. Export exact review packet.
- [x] Run content tooling and activation suites; expected PASS. Commit draft separately from any approval (none manufactured).

### Task 4: Generation, persistence and presentation

**Files:** `src/worker/readings/generation.ts`, local content and version adapters, `src/client/readings.tsx`, contract/schema consumers; `tests/db/reading-v2.test.ts`, affected recovery and browser tests.

**Interfaces:** New local starts freeze v2 plans and transmission receipts; recovery decodes stored versions explicitly. `Reading` accepts v1/v2; client renders synthesis/action/single optional question and public attribution. Existing saved v1 JSON is unchanged.

- [ ] Add failing lifecycle tests for new v2 output, exact input, distinct hashes, fallback, saved v1 reopen, omitted-note rejection, cancellation/withdrawal and quota/cost behavior.
- [ ] Implement version-aware generation and UI without enabling history or external production dispatch. Separate actual prompt/schema/validator hashes from simulation policy identity.
- [ ] Regenerate schemas/registries and run relevant domain/D1/browser suites; expected PASS. Commit.

### Task 5: Bounded development acceptance and final review

**Files:** evaluator v2 profile, tooling tests, content-free result documentation; exact outputs/inputs remain in protected external archive.

**Interfaces:** Fixed new profile uses the four current diagnostic contexts/draws, richer content and v2 output in one change, same fast/xhigh. Maximum four calls, $0.64, no retries; fresh permit; zero-call dry-run and crash recovery required.

- [ ] Add failing dry-run, permit, budget and crash/resume tests; implement schema-specific evaluation without changing old manifests.
- [ ] Execute one bounded development probe with accurate agent-only content review status and full packet/receipt evidence; review every output against exact input.
- [ ] Run `npm run verify`; expected all tests/checks PASS with no live access. Audit exported PDF/request/hash fidelity.
- [ ] Obtain the required independent whole-change review, fix actionable findings with failing regressions, verify final source identity and commit. Preserve the requested worktree; leave production/human approval pending.
