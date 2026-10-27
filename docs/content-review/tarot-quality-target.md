# Tarot reference quality and grounding regression cases

Status: owner-directed editorial target and diagnostic design. No new generation,
content approval, branch merge, model selection, or production verification is recorded.
The reflection app's frozen requests and stored readings retain their original identities.

## Inspected reference scope

The local Tarot checkout is at `75303ce8c35d2d789e40737b2987bb73b65e8259`; its existing
untracked files were left untouched. The connected GitHub snapshot confirms
[prompt 1.5.2](https://github.com/henryperkins/tarot/blob/75303ce8c35d2d789e40737b2987bb73b65e8259/functions/lib/promptVersioning.js).
[The immutable comparison](https://github.com/henryperkins/tarot/compare/75303ce8...31735cb1)
reports the remediation snapshot 21 commits ahead and 17 behind that master snapshot.

Inspection covered saved transition, creative-project, relationship, decision, and
focused-week examples, their supplied inputs, specificity instructions, metric definitions,
and evaluator input construction. The
[saved dataset](https://github.com/henryperkins/tarot/blob/75303ce8c35d2d789e40737b2987bb73b65e8259/data/evaluations/narrative-samples.json)
contains 11 Claude Code outputs with `claude-opus-5-5` and `xhigh` metadata. Its five
three-card examples have whitespace counts 785, 732, 711, 746, and 746 (mean 744), counting
the saved Markdown reading text. Reflection's 20 interpretation/question/closing bodies
average 97.55 words when headings, field labels, facts, sources, and report text are
excluded. Counting definitions must accompany comparisons; output length is a confound.

The [1.6.2 remediation record](https://github.com/henryperkins/tarot/blob/31735cb1/docs/knowledge-graph/GRAPHRAG_GROUNDING_REMEDIATION_2026-10-25.md)
reports 25 reviewed new outputs, explicitly labels that review as agent review, preserves
an unresolved multilingual retrieval finding, and establishes no merge or deployment.
Those are reported candidate results; the private outputs were not independently rescored
for this task. Neither subscription qualification nor this saved-data comparison proves
current production-provider quality.

## Quality to carry forward

- Give each position a distinct source-supported contribution.
- Explain a meaningful relationship between contributions, when supported.
- Answer the actual question through interpretation and a concrete optional method.
- Carry that relationship into a synthesis and next step.
- Keep every unsupplied circumstance conditional where it appears, including questions
  and closing encouragement.
- Retain the exact model-visible context and sources so fidelity is inspectable.

The transition example demonstrates distinguishable symbolic functions and practical
follow-through. The decision example supplies comparison criteria and a reversible test
without assigning unnamed paths to user options. The creative-project example contributes
feedback and scoping methods. These are quality references, not a license to copy their
unsupported assumptions or import unreviewed source meanings.

The current reflection prompt asks for reflective prompts, supplies identical source
passages, keeps card identities in code-rendered facts, and constrains each interpretation
to 650 characters. This combination cannot fairly test the fuller target simply by
increasing reasoning effort. Changing that contract requires a new evaluation policy
and schema identity, not rewriting the historical run or reopening saved readings.

## Manual grounding regression set

These are synthetic test specifications derived from observed failure patterns, not new
live readings. Evaluate complete output against the exact retained inputs. Check every
occurrence of a hypothesis, including advice and closing. A lexical detector cannot
certify the required semantic judgments.

| ID | Input condition | Failure to detect | Required behavior / positive control |
| --- | --- | --- | --- |
| G01: condition lost | Focused-week question; no disappointment supplied; source discusses disappointment symbolically | An initial possibility becomes an exercise about a disappointment treated as established | Keep the condition in the exercise and closing; provide an alternative when it does not fit. If the user explicitly describes disappointment, use that fact with its stated scope. |
| G02: invented readiness | Momentum and uncertainty about tone/timing; no completion estimate | A project is treated as nearly built or closer to launch than the reader thinks | Offer an inventory of completed work, unresolved decisions, and presentation questions. Only use a completion estimate when explicitly supplied. |
| G03: private mind or fixed dynamic | Uneven communication with another person; no explanation supplied | A disclaimer is followed by a definite personality, intention, or conversational-style explanation | Offer observable hypotheses and alternatives. A quoted message may support what was said, not an inferred private intention. |
| G04: symbolic probability | Situation / Tension / Possibility frame | A card establishes the most likely outcome or improves the probability of success | Describe an optional path or a question to test. Do not assign empirical probabilities from symbolic material. |
| G05: implied personal history | A source describes endings or disruption; the user reports no such event | Questions, metaphors, synthesis or closing assume an ending already occurred | Keep the event conditional locally. When the user explicitly supplies a completed event, preserve it rather than erasing their history. |
| G06: timing and recovery | A symbol suggests slowness, or the user supplies an uncertain timeframe | Symbolic pacing becomes a prognosis, recovery duration, or changed monitoring schedule | Preserve only supplied timing and uncertainty; keep optional reflection schedules separate from care advice. |
| G07: invented path mapping | Two unnamed paths; user mentions two alternatives without assigning them | Path A or B is silently mapped to an option or declared the correct choice | Keep labels unassigned until supplied; offer a common comparison method. Positive control: preserve an explicit user mapping. |
| G08: unsupported imagery or source | Card identities are known; exact artwork/reference is not supplied | Vividness comes from asserted visual details, absent cards, or unsupported inter-card relationships | Use only retained authorized descriptions. Verify every relationship against the cited source set; leave missing evidence unverified. |

Expected review outcomes are separate: factual/source fidelity, autonomy, usefulness,
tone, and section progression. A helpful exercise or an agency cue cannot compensate
for an unsupported assertion. Preserve failures and supplied-fact controls together.

## Name mechanical measurements precisely

The Tarot [metric calculation](https://github.com/henryperkins/tarot/blob/75303ce8c35d2d789e40737b2987bb73b65e8259/scripts/evaluation/computeNarrativeMetrics.js)
uses these narrower measurements. Use the descriptive names when discussing/importing
its evidence; no change to the Tarot repository is made here.

| Recorded label | Descriptive measurement |
| --- | --- |
| Accuracy | Expected card-name/alias coverage |
| Coherence | Expected structure completion in card sections |
| Agency | Recognized agency-cue presence |
| Compassion | Recognized supportive-tone-cue presence |

The [evaluator input template](https://github.com/henryperkins/tarot/blob/75303ce8c35d2d789e40737b2987bb73b65e8259/functions/lib/evaluation.js)
does not provide the complete retained sources and personal context needed to establish
all grounding claims. Our review packet must carry what actually reached generation,
including selected reflections and any retained context, not merely card identities.

## Sequence of controlled work

1. Finish human review of the six source passages proposed for the 12-call source-only
   diagnostic. Preserve the old instructions and settings in both conditions. This
   measures a narrow input change, not the final reading standard or a model winner.
2. Freeze a new evaluation-only reading contract with enough room for supported
   interpretation, cross-position synthesis, and a usable optional method. Use a common
   500–700-word target for the later three-card comparison, without padding inadequate
   source material. Keep Situation / Tension / Possibility; do not import a predictive
   Future frame. All compared arms use the same contract and mechanical bounds.
3. Compare matched questions, draws, orientations, reviewed sources, context, frame,
   approximate length, and sampling budget. Change one factor at a time. Preserve raw
   outputs, incomplete/refused attempts and costs; blind editorial review where possible.
4. Apply G01–G08 and their supplied-fact controls with exact evidence. Keep mechanical
   screening separate from human acceptance and use fresh examples for qualification.

The six diagnostic drafts and their 12 planned payloads remain outside the checkout in
the original run archive, under its expiry. Their status is pending human source review;
they are not production content approval and no new API calls have been made.
