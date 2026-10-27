# L5 evaluator implementation and live smoke

Implemented in the existing `codex/terra-model-policy-migration` worktree. The evaluator
is a CLI-only tool; application provider qualification and production activation remain
pending. Usage and limits are documented in [evaluation/README.md](../evaluation/README.md).

## Fixed corpus and authorization

The staged corpus has 240 synthetic cases in grouped 60%/20%/20% splits: 80 must-accept,
80 adversarial, 40 non-reading, and 40 lifecycle/privacy/import contract sequences.
The baseline manifest schedules 200 generation slots; input admission currently allows
160 and blocks 40. The lifecycle entries point to existing offline suites and are not
counted as live generations. Twenty required genuinely human-approved examples are still
missing. Synthetic local source metadata is not editorial approval.

The owner explicitly requested live API testing and supplied a local key and project ID.
The run was bounded to three synthetic development cases, one concurrent call, a $0.12
conservative reservation cap, and no retries. The original API credential file was not
modified. The protected permit binds the project, credential hash, frozen inputs,
authorization expiry and external encrypted archive; the encryption key and permit are
outside the checkout. Project access was checked by a successful model lookup before the
run; that lookup is not proof of project retention settings or production qualification.

## Observed live results

Run date: October 26, 2026, America/Chicago.

- Run ID: `147ed7ab-1e40-4944-963b-9aa65cfe3ff4`.
- Smoke manifest: `857d80233cb25ad0d973c4b8cb37992e880e382c90a2e87716a5dc70ebc293bd`.
- Policy: the existing `gpt-6.1-terra` Standard/30-minute-cache policy.

| Case | Observation | Known usage | Calculated cost |
| --- | --- | --- | --- |
| A01-1: quiet reflection | No HTTP headers/body before the 18-second deadline; uncertain outcome | Unknown | $0.04 reservation retained |
| A11-1: follow-up contract | HTTP 200; candidate passed schema, binding and local safety checks; 4,114 ms | 722 input / 243 output | $0.001937 |
| A16-1: ordinary metaphor | HTTP 200; candidate passed schema, binding and local safety checks; 3,525 ms | 723 input / 235 output | $0.001898 |

The two known receipts report zero cache-read, cache-write and reasoning tokens. Their
calculated cost totals **$0.003835**. Including the uncertain attempt's full reservation,
the journal retains **$0.043835** in liability. These are receipt-based calculations and
conservative liability, not an independently reconciled invoice. Three observations are
not a latency, quality, privacy or cost qualification. No human usefulness scores were
assigned and no application content was activated.

The first attempt's original outcome was recorded as `uncertain/network`: a second
deadline signal in the evaluator raced the shared transport's timer. Its archive timing
shows about 18,023 ms with no returned bytes. A deterministic regression reproduced the
misclassification; the evaluator now leaves the deadline to the shared transport. The
original evidence is retained unchanged. No further paid call was made after that fix.

Resuming the original run was checked with a transport trap: **zero dispatches**, the same
three attempts, and unchanged liability. The uncertain attempt was never resent. Exact
request/response bytes and outcomes are encrypted outside the checkout with integrity
hashes and a 90-day retention deadline. The content-free journal also retains the run-ID
tombstone. Unattended deletion requires the operator to schedule `--purge-expired`.

## Verification

The offline evaluator/package tests cover invalid and expired permits; wrong project,
content and manifest; absent credentials; reused run IDs; call and cost caps; concurrent
reservations and execution locks; actual process kills after reservation and after writer
completion; resume without redispatch; receipt idempotency/conflicts; archive integrity;
90-day cleanup; no private packaging; extracted source digest equality; and the full-body
provider deadline. They run under the existing network deny setup.

Independent review found no blocking implementation defect. Two test coverage gaps were
corrected: wrong-project validation now supplies otherwise complete credentials, and the
response-persistence crash occurs after the writer resolves. The final verification
receipt is generated in `artifacts/verify.json`; it covers lint, typecheck, schema/SQL/API
checks, domain and D1 suites, builds, and browser journeys.

