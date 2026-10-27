# Reading editorial standard

Status: revision standard for evaluation and human review. This document does not
qualify a model, approve source text, activate production, or change a frozen prompt.

The owner's quality target is the specificity and practical usefulness of the stronger
saved `henryperkins/tarot` readings, with stricter grounding throughout. The reference
comparison and manual regression cases are recorded in
[the Tarot quality target](../content-review/tarot-quality-target.md).

## Substance and section progression

| Section | Expected contribution |
| --- | --- |
| Situation | A source-supported observation about what deserves attention in the supplied context. |
| Tension | A distinct, supported contrast, trade-off, constraint, or uncertainty. |
| Possibility | An optional response, experiment, observation, or question that advances the reflection. |

Interpretation must contribute something beyond paraphrasing its reflection question.
Each question should have a different job, with an answer that can inform the next
section. Preserve conditional language and the freedom to decline an interpretation.
Present keeping an existing arrangement as an available choice when the material does
not justify preferring change.

Connect the positions when their sources support a meaningful relationship. A synthesis
must explain how the contributions work together and answer the actual question. It
must not merely repeat the section summaries or offer generic reassurance. Supply a
usable optional method (for example, how to choose comparison criteria, collect feedback,
or evaluate a reversible experiment); do not leave the reader to design the whole method.

Unknown circumstances remain unknown at every use. An early conditional does not carry
automatically into a later question, metaphor, exercise, recap, or closing. Do not infer
readiness, completed personal history, another person's mental state, recovery timing, or
outcome probabilities from symbols. Explicitly supplied facts remain available within
their original scope. Specificity should come from supported ideas and useful methods,
not from invented circumstances.

Apply conditions to unsupplied personal circumstances without making ordinary methods
sound doubtful. A request to compare choices already supports discussing criteria and
evidence; it does not require repeated “if any” checks. State supplied facts directly,
preserve their scope, and allow already supportive or manageable conditions to remain.
Offer a concrete optional action linked to the goal. Keep its optional status in later
questions and the closing; avoid replacing useful guidance with broad permission to do
nothing. General source statements need no added hedge merely because they are general.

For each case the reviewer records what changed because of the user's setting beyond
mentioning its nouns. Review whether the reading adds something beyond restating the
request. Semantic progression and usefulness require human judgment; a lexical check
cannot certify either.

## Source support and sparse material

Inspect the source passages before assessing the writer. For each position, record the
source-supported idea, its application to the user's context, and the evidence connecting
them. A source assertion and a proposed application must be distinguishable. Fact/source
IDs establish traceability; they do not prove that prose follows from a passage.

Card identities and orientations remain in the separately rendered facts. Their
interpretive contribution must be supported by the selected source, not conventional
meanings recalled independently by the model. Do not reward unsupported specificity.

When selected passages are identical or too sparse to support the requested section
jobs, mark source adequacy for review. Do not stretch one observation across three
headings and call it a finished reading. The permitted alternatives are to obtain
richer reviewed material or explicitly offer a generic reflection exercise. Source
adequacy is a prerequisite for finished-reading approval, not a requirement that three
strings merely be different.

Keep synthetic provenance visible in the report and evidence. When revising the
reader-facing prompt, provide the disclosure once and use source links/IDs for
traceability; do not make every interpretation restate technical provenance. For a
controlled source comparison, preserve the original disclosure and prompt so that
only source substance varies. A later prompt comparison is a separate experiment.

## Evidence required for review

A review packet must include exact system/developer instructions, request settings,
provider-visible question/draw/source payloads and their hashes, source-to-position/card/
orientation mappings, the full manifest, and unchanged outputs. Source text must remain
visible in printed PDFs. Label reproduced local draw state separately from archived
wire requests; do not describe reconstructed data as an original snapshot.

Export response schemas by case, with hashes for each request. A source-ID enum may
differ between cases even when the schema is held fixed across prompt arms within a
case. Include full normalized outcomes/receipts, returned settings, provider IDs when
captured, journal events, and the objects/definitions needed to reproduce semantic
hashes. Distinguish exact response bytes from projections with reasoning fields omitted.
Preserve missing historical timestamps as unavailable; do not infer client start/finish
or concurrency from provider timestamps. Archive integrity and external execution or
billing authentication are separate claims.

