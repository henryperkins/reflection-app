# Provider evaluation

This CLI exercises the shared Responses transport. It does not activate the application,
approve content, or issue an application provider qualification.

`npm run provider:evaluate -- --dry-run` recomputes and checks `manifest.json` without
credentials or network access. `--dry-run --profile smoke` selects three named development
cases: A01-1 (quiet reflection), A11-1 (follow-up contract), and A16-1 (ordinary metaphor).
The same payload bytes and schedule hashes are used during execution.

`--dry-run --profile human-review` selects only A06-1 through A10-4: the 20
prompts marked for human review. A `purpose: human-review` permit binds that exact
schedule and its hash; 20 attempts reserve at most $0.80. All outputs remain
unapproved until a human records a review. This profile includes calibration and
holdout examples for inspection, without changing their split or tuning the policy.

The staged corpus contains 80 must-accept cases (20 quiet, 20 requiring genuine human
review, 20 follow-up contracts, 20 ordinary), 80 adversarial cases, 40 non-reading cases,
and 40 lifecycle/privacy/import sequences. Four related cases stay together; splits are
144 development, 48 calibration, and 48 holdout. Every example is synthetic and unreviewed.
The lifecycle entries identify existing offline suites and interleavings; their presence
in a manifest is not evidence that those suites ran. Deferred contracts do not enable
follow-ups or imports in the product.

The initial schedule has one controlled-facts variant and one attempt for each of the
200 generation cases. Admission currently excludes the 40 non-reading cases, leaving
160 possible calls and $6.40 in conservative reservations. The three-case smoke schedule
reserves at most $0.12. The plan's alternative 680-call rendering comparison is not
enabled: it requires genuinely distinct, separately frozen rendering policies. All
variants, repeats and smoke cases must appear in a permit's exact manifest; unused
call allowance does not authorize retries. No production-quality conclusion is possible
until approved examples, cleared launch content and the L7 reviews exist.

An operator executes only with `--execute --permit /absolute/protected/permit.json`.
The permit is a mode-0600 regular file, not a web request. It binds:

- `version: reflection-evaluation-permit.v1`, `scope: evaluation`, a unique `runId`,
  `purpose: transport-smoke|synthetic-research|human-review`, authorizer and authorization/expiry times;
- actual `projectId`, SHA-256 `credentialHash` of the selected key, model and
  policy/content/corpus/manifest hashes;
- `maxCalls` (at most 720), `maxConcurrency` (at most 2), `maxCostMicrousd` (at most
  40,000,000), an absolute external `outputDirectory`, and `encryptionKeyHash`.

Execution requires `OPENAI_API_KEY`, `OPENAI_PROJECT_ID`, and a distinct random 32-byte
base64 `REFLECTION_EVALUATION_KEY` in the process environment. It does not load dotenv
files automatically. Keep keys and permits outside this checkout. Preserve the encryption
key in protected operator storage for resume and private review. Requests carry the
specified OpenAI project header. The application wrapper rejects these permits.

The journal defaults to `~/.local/state/reflection-provider-evaluation/journal.sqlite`.
An operator may select a separate fixed `REFLECTION_EVALUATION_STATE_DIR` for an isolated
test environment; never move or delete that directory to restart a spent run. Its run-ID
tombstones apply across output locations. A per-run SQLite execution lock is released by
the OS after a crash. FULL-synchronous append-only reservations commit before dispatch,
and transactions serialize competing reservations. An interrupted attempt retains the
full 40,000-microUSD reservation. `--resume` requires the identical permit and skips every
reserved attempt, including those with no durable response. Run IDs cannot be recreated.

Known receipts reconcile actual disjoint input/cache-read/cache-write/output costs,
including refusal and invalid output. Unknown usage retains its full reservation.
Protocol drift, estimator underestimates, unsupported request configuration, or
above-reservation costs halt the run durably. No automatic provider retry exists.

Exact projected request bytes, received response bytes (bounded to 64 KiB), and outcomes
are encrypted with AES-256-GCM in mode-0600 files inside a mode-0700 external directory.
Incomplete response captures are labeled as such. HMAC-chained journal events bind the
artifact hashes and form their integrity manifest. The key, raw response IDs, prompts and
prose never enter printed summaries. Missing or changed artifacts block resume.

Private archives expire 90 days after authorization; reads and resume refuse expired
material. Run `npm run provider:evaluate -- --purge-expired` from the same state directory
to delete expired archives while retaining content-free run tombstones. Operators must
schedule this cleanup for unattended storage; the local CLI cannot guarantee deletion
while the machine is off. Keep the encryption key's retention under the same operator
policy.

`npm run verify` runs the evaluator's offline tests with network denial and without API
keys. Live execution explicitly refuses CI, Vitest, and `REFLECTION_NETWORK=deny`.
Packaging includes only this README, `corpus.json`, and `manifest.json` from `evaluation/`;
private outputs, keys and permits are excluded from both packages and source identity.
