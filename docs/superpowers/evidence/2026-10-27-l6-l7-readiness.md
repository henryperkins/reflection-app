# L6 integration and L7 readiness

The application now has a shared `ReadingGeneration` lifecycle with explicit content,
policy, writer, and readiness dependencies. The local simulation owns its bootstrap and
migration in a separate wrapper. The default Worker still has no live dependency factory.

The application candidate uses `reading-provider-policy.v2`, the developed v2 output,
the editorial constraint-scope and prose-economy instructions, GPT-6.1 Terra, fast service,
and xhigh reasoning. Its policy hash is
`3077daeae5ca5ce6f634846720f48abadc3c1c8b5ccde9c72e300d0a739c359d`.
It reserves at most $0.16 per attempt, including reasoning tokens, with a 60-second
provider deadline. Qualification of earlier evaluation profiles does not qualify this identity.

## Integration behavior

- `createWorker(factory)` is a trusted server composition seam shared by request and
  scheduled recovery. The qualified mode requires that factory. Production identity,
  secret loading and deployment configuration remain P1 work.
- Admission needs installed, enabled content/policy state, signed content and current
  provider qualification. It does not install synthetic content or enable generation.
- Dispatch and publication recheck authorization. Atomic D1 guards bind the verified
  content/approval bytes and policy revision, provider qualification expiry, account,
  permission, cancellation, lease, key fence and installed policy.
- A received candidate can resume under its original policy. Changed policy terminalizes
  pending work. An authorized dispatch is never sent twice, including after lost acknowledgment.
- Exact accepted text, source snapshots and v1/v2 saved readings remain readable without
  provider credentials or AI consent. Live transmission exports preserve their receipts.
- OpenAI model output, prepared templates and local simulation have distinct attribution.

## Proposed L7 run

The machine-readable [proposal](../../../qualification/evidence/provider-v2-proposal.json)
is deliberately **not executable** and contains no permit or qualification receipt.
It lists all questions, case IDs, proposed draws and selected source bindings, along with
missing evidence and acceptance criteria. Final request hashes remain null until the
reviewed content and final corpus can be frozen.

The proposed schedule contains 244 checks: the 240 staged corpus cases plus I01–I04 as
four development regressions. Current admission rules produce **144 potential provider
calls and 100 offline checks**. The hard reservation ceiling is **$23.04**, at most two
concurrent calls and one attempt per case, with no retries or comparison arms. These are
proposal bounds, not spending already performed or authority to execute an unfrozen run.
Follow-up cases test explicit rejection; saved history remains disabled. Draw seeds use
SHA-256 of the raw UTF-8 group text, matching the existing evaluation builders. I01–I04
retain their original questions, draws and meaning packages.

The run would use the existing external encrypted archive under
`~/.local/state/reflection-provider-evaluation`, a separate run directory, and 90-day
retention. Exact sent requests, source packages, schemas, raw responses, request IDs,
attempt timestamps, usage and journal integrity belong in that archive. Only redacted
summaries and evidence hashes belong in the repository. The encryption key stays outside
both archive and repository.

The original split labels are retained for traceability. A09/A10 have already been
inspected during development; they are not untouched confirmation evidence. A fresh,
predeclared confirmation set and twenty genuine human-approved examples are required
before final freezing. Any replacement changes the proposal, cost bounds and manifest.

## Evidence still missing

1. A named responsible reviewer and signed approval/rights evidence for the current v2
   catalog and product copy. The [complete review packet](../../content-review/2026-10-27-reading-canon-v2.md)
   covers all 156 orientation packages, positions, fallbacks and copy. All 156 currently
   remain agent-reviewed with unknown rights; the owner's broad instruction to proceed
   does not change those facts.
2. The target environment and evidence of model access, retention and data-sharing
   settings, current pricing and eventual isolated-project billing. The project ID was
   already supplied through `.env`; retain that value in the external permit.
   The connected Platform tools available here support key setup; they do not expose
   these project privacy or billing settings.
3. Final corpus review, execution under a hash-bound permit, responsible human scoring,
   usage/billing reconciliation and signed provider qualification. None has been issued
   for the application candidate.

Previous live diagnostics remain useful development evidence. They are not a substitute
for this run. In particular, the four original v2 outputs averaged about 25.97 seconds;
that does not establish compliance with the accepted-reading p95 limit of 25 seconds.
The threshold remains unchanged. Report provider time, total time and recovery separately,
including missing/unknown outcomes rather than excluding them from performance results.

The proposal carries the plan's quality, safety, latency and cost criteria. Rates must
include exact numerators, denominators and Wilson 95% intervals. Automated screening
cannot supply human grounding or usefulness scores. A small sample cannot establish a
population-level one-percent escape guarantee.

No new paid API calls, human approvals, production qualifications or activation occurred
in this integration task. All ten production acceptance gates remain pending.