Record mechanical screening, later editorial signals, and the human decision separately.
Preserve historical results. Grounding may be `NV` (not verifiable); do not replace it
with zero or a passing score, or compute a combined quality score while it is unresolved.
No absence of flags implies human approval. Record whether a decision concerns a
finished reading or a generic journaling exercise.

## Additive editorial screen

Run the offline report against a protected review export:

```sh
node --import tsx scripts/provider-editorial-review.ts \
  --packet /private/run/20-fast-xhigh-readings-for-review.json \
  --out /private/run/editorial-screen-v1.json
```

The output stays beside the external packet, is created with mode 0600, and cannot
overwrite an existing report. It binds the packet hash and makes no provider call.
It flags identical normalized source text, fixture language in reading prose, shared
six-word interpretation openings, repeated clauses of at least three words/20 characters
across sections (including semicolon-delimited clauses), duplicate questions, and exact
question restatements. These are review hints with possible false positives and false
negatives, not an acceptance validator or semantic entailment check.

Human review additionally assesses source fidelity, source-versus-context attribution,
section progression, question distinctness, advancement beyond the prompt, substantive
context adaptation, supported card/orientation distinctions, and autonomy.

## Controlled source diagnostic

Use A07-2 and A08-1, each with the original sources and reviewed distinct sources, three
new attempts per condition: 12 outputs. Freeze questions, draws, source IDs, instructions,
schema, model, reasoning effort, tier, and other request settings. Change only the source
text. Review the exact proposed passages before execution. Keep the existing xhigh/fast
limits: two concurrent calls, no retries, $0.12 reserved per call, $1.44 maximum liability.

Record review provenance accurately. For the owner's authorized source diagnostic, the
six-passage review is an AI editorial recommendation with one exact clause revision;
it is not human approval. A fresh run permit separately binds execution to the revised
source bundle and full request schedule. This experimental exception does not satisfy
human content approval or finished-reading qualification requirements.

The diagnostic is exploratory, with no inference of statistical certainty. If richer
sources still collapse into the same framing, hold those sources fixed in a separately
budgeted prompt comparison. Do not change sources, prompt, and model together.

These 20 reviewed cases can inform revision. After that use, their calibration/holdout
labels do not make them fresh independent evidence for the revised policy. Qualification
needs untouched grouped examples and broader topic/draw coverage.

The 12-call source diagnostic is not the fair model comparison. A subsequent comparison
must also hold the interpretive frame and approximate output length constant. The current
v1 output contract (650 characters per interpretation, 200 per question, 250 for closing)
was designed for short reflections. A 500–700-word reading target needs a separately
versioned evaluation prompt/schema with room for synthesis and a practical method, while
preserving stored v1 readings. Require enough reviewed source material before filling
that space. No padding requirement or claim that length alone establishes quality applies.

## Controlled uncertainty-prompt comparison

The next authorized diagnostic holds the six revised source passages fixed in both arms
and compares the original developer prompt with `tarot-writer-uncertainty.v1`. The new
instruction requires conditions to survive locally through questions, advice, synthesis
and closing. It allows a problem to be absent, preserves facts explicitly supplied by
the reader, and avoids requiring extra hedges on general source statements.

Use A07-2 and A08-1 with three fresh repetitions per prompt: 12 calls. Keep the system
instruction, question, sources, draws, schema, model and fast/xhigh settings identical.
Alternate arms within case/repeat, freeze both prompt policy hashes, and retain the shared
$1.44 limit and no-retry rule. A revised prompt is an evaluation candidate; it does not
replace the application prompt or confer approval on the outputs. Review every output
against the exact inputs, including useful content that might be lost through excessive
hedging. Report semantic findings separately from mechanical passes.

The supplied follow-up review is an AI editorial assessment, not human acceptance.
Retain revised repetitions A07-2.3 and A08-1.3 as positive references, old A07-2.2 as a
concise conditional example, revised A07-2.2 for overqualification, and old A08-1.1/.3
for presupposed unwelcoming expectations. The six passages remain unchanged. The
concise-prompt follow-up uses four new synthetic contexts to probe supplied facts,
supportive/manageable conditions and a useful optional action. One output per context
cannot establish reliability, and changing contexts prevents a causal speed/cost or
length comparison with the prior batch.