L6 integration, genuine human content approval, project privacy review, billing
reconciliation and the L7 qualification run remain separate work. The proposed rendering
comparison needs distinct frozen rendering policies before authorization; this baseline
does not pretend to run three variants of the same request.

## Human review of the fast/xhigh sample

The subsequent 20-case fast/xhigh run `ea8aa869-897b-40ad-9a7a-06a540cfb600`
returned 20 candidates with known usage costing $0.218928. Its frozen mechanical
screen accepted 19 and flagged A08-4 for repetition. The owner's later human review
recommended **Revise for all 20 as finished readings**, with grounding **NV** because
the reviewed PDF omitted source passages and full instructions. No combined quality
score or human approval is recorded. This feedback does not support selecting a model
or reasoning/tier configuration.

An audit of the archived request bytes confirmed that all 60 selected position sources
contained the same synthetic warning and one invitation to pause. There was no distinct
card/orientation interpretation in those passages. The fixed prompt additionally excludes
precise card names and orientations from interpretation prose. These are confirmed input
constraints, not proof that they explain every output weakness.

The original report exporter hid source details in print CSS. A new evidence packet
keeps all 60 passages visible, includes full instructions, source mappings, the frozen
manifest, and all 20 original wire request files. Reproduced local draw state is labeled
as such; its projection was checked byte-for-byte against archived requests. The original
PDF, outputs, receipts and screening results remain unchanged. The private packet records
the owner's individual decisions and scores, with NV preserved rather than converted to
a number. Both the evidence and proposed experiment remain under the original archive TTL.

The v1 mechanical validator compares whole sentences split at periods, question marks
and exclamation marks. A08-1's repeated clause precedes semicolons and has different
continuations, explaining the visible screening discrepancy. A separately versioned
offline editorial screen now flags shared openings and clauses, including both A08-1
and A08-4. Its signals cannot assess entailment or semantic usefulness and never grant
acceptance. See the [revised editorial standard](operations/reading-editorial-standard.md).

A source-only diagnostic is prepared for A07-2 and A08-1: two source conditions and
three repetitions per case, 12 new calls with a $1.44 reservation ceiling. Questions,
draws, source IDs, instructions and fast/xhigh settings are frozen. Six new experimental
source passages require human review before execution. They are explicitly AI-authored
drafts and confer no production content approval. No new calls were made during the audit.

## Source diagnostic follow-up

The owner subsequently instructed execution with five passages unchanged and one exact
edit to A08-1 tension: `uncertainty or discouragement, if present, to remain`. The supplied
review explicitly identifies itself as an **AI editorial recommendation**, not human or
production approval. That provenance is retained; a separate fresh run permit binds the
owner's execution instruction to the actual project, credential, manifest and budget.

The original proposal hash `fc51390bd27e9d8536532a32560376205365bb8905848e8a6f3cb695f560e070`
remains unchanged. The revised proposal is
`5cdd608abf1e2a7c862e0d8b2c458d1613f4a956396263ef835bf915d9b685f6`, the executable source
bundle is `455f2f85c326b6ade717738b74fcd8017420ce87c605b1ccd48efbef8dd9b4e7`, and the frozen
run manifest is `a74408fc3e5c986a9716638d1f98705b1e4b1073324d1d52dc1df495e6c6d4ba`.
Byte comparisons confirmed the control requests match the original archive and the
replacement requests differ from the earlier proposal only by the requested clause.

Run `076a039a-f4d8-4943-9feb-fc29dbcfe649` completed all 12 scheduled calls: A07-2 and
A08-1, original versus distinct sources, three repetitions per condition. The same
gpt-6.1-terra / xhigh / fast policy, instructions, schema, draws and source IDs were used.
Concurrency was capped at two, no retries occurred, and the $1.44 maximum was preserved.
All 12 returned candidates and known usage receipts; calculated cost was **$0.118590**.
There were no uncertain calls or refusals. All 12 passed the frozen mechanical screen.
Resuming with a dispatch trap made zero transport calls and left the accounting unchanged.

