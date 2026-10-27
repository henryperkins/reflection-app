# Four-case live development check

The owner approved replacing the immediate large L7 exercise with one run of I01–I04,
using the existing editorial candidate and fast/xhigh settings, capped at four calls
and $0.64. This development checkpoint is complete. The broader provider qualification
is deferred to production readiness.

## Execution

- Run: `58b81ef2-ee0d-47f9-b635-bbe3e2106c55`.
- Code at execution: `9ead26c`.
- Profile: `reading-v2-editorial-fast-xhigh`.
- Evaluation policy: `reading-evaluation-context-editorial.v1`.
- Policy hash: `32b3d1c1d55694b3dbec2f9104aaacffe45fa0b36ccb6840f9c8028ead08a0cb`.
- Frozen manifest: `01210e6ab7d35bd3d1db63a554afd8dc2cb43b94547f443c311153fe6c7ae084`.
- Prompt: `tarot-developed-reading-editorial.v1`; validator:
  `bounded-developed-reading.v2.2`.
- Requested and returned settings: GPT-6.1 Terra, fast service, xhigh reasoning.
- Questions, draws, six meaning packages, position definitions and case-specific schemas
  match the frozen candidate. No additional context or relationships were added.

| Case | Automated screen | Reading words | Provider duration | Calculated cost |
| --- | --- | ---: | ---: | ---: |
| I01 | Accepted | 209 | 31.826 s | $0.037261 |
| I02 | Accepted | 200 | 31.525 s | $0.032934 |
| I03 | Accepted | 193 | 22.855 s | $0.029816 |
| I04 | Accepted | 162 | 25.349 s | $0.029059 |
| Total / mean | 4 of 4 | 191 mean | 27.889 s mean | $0.129070 total |

Each case has one fetch invocation, a recorded outcome and a usage receipt. There are
no refusals, invalid responses, validation rejections or unknown outcomes. Dry-run
preflight made zero calls. Resuming the completed run with a writer trap made zero
calls. Frozen and sent request bytes match, and the encrypted journal/archive
authenticated successfully. The largest conservative input estimate is 12,139, within
the unchanged 16,384 bound.

Cost is calculated from recorded token/cache usage and the frozen policy, including
all output/reasoning tokens. It is not independent confirmation of the provider bill.
Provider duration is not application end-to-end latency.

## Editorial review

This is an AI editorial assessment against the exact questions, six supplied meanings,
position definitions and instructions. No material failure of the targeted requirements
was observed in these four outputs.

- **I01:** Preserves the successful newsletter and manageable workload. Supplies concrete
  criteria for comparing formats against the collection goal. The synthesis could still
  develop the process-versus-format distinction further.
- **I02:** Preserves the scope of “extra commitments” through interpretation, synthesis
  and action. The reader determines which demands count as extra; new activity is not
  automatically excluded. Ending the group does not become assumed spare capacity.
- **I03:** Uses the welcoming group and working desk as supports, without contradicting
  “not discouraged.” Gives a two-opening experiment and an observation that permits
  either or neither attempt to help.
- **I04:** Retains the mismatch with the imagined image without calling the sketches
  inferior. Preserves the routine and offers a focused experiment with something to
  observe. One unnecessary guarantee caveat remains a minor style issue.

All four develop distinct source contributions, connect them in synthesis and offer a
usable optional action. None repeats the earlier denials of hidden strain or manufactured
discouragement. All optional reflection-question fields are null.

Mean reading length is 191 words, versus 287 in the earlier four-output v2 batch.
That is about one-third shorter. Cost and mean latency are slightly higher than that
earlier batch; this run does not establish a performance improvement. Three of four
provider durations exceed 25 seconds. The sample is too small to establish general
reliability or a production latency percentile.

**Decision:** Retain the editorial candidate for development. No further prompt change
or paid rerun is needed to close this checkpoint. Latency remains the main practical
tradeoff under the requested fast/xhigh configuration.

## Retained evidence and boundary

Exact unchanged readings and complete requests are in the private run archive under
`~/.local/state/reflection-provider-evaluation/archives/58b81ef2-ee0d-47f9-b635-bbe3e2106c55/review/`:
`four-readings.md`, `four-readings.json` and `editorial-review.md`. The JSON includes
the actual sources, position definitions, full instructions and per-case schemas.
Authenticated raw provider responses remain encrypted alongside the journal; the key
is outside the archive and repository. The existing 90-day retention applies to the
review copies as well.

Execution approval is recorded separately from editorial acceptance. This review does
not create human content approval, rights clearance or a production provider receipt.
The evaluation policy remains distinct from `reading-provider-policy.v2`; qualification
eligibility is false. L6 integration is already implemented, and the owner-revised L7
development check is complete. The application production gate remains pending.
