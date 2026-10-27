# Reading context and output v2 development probe

The implementation now sends exact current reader text, validated canonical draw metadata, three substantive orientation meanings and explicit position definitions. Eligible reviewed relationships are bounded to two; this draft has none. The output separates three interpretations, synthesis, an optional action and at most one reflection question. Saved history remains disabled, and saved v1 readings reopen unchanged.

The complete draft and review packet are in `content/reading-canon-v2-draft.json` and `content/editorial/reading-v2-review.md`. All 156 entries remain agent-reviewed with unknown rights. Their development use does not authorize production content or dispatch. The application path remains a labeled localhost simulation; actual provider calls below were made by the separately permitted evaluator.

## Live evidence

Four calls used the existing I01–I04 questions and the same card IDs, orientations and positions as the prior independent-context probe. The context, meaning, prompt and output changes were evaluated together. Model settings remained `gpt-6.1-terra`, `fast`, `xhigh`, 8,192 maximum output tokens and a 60-second timeout. One attempt per case, at most two concurrent calls, no retries, maximum reservation $0.64.

| Identity or result | Value |
| --- | --- |
| Run | `c7e3faf0-57b0-48e7-9353-c19c845ef354` |
| Frozen live manifest | `c4075c19ed6dee0e6106771bd22f17ae872769a71692518ca62949b0bc1f3a44` |
| Draft content | `9b54868413800545a76451a58d7f4267b58ce3f0d5c6d94379579ca57acf78ab` |
| Recorded attempts / provider candidates | 4 / 4 |
| Known receipts / uncertain calls | 4 / 0 |
| Calculated total cost | $0.122120 |
| Mean reading length | 287 words |
| Mean recorded duration | 25.9685 seconds |
| Mean reported reasoning tokens | 1,827.75 |
| Maximum estimated input | 11,095 conservative tokens, below 16,384 |
| Recorded fetch invocations / maximum overlap | 4 / 2 |
| Completed-run resume calls | 0 |

The estimator counts complete serialized UTF-8 request bytes plus 256 framing tokens. The new maximum is 16,384; the per-call reservation is 160,000 microUSD. At declared fast prices, the maximum input/output calculation is 122,880 microUSD per call. These are development bounds requiring separate production qualification. Usage-based costs are calculated from provider receipts, not independently reconciled billing.

## Screening correction, with original results preserved

The frozen live validator recorded two accepts and two `BIOGRAPHY_UNSUPPORTED` rejections. All four provider responses contained structurally valid v2 candidates. The two rejected outputs exposed mechanical false positives:

- I03 carried the reader's explicit negation from a coordinated sentence into “Since you are not discouraged”. The initial matcher only recognized an isolated first-person sentence.
- I04 referred to the reader's explicitly imagined sketch as “the image you had in mind”. The initial screen treated the ordinary possessive idiom as invented biography.

Regression tests first reproduced both failures, alongside hypothetical, reported, negated and scope-changing alternatives. The correction is separately versioned as `bounded-developed-reading.v2.1` and `reading-evaluation-context.v2.1`. The executable validator also checks its own identity against the frozen plan. Prompt, schema, reader input and request bytes did not change.

Offline re-screening accepts all four unchanged outputs with the corrected identity. This made zero provider calls and did not alter the archived live manifest, journal assessments or output text. The current development manifest is `06bca03a345b194e6880411b05491a7c04d82b1b6cf8bedcc33ba16dad552faf`; it is not a second live run. The initial v2 policy remains frozen for interpreting the original receipt and safely fencing interrupted work from that policy.

## Editorial assessment

This unblinded AI assessment supports continued development, not human acceptance or general reliability. The four outputs use the supplied context and retain distinct source contributions. I01 protects a working, manageable newsletter while comparing formats. I02 treats the no-extra-commitment constraint as a condition of the comparison. I03 preserves existing creative supports and offers contrasting story openings. I04 acknowledges supplied discouragement while retaining the routine and proposing a limited sketch experiment. Each synthesis connects the considerations, and each action explains what an observation could inform. Only I04 adds a reflection question.

There is still room to make the prose more economical. I01 spends words denying a hidden problem; I03 repeats permission not to find a problem. I02's treatment of a “new commitment” deserves human review for whether it accurately expresses the reader's limit on “extra commitments.” These are editorial judgments, not automated grounding scores. Four previously used development contexts and two draw families cannot establish reliability, isolate causal effects, or establish parity with another product.

## Review artifacts and reproduction

Protected artifacts remain outside the checkout under the evaluation archive for the run ID. The `review` directory contains PDF, Markdown and JSON readings; every exact request, frozen plan and context receipt; complete selected meanings and frames; schemas by case; normalized outcomes; provider response projections and timestamps; permit and hash inputs; and an offline re-screen supplement. Reasoning payloads are omitted from shareable projections. Exact raw bytes remain in the authenticated encrypted archive. Human review and production approval are not recorded.

The current profile can be inspected without credentials or network using:

```sh
npm run provider:evaluate -- --dry-run --profile reading-v2-development-fast-xhigh
```

Tests cover zero-call dry runs, fixed four-call/cost caps, crash liability without resend, exact question preservation, budget omission order, source/relationship bindings, scope-sensitive biography screening, v1/v2 persistence, recovery, fallback, cancellation, withdrawal, export and independent cost/quota accounting. New live execution requires a permit bound to the exact current manifest; the old permit does not authorize changed inputs or validator policy.