An unblinded AI editorial review of the exact inputs and outputs found all six replacement
outputs reflected the three different source contributions. The six control outputs still
centered on pausing. The replacement outputs were more specific but largely paraphrased
the sources; the experiment does not establish finished-reading quality.

Two replacement outputs demonstrate remaining grounding concerns despite mechanical passes:
A08-1 repetition 1 asks which expectations make it harder to feel welcome without leaving
room for none, and repetition 3 refers to the reader's uncertainty even though the source
only permits uncertainty if present. The source wording alone did not prevent an emotional
hypothesis becoming an assumed circumstance. These are agent review findings, not recorded
human decisions. No human output approval or provider qualification is issued.

The protected report includes unchanged prose, all 36 supplied passages, source/card/
orientation bindings, exact instructions, schema, original wire requests, frozen manifests,
costs, the source-review record and the subsequent AI editorial observations. Bundles vary
in length, content and differentiation together; this evidence does not isolate those
properties, compare model settings, or predict wider performance.

## Controlled uncertainty-prompt comparison

The owner next authorized 12 fresh calls with the same six revised sources, draws,
schema and fast/xhigh settings. `tarot-writer-uncertainty.v1` appends one developer
instruction requiring local uncertainty through questions, advice, synthesis and closing.
It explicitly preserves supplied personal facts and general source statements, and permits
problems to be absent. The old developer and system instructions remain intact. Only the
developer text differs between arms; this candidate is not the application prompt.

Run `a2865983-be06-4eb4-88d2-4f21b44a385e` used manifest
`6ae6bed8f21f57b24ef324b52ca832bbd3ed13ac5b5ad1117008b535eb28dd4c` and the unchanged source
bundle `455f2f85c326b6ade717738b74fcd8017420ce87c605b1ccd48efbef8dd9b4e7`. Its manifest binds
old policy `fffeae4c28480ba4c30c514624325d4a46a4774cbb0c13c57d922d8de24a5e50` and revised
policy `71ed7808b14c26fd79f1f0afb8ec525eace057695ac978da49beba740be90cee` under one fresh
permit and budget journal. Arms alternate within each case/repeat. Byte checks against
the prior run confirmed identical old-prompt requests and developer-text-only differences.

All 12 attempts returned candidates with known usage: **$0.203872** calculated total,
no refusals, unknown calls or retries. All passed the frozen mechanical screen. Resume
made zero further calls. Both arms retained gpt-6.1-terra, xhigh, fast, the same schema,
8,192 shared reasoning/output tokens, 60-second deadline and $0.12 per-call reservation.

| Descriptive observation | Old prompt (6) | Revised prompt (6) |
| --- | --- | --- |
| Calculated token-receipt cost | $0.061790 | $0.142082 |
| Mean reported duration | 8.49 seconds | 20.44 seconds |
| Mean reading-body words | 130.5 | 193.5 |
| Direct questions presupposing unwelcoming expectations, AI review | 2 | 0 |

The unblinded AI review found two old-prompt A08-1 questions presupposing expectations
that feel unwelcoming. A07-2 old repetition 3 also frames reducing/sharing duties as needed
to make each choice manageable. The six revised outputs preserved local conditions and
explicitly allowed useful existing arrangements, manageable commitments or absent problems;
no clear equivalent personal presupposition was observed. Neither arm repeated the exact
earlier possessive-uncertainty failure, so that particular improvement is not established
by these fresh controls.

The revised prompt retains distinct source contributions, but introduces repetitive
conditional phrasing, particularly in A07-2. This is a trade-off in readability and response
size, not proof of finished-reading quality. Costs and durations describe this small run;
no general speed, cost or semantic reliability claim follows. Human review remains pending.
The evidence packet retains all outputs unchanged, both full prompt texts, all source
passages, exact wire requests, hashes, receipts and separately labeled AI review notes.
