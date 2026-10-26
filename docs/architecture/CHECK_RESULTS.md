# Executed artifact checks and consistency review

Checked locally on 2026-10-26 using synthetic inputs. These results concern the proposed specification artifacts. No application handlers, production deployment gate, provider quality, real migration, browser journey or hosted infrastructure have been implemented or verified by this work.

## Environment and reproducible commands

Run from the `successor-spec` directory. Exact JavaScript dependencies are pinned in `package-lock.json`. Observed environment: Node v26.12.1, npm 11.20.0, Python 3.14.4, Python SQLite 3.46.1; TypeScript 5.9.3, Zod 4.6.7, tsx 4.21.0, YAML 2.8.2 and Swagger Parser 12.1.0. These are artifact-check versions, not a qualified production Worker compatibility matrix.

```sh
npm ci
npm run schemas
npm run check:contracts
npm run check:sql
npm run check:openapi
python3 checks/check-package.py
```

Dependencies were installed with npm during authoring. The listed `npm ci` is the clean reproduction step, not an assertion that every possible clean machine was tested. Schema generation precedes the independent checks. `make-registry.py` and `make-corpus.py` are authoring helpers, deliberately outside verification: regenerating a registry cannot substitute for reviewing a new column's policy.

| Executed command / actual inputs | Actual result | What it does not establish |
|---|---|---|
| `npm run schemas`: actual Zod definitions and operation metadata | Generated OpenAPI 3.1 with 37 operations and 41 named API schemas, plus model-output JSON Schema. | Provider acceptance of a live request, operation implementation or authorization behavior. |
| `npm run check:contracts`: strict TypeScript and representative payloads | Type-check passed. Valid tarot/start/model fixtures, an unavailable reading and later astrology input parsed. Unknown model field, unsupported language and wrong basis discriminator were rejected. Every named API schema exported to JSON Schema. | A complete domain/semantic validator, browser compatibility or calculation correctness. |
| Same contract command: `EVAL_CORPUS.json` | 60 unique case IDs with rationale/assertion metadata checked; shared baseline basis/candidate/start fixtures parsed. | The 60 expected outcomes were **not** executed against an implemented validator. No prose was promoted to human-approved status. |
| Same command: disposable Web Crypto experiment | AES-256-GCM round trip succeeded with matching AAD; decryption with different owner-context AAD rejected; versioned envelope parsed. | The proposed encryption service, key rotation, entropy deployment, restore or entire field registry implementation. |
| `npm run check:sql`: actual `schema.sql` and `publication_guard.sql` in in-memory SQLite | 36 tables, 307 columns; all 19 named assertions below passed. Fixed column registry exactly covered the schema. | Cloudflare D1 binding semantics, concurrent Worker execution, scheduled recovery or hosted rollback behavior. |
| `npm run check:openapi`: actual generated YAML | Syntax, schema and references validated; all 37 operation IDs unique. | Correct HTTP handlers, cookie enforcement or end-to-end compatibility. |
| `python3 checks/check-package.py`: supplied package | Required files and local Markdown links resolve; JSON artifacts parse; model projection uses closed objects with every property required. | Remote link permanence, legal clearance or model-quality guarantees. |

An early TypeScript check caught an explicitly undefined optional operation property under `exactOptionalPropertyTypes`; it was corrected before the passing run. An initial npm command was invoked from the parent directory and failed because no package.json existed there; subsequent commands used `successor-spec`. Node emitted the non-failing tsx `DEP0205` deprecation warning for `module.register()`. No failed or blocked application check has been relabeled a pass.

## SQL checks actually exercised

1. Valid current publication guard succeeds.
2. Revoked model permission rejects publication.
3. Cancelled request rejects publication.
4. Stale run epoch rejects publication.
5. Expired lease rejects publication.
6. Changed encryption key version rejects publication.
7. Account deletion fence rejects publication.
8. Current content withdrawal rejects publication.
9. Missing selected-context snapshot rejects publication.
10. Approved content with null reviewed hash fails its CHECK.
11. Cross-owner basis reference fails its composite foreign key.
12. Duplicate owner/intent fails uniqueness.
13. A failed assertion after an edition insert rolls back the preceding insert in the harness's SQLite transaction.
14. Withdrawal of an older parent edition's content rejects a request using newer content.
15. Deleting an account with populated parent-edition relationships satisfies the actual cascade constraints.
16. Withdrawal of selected older-edition content rejects publication.
17. Deleting an account with populated selected-edition relationships satisfies the actual cascade constraints.
18. Quota held plus consumed exceeding allowance fails its CHECK.
19. Table and column sets exactly match the fixed lifecycle registry.

These are selected probes, not exhaustive tests of every enum, statement, race or retention process. The future workerd/hosted tests must use the same SQL and verify D1 `batch()` failure and rollback directly.

## Independent review and resolution

Three bounded native reviews examined the draft: data/concurrency, privacy/operations, and product/contracts. The author integrated the material findings below and checked the resulting artifacts. This is not a claim that those reviewers re-reviewed or formally approved the final package.

