# Content approval and provider cost operations

L3/L4 supply deterministic admission, local operator commands and accounting. Live generation remains disabled pending L5–L7 and the production qualification plan. No public HTTP route can activate content, import a bill or supply a trust key. These commands open only an explicit local D1 persistence directory. Stop the local application and maintenance runner before using a mutating command; the two reading operators share an exclusive lock.

## Review and activation

`content/launch-canon-draft.json` remains an agent-reviewed draft with unknown rights. The [review packet](../content-review/2026-10-27-launch-canon.md) lists all 156 card/orientation sources, deck and image references, position frames, fallback text and closings, disclosures, license, hashes and changes from the previous draft. It creates no approval record.

```sh
npm run content:activate -- --check --bundle content/launch-canon-draft.json
npm run content:activate -- --review-packet --bundle content/launch-canon-draft.json --out /protected/new-review.md
```

The draft check must fail. A structurally valid check still reports `approvalVerified:false`; it never substitutes for human review. Packet output must be a new file. `--previous <old-bundle.json>` adds readable changes and old/new hashes. Do not put private rights evidence in public bundles or review packets.

After actual human review and rights clearance, the approved bundle must contain exactly 78 cards × 2 neutral orientations, all three position frames, complete attribution and territories, individually reviewed source hashes, and the exact compiled `READING_PRODUCT_COPY`. An edited disclosure requires another source build and content approval. `contentApprovalDocument` in `src/worker/content/approval.ts` constructs the canonical `content-approval.v1` document for an external review/signing process. The document binds reviewer, environment, approval time, bundle/deck/copy/position/license hashes, every source hash, attributions, territories and the SHA-256 digest of private rights evidence. Sign RFC 8785 canonical JSON with the approved reviewer's external Ed25519 key. Keep the private key outside the checkout; configure the trusted public key independently of the approval input. This implementation creates no human signatures or trusted keys.

```sh
npm run content:activate -- --activate \
  --bundle /protected/approved-bundle.json \
  --approval /protected/signed-approval.json \
  --public-key /protected/trusted-reviewer-public.jwk.json \
  --rights-evidence /protected/rights-evidence \
  --environment local-review --reviewer reviewer-id \
  --expected-revision 4 --persist-to /local/state/v3
```

Activation verifies the evidence bytes and signature, then installs immutable canonical bytes in one D1 compare-and-swap batch. It increments the system revision, supersedes/fences previous content, and sets generation and dispatch off. An exact acknowledgment retry returns the same revision. An unrelated revision, changed bytes, synthetic reviewer, forged signature or withdrawn edition fails. `D1ContentRepository` authenticates stored approval and exact bytes; active reads require the compiled copy, while historical reads preserve their originally signed copy. A production factory must provide its protected trust configuration in P1/L6.

To roll back, use `--activate` with the original signed files for a still-cleared superseded edition and the current expected revision. Its bytes and approval stay immutable, while its content policy revision and the system pointer revision advance. The earlier edition must match the current compiled disclosures. Generation stays off, and old in-flight work stays fenced even when its content hash becomes active again.

```sh
npm run content:activate -- --withdraw --hash <edition-hash> \
  --expected-revision 5 --persist-to /local/state/v3
```

Withdrawal advances the content policy revision so in-flight guards fail, disables generation if this is the active edition, and applies existing historical availability rules. Accepted encrypted reading snapshots are never rewritten. A withdrawn hash cannot be reactivated. A lost acknowledgment requires checking the current revision and stored state before another operation.

## Usage and reconciliation

The price basis is part of the provider policy hash. Cache reads and 30-minute cache writes are disjoint subsets of total input. Their total rates per million tokens are $0.05 and $1.25; other input costs $1 and output costs $5. Reasoning is already included in output. `priceReceipt` computes integer rational amounts and rounds the total upward once to a microUSD. The 1,000-input/200-read/300-write/100-output vector costs 1,385 microUSD. The conservative 40,000 microUSD reservation remains independent of product quota.

Every dispatch freezes the application policy, provider policy, requested model, price hash and original UTC day/month buckets. Valid known usage settles once regardless of refusal or invalid reading text. Unverifiable usage keeps the entire reservation as unknown. Real liability above reservation or bucket ceiling is recorded in full and disables new generation; health telemetry raises `PROVIDER_COST_OVERRUN`. Conflicting settled receipts stop generation and require operator review. Neither a product quota release nor account erasure refunds provider liability.

For a late verified bill, prepare a protected JSON import with exactly these fields:

