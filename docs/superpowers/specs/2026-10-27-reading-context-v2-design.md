# Reading context and output v2

The owner's implementation decision is the specification: keep exact local lookup, send
the exact current input and validated draw, richer orientation meanings, explicit position
definitions, and zero to two eligible reviewed relationships. Produce three interpretations,
a sourced synthesis, an optional action, and zero or one reflection question. The target
is 220–320 useful words, with character ceilings 650/650/500/200 for each interpretation,
synthesis, action and question respectively. This work extends the current local simulation
and evaluation paths; it does not confer production content/provider approval.

## Decisions and boundaries

- RWS, Situation / Tension / Possibility, selected orientation meanings only.
- Current question is authoritative and preserved byte-for-byte; `reader:question` is its
  only context reference. History selection remains empty and all grant/export/erase guards stay.
- Existing v1 content, plan, candidate and accepted-reading identities remain parseable and
  immutable. New contracts have explicit v2 identities; existing evaluation hashes stay fixed.
- Each meaning has substantive core text, two or three distinctions, an already-working
  application, specific limits, optional verified imagery, themes, and public attribution.
  Lookup prefers an eligible position-specific source, then the neutral orientation source.
- Relationships have exact deck/card/orientation or thematic eligibility, selected source
  references, priority, version, hash, support and limits. All conditions must match; at most
  two are chosen by ascending priority then stable ID. No approved records means an empty list.
- Keep approval and rights metadata accurate. Develop a separate 156-entry draft from local
  editorial inputs; retain agent review and unknown rights. Reviewed runtime admission fails
  closed. Explicitly marked local/evaluation scopes may inspect drafts without forging approval.
- The model-facing projection is an allowlist. Private rights/reviewer/account/security data
  remains outside it. A separately frozen receipt binds sources, spread, relationships,
  omissions, policy, actual prompt, schema, validator and exact request bytes.
- Budget the complete UTF-8 request including schema/instructions. Drop optional relationships
  first, then optional imagery; never truncate required text. Reject oversized required content.
- The v2 evaluation policy retains gpt-6.1-terra, fast/xhigh, 8,192 output tokens and 60 seconds.
  Its explicit input ceiling is 16,384 conservative tokens (UTF-8 bytes + 256 framing), with
  16,128 payload bytes and a $0.16 reservation (maximum calculated token cost $0.122880).
  Production qualification must separately approve this larger bound.
- Existing application simulation remains intercepted, with synthetic provenance. V2 local
  policy/prompt/schema/validator hashes are distinct. New generation uses v2; saved v1 reads
  retain their exact JSON. Interrupted v1 requests are never reinterpreted under v2.
- A versioned local safety screen checks every prose field. It admits narrowly supported
  natural current statements while preserving negation, hypothetical scope and attribution;
  it does not claim semantic entailment certification.

## Approach

The owner selected deterministic enrichment of the existing architecture. Semantic retrieval,
extra model calls and history gathering are outside scope. Add focused v2 domain modules and
shared version dispatch at runtime boundaries, preserving v1 schemas and evaluation policies.
Extend activation tooling to inspect v2 content without approving it. The complete draft and
its review packet are reviewable artifacts; actual human/rights approval remains external.

## Acceptance

Tests must prove exact text preservation; source specificity/fallback and full coverage;
position retention; relationship all-condition selection and tie order; no private-field
egress; meaning-preserving budget omission; dynamic reference validation; supported and
unsupported biography pairs; synthesis/action/question bounds; authentic version hashes;
v1/v2 saved read, recovery, fallback, cancellation, withdrawal and cost behavior. A bounded
live development probe uses a fresh permit and exact evidence, retains fast/xhigh, and is
explicitly not human acceptance or production activation.
