# Reading v2 editorial candidate

**Follow-up:** L6 now binds these editorial instructions into its distinct application
policy. The owner then authorized the four-call candidate check, which
[completed successfully](2026-10-27-four-case-live-check.md). The candidate-freeze record
below describes the earlier state; its original outputs and freeze remain unchanged.

V2 remains the development baseline. This separate candidate addresses the supplied editorial review: preserve the scope of constraints, use source limits without repeatedly explaining safeguards, preserve the reader's degree of evaluation, and permit shorter complete readings. No additional provider calls or production promotion are part of this change.

The baseline profile `reading-v2-development-fast-xhigh` remains byte-for-byte reproducible with manifest `5e34ff3260f18e2078aa54233bc6fc3015f77ac97165c0802c15fdfbbc2a3945`. The four original outputs and their live evidence remain unchanged. I02 is retained as an editorial failure of constraint fidelity even though its mechanical screen accepted it. I01, I03 and I04 remain useful development examples with the tightening described below; this is not signed human acceptance.

## Candidate scope

- Profile: `reading-v2-editorial-fast-xhigh`.
- Policy: `reading-evaluation-context-editorial.v1`.
- Prompt: `tarot-developed-reading-editorial.v1`.
- Frozen candidate manifest: `01210e6ab7d35bd3d1db63a554afd8dc2cb43b94547f443c311153fe6c7ae084`.
- Validator: unchanged `bounded-developed-reading.v2.2`.
- Questions, draws, selected meaning packages and their limits, frames, references, schema and provider settings remain fixed.
- Only the developer instruction and the presentation preference change: `targetWords.minimum` is omitted, while the preferred maximum remains 320. The required interpretation, synthesis and action fields and their character ceilings remain intact. The action is structurally required; its proposed activity remains optional for the reader. The reflection question stays nullable.
- The application continues using the baseline. The candidate is available for a separately permitted evaluation, capped at four calls and $0.64, but no new permit or live run is created here.

The complete instructions are versioned in `src/contracts/provider-policy.ts`. Their changes require the writer to preserve comparative limits throughout all fields; leave unspecified boundaries to the reader; avoid inferring spare capacity from a discontinued activity; describe supports and their practical significance directly; use interpretive limits when choosing claims; and avoid upgrading a mismatch into failure or inferior work. Shorter prose is welcome only when it still develops the interpretations, synthesis and usable action.

## I02 editorial regression

Exact current input:

> I ended an unused study group and kept its shared resource list. I am choosing between paired reading sessions and a discussion channel. How can I compare these formats without taking on extra commitments?

The original failure spans three fields:

| Field | Recorded scope change | Required review |
| --- | --- | --- |
| Possibility | “whether they require any new commitment from you” | Do not equate new activity with an extra commitment. |
| Synthesis | “if it required a new obligation from you” | Do not exclude an option under a stricter limit than the reader supplied. |
| Action | “Mark a required new commitment as outside your limit” | Help the reader identify the boundary; do not assign it for them. |

These are proposed editorial replacements, not provider-generated outputs or edits to the original archive. Keep the existing fact, source and current-context references.

**Possibility**

Apply the same criteria to both options: their expected usefulness for your reading, how they could use the retained list, and the participation each would involve. Identify which demands would count as extra commitments for you. Separate observations from assumptions and note what needs checking, so the comparison can inform a decision before you agree to either format.

**Synthesis**

The retained resource list is something worth preserving. A format's usefulness and the demands it brings are separate considerations. Compare its benefits and expectations together, using your own boundary for what counts as extra commitments. Learning what each format involves can support that assessment before agreeing to either.

**Action**

For each format, note its expected benefit and the scheduling, preparation, participation, or response expectations it would involve. Separate required participation from optional extras, and identify which demands would count as extra commitments for you. Mark what is known and what needs checking so you can assess the formats before agreeing to either.

Review every field, including later advice and closing language. An option must not be rejected merely because it is new, nor should ending the old group be treated as proof of spare capacity. A comparison can distinguish replacement, reorganization and additions without assuming which arrangement the reader intends. If a future reader explicitly prohibits **any new commitment**, preserve that stronger limit instead; this regression is not a general ban on the phrase “new commitment.”

## Other editorial references

- **I01:** Make the synthesis distinguish a working process from the suitability of its format for a cohesive collection. State manageable workload as the baseline, without introducing and denying “hidden strain.” Preserve the concrete criteria and evidence-versus-assumption comparison.
- **I03:** Keep the two-opening experiment and the observation of whether either invites continuation. Let the interpretation explain how keeping the group and workspace steady supports that comparison. Remove repeated claims that no discouragement, confidence loss or hidden problem is being invented.
- **I04:** Use “Your sketches did not match what you imagined, and drawing with a friend helped.” Preserve the integrated limited experiment and the distinct question about what helped during the session. Remove defensive problem-denial sentences; do not change mismatch into inferior work.

Meaning limits remain in the packet. The candidate asks the writer to satisfy them through the claims it chooses; it does not remove the limits or require boilerplate reassurance. These are editorial review criteria, not a claim that deterministic biography screening can measure constraint fidelity or prose quality.

## Verification and future use

```sh
npm run provider:evaluate -- --dry-run --profile reading-v2-editorial-fast-xhigh
```

The dry run needs no credentials and makes no calls. The largest complete candidate request estimates 12,139 conservative input tokens, below the unchanged 16,384 bound. Automated checks compare the complete request against the frozen baseline, permit only the declared instruction/preference changes, retain action requirements and character bounds, enforce profile-bound permits and spending limits, and exercise crash recovery without resend. They establish request integrity and lifecycle behavior, not the quality of new generated readings. No new model outputs exist for this candidate yet.