```json
{
  "version": "provider-cost-import.v1",
  "reviewerId": "operator-id",
  "reviewedAt": "<UTC ISO timestamp>",
  "policyHash": "<exact reserved provider policy hash>",
  "evidenceHash": "<SHA-256 of the protected provider bill bytes>",
  "receipts": [{
    "dispatchId": "<existing dispatch UUID>",
    "receiptId": "<stable bill line identity>",
    "receipt": {
      "responseId": null,
      "returnedModel": "gpt-6.1-terra",
      "serviceTier": "default",
      "durationMs": 0,
      "usage": {
        "inputTokens": 1000,
        "cachedInputTokens": 200,
        "cacheWriteTokens": 300,
        "outputTokens": 100,
        "reasoningTokens": 0
      }
    }
  }]
}
```

These are format placeholders, not approval or a bill. Do not replace an unknown category with zero or infer a tier from absent evidence. Use `receipt:null` when usage is unknown. The local operator is responsible for genuine provider provenance and review; a file hash proves byte identity. No prompt or response body belongs in an import. Private response IDs may be supplied in protected input for receipt identity; they are hashed in the cost ledger and never printed. Existing encrypted dispatch response IDs retain normal terminal and erasure cleanup.

```sh
npm run provider:reconcile -- --check --input /protected/import.json --evidence /protected/bill
npm run provider:reconcile -- --apply --input /protected/import.json --evidence /protected/bill --persist-to /local/state/v3
```

Check-only opens no database. Apply is idempotent per settled receipt and commits each receipt in its own atomic batch, so a partially completed import can be rerun after checking any conflict. Reconciliation adjusts the original UTC buckets, never current ones. A detached dispatch digest permits matching late bills after erasure without restoring owner/dispatch links or personal records. Historical costs without a pinned price/policy identity remain untouched and require separate review. No estimates are silently relabeled as actual usage.

Migration `0011_provider_costs.sql` rebuilds the spend/cost/adjustment graph in one batch, preserving original financial fields, foreign keys, indexes and storage counters. Historical migrations remain unchanged. Nullable new metadata distinguishes legacy/unknown values from zero; the rebuild removes the spend upper-bound CHECK so real bills can exceed admission ceilings while dispatch admission continues enforcing those ceilings.

## Spread photo recognition

Apply migration `0016_spread_dispatch.sql` before running this version. In live modes, photo requests require `MODEL_API_KEY` for Meta; a missing key returns `PROVIDER_UNAVAILABLE`. Deterministic recognition is limited to `synthetic-local`. Requests without photos continue using the existing writer configuration.

Photo recognition runs after durable request admission and quota reservation. Immediately before transmission it checks the current account, permission, content, lease, generation switch, dispatch mode, concurrency and spend limits. The same transaction records `spread_dispatch_id` and the recognition cost reservation. Retries join that request. Recovery can continue from a persisted recognized basis, but an authorized transmission without a durable result ends as `PROVIDER_UNCERTAIN` and never resends the photo for that intent. Cancellation or permission revocation prevents using the result; it cannot undo an already transmitted request.

`SPREAD_PROVIDER_POLICY` pins `muse-spark-1.3` Standard pricing reviewed on 2026-10-31: $1.25 per million uncached input tokens, $0.15 cached input and $4.25 output. Since compressed image bytes do not bound decoded image tokens, each recognition reserves 1,328,128 microUSD ($1.328128), covering the full 1,048,576-token context plus the 4,096-token output cap. Valid usage settles that reservation to actual cost, including refused or unusable responses. Missing or unverifiable usage retains the full reservation as unknown, independently of reading quota. See Meta's [pricing](https://dev.meta.ai/docs/pricing-rate-limits), [model limits](https://dev.meta.ai/docs/models) and [image token guidance](https://dev.meta.ai/docs/image-understanding).

Recognition settlement uses the frozen policy and price identity, adjusts the original spend periods once, and stops generation on conflicting receipts or overruns. Erasure detaches the cost record while preserving the dispatch digest for late settlement. The existing `provider:reconcile` CLI accepts writer policies only; unknown Meta liabilities remain reserved pending separate operator review.

The current permission and upload notices identify Meta as the photo recipient and explain service storage and possible provider retention. These UI notices are separate from immutable historical reading content and evaluation manifests. Neither `store:false` nor this application promises zero provider retention; Meta's [zero-data-retention policy](https://dev.meta.ai/help/policies-and-privacy/zero-data-retention) describes the separate account configuration and exceptions.