| Finding | Resolution in the delivered specification |
|---|---|
| Mutable row revisions would break ciphertext AAD; DEK rotation would change duplicate hashes. | Immutable `Ciphertext.aadRevision`; separately wrapped stable account index key; exact encrypted-field bindings in registry. |
| Restore could replay work or revive revoked credentials/used recovery codes. | Independent encrypted identity checkpoints, serialized security saga, restore invalidation of sessions/permissions/grants and all nonterminal work; financial admission frozen until reconciliation. |
| A deletion accepted before its independent intent could disappear on restore; request-time backup expiry was unsafe. | HTTP 202 only after durable R2 intent; client-generated receipt capability handles lost responses; backup deadline begins at completed active erasure and is null while pending. |
| Parent/selected content could be withdrawn under a newer request edition; a missing context row could pass a vacuous check. | Guard joins cover older source content; captured count must match actual selected snapshots. Negative SQL probes exercise both. |
| Nullable approval checks could admit unreviewed content. | Explicit non-null reviewer/hash conditions, with a rejecting SQL probe. |
| Import aliases did not identify exact entities or retain sufficient original data. | Typed owned entity/revision links and encrypted original source records; erased aliases prevent silent re-import resurrection. |
| Unsave lacked a retention deadline; unavailable/history/export shapes were incomplete. | Explicit unsave expiry; nullable history edition with request status; unavailable reading tombstones; paginated permissions, grants and metadata export. |
| Hash-only CSRF/recovery storage could not recreate a promised response. | Derivable session-bound CSRF; recovery handle returned only on provisioning/rotation and nullable otherwise. |
| UI promised unsupported server-saved notes and lacked source/grant retrieval. | Unsupported-input drafts remain RAM-only with explicit copy/download; accepted readings carry exact source snapshots; paginated grant GET added. |
| Cost reconciliation could be applied twice. | Unique adjustment identities and atomic state/bucket CAS; actual liabilities retained even above admission caps. |
| Simplified auth API descriptions still omitted the new checkpoint ordering. | Registration, recovery, acknowledgement, credential removal and code rotation now describe the same durable saga as SECURITY_RESTORE. |

## Six cross-layer traces reviewed

The following traces are consistency walkthroughs of the specification, **not executed journeys**. API paths below have `/api/v1` prefix. Component and test IDs resolve through ARCHITECTURE and VERIFICATION_PLAN.

| Scenario | UI → API → services/state → storage → egress → observable result |
|---|---|
| First session | `/new` previews question and permission → POST `/requests` → GenerationService authenticates, admits and reserves; driver prepares, dispatches, validates and publishes → owned session/basis/request, quota and spend reservations, unique dispatch, guarded edition/event commit → one permitted payload with exact facts/canon/question → polling exposes only progress and an accepted edition; basis/source panel is inspectable. POST session reflection atomically saves authored revision and session; reopen reads the same edition without inference. A01–A09. |
| Follow-up | Exact parent and selected excerpts in ContextSelector → grants/list/preview then POST `/requests` with parent ID and new intent → same session/basis, current source/grant revisions and bounded PreparedPlan → new request/context snapshots and later edition with immutable parent link → only explicitly previewed fragments plus current question/basis/canon → original text remains available, new result is distinct and user reflection remains separately authored. A06/A11. |
| Duplicate start | Double-click or lost response keeps intent/key → repeated POST or GET `/requests?intentId=…` → compare owned canonical payload HMAC → unique owner/intent and rollback of losing reservation batch → unique dispatch prevents a second deliberate call → both callers resolve the same request/edition; changed payload conflicts. A07/A14. |
| Revoked-context race | User revokes grant in settings while writing runs → DELETE grant with current revision → PermissionService revokes/fences dependent work → current publication assertion fails and quota release occurs once → authorization before revocation may already have transmitted text; no recall promise → no accepted result from the revoked context, and UI asks for a new explicit selection. A06/A07. |
| Account deletion | Recent authentication and explicit delete with receipt capability → DELETE `/account` → account/auth/work fence, durable independent intent, active-store erasure, completion → registry families, copies and keys erased; detached cost links scrubbed; R2 intent survives DB restore → no new inference; previous transmission retention remains disclosed → 202 only after durable intent, receipt reports pending/complete and backup deadline; lost response remains resolvable without a session. A08/A14. |
| Import with incomplete provenance | ImportPreview shows known text and gaps → POST `/imports`, then selected commit → bounded version adapter preserves original JSON/IDs/time/roles and validates parent graph → atomic per-session group, typed owned aliases, `legacy.imported.v1`, no new context grant → no provider call → unverified historical text and explicit unknowns reopen/export unchanged; unresolved parent group fails visibly; re-import is idempotent. A12. |

## Outstanding qualification, not missing specification

Implementation starts with milestone 1's local contracts, deterministic composition, actual D1 harness, intercepted provider and release-gate implementation. Real-user rollout still requires qualified passkey/runtime behavior; approved launch content and rights; authorized live-provider quality/latency/retention checks; browser/accessibility and fault/egress tests; actual main-branch failed-test/preview isolation proof; and full synthetic erasure/security/spend restore. Geography/age policy, domain/resource identifiers and accepted financial limits remain explicit owner/environment inputs. Legacy user/subscription inventory blocks retirement decisions, not writing the successor.

No paid inference, hosted resource mutation, real private record access, predecessor implementation change, remote repository creation, subscription action or shutdown was performed. Predecessor code/tests/reports were inspected at recorded revisions; their test suites were not run. Optional inaccessible sessions and the missing synthesis document are identified in ARCHITECTURE. Current vendor documentation establishes only the narrow documented facts cited there.
