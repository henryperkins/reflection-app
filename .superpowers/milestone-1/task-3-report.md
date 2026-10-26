# Task 3 report: actual D1 synthetic lifecycle prototype

Implemented `src/worker/db/{statements,prototype}.ts`, `tests/fixtures/database.ts`, and `tests/db/prototype.test.ts`. The migration, publication guard, and column registry were not edited.

## Interfaces

`SyntheticGenerationPrototype(db, writer, barriers?)` accepts an actual D1 binding and the shared `WritingProvider` interface. Its internal methods are:

- `start(SyntheticPlan): Promise<string>` creates or joins an owner-scoped request, binds additional idempotency keys to joined intents, and reserves daily/monthly product quota atomically. Enforces at most two active requests per owner, a three-minute deadline, and seven-day idempotency retention. Requires an explicitly synthetic, already-prepared session/basis and plan metadata. It enters `prepared` directly; domain preparation is a separate M1 component.
- `claim(ownerId, requestId): Promise<SyntheticLease | null>` uses database time and CAS to claim a 30-second lease with a monotonic epoch and an attempt row. Up to three local epochs; an expired pre-dispatch claim can be reclaimed.
- `dispatch(lease, projectedPayload): Promise<WriterOutcome | null>` authorizes a unique dispatch, reserves provider cost, verifies the imported eligibility guard and exact ordered fragment commitments, and calls the configured writer at most once. Requires at least 21 seconds of request and lease budget. A duplicate or uncertain authorization acknowledgement never starts another external call. Spend ceilings are $10/day and $100/month. Known usage settles actual cost independently of product quota, including an increase for usage above the reserved maximum (full actual liability is recorded, committed buckets saturate at their schema ceiling, and generation is disabled on an overrun); uncertain outcomes retain the maximum cost and terminalize without a fallback.
- `publish(lease): Promise<string>` atomically inserts the unique synthetic edition, consumes product quota, invokes the unchanged imported publication guard immediately before the final deadline-filtered update, asserts its row count, records the event, and advances accounting. Concurrent/lost-acknowledgement retries resolve the same committed edition by owner/request identity.
- `terminalize(ownerId, requestId, state): Promise<void>` fences pending work, releases product quota once, clears pending synthetic material, and prevents late receipts from restoring it. It retains provider cost. Terminalization is an explicitly invoked internal operation.

`PrototypeBarriers` exposes `beforeDispatch`, `beforeReceipt`, and `beforePublication` asynchronous boundaries. The test fixture helpers seed two distinct owners with explicit synthetic account keys, permission revisions, reviewed content, a session, basis, and optional grant. `clearDatabase` cleans between tests in one FK-deferred D1 transaction because plugin v1 does not provide the old per-test storage rollback behavior.

## Evidence

Tests import the authoritative migration through `applyD1Migrations` and execute against workerd/D1 through `@cloudflare/vitest-plugin` (not an in-memory SQL mock). Production statement construction imports the checked-in `publication_guard.sql?raw`; the publication predicate is used verbatim. Only start/dispatch permitted stages are adapted as specified in GENERATION, and dispatch additionally checks model mode.

`npm run test:db`: **38 passing tests** (36 prototype, 2 existing scaffold). Covered behavior includes:

- Eight concurrent duplicate starts, changed payload conflicts, permanent binding of alias idempotency keys, daily quota exhaustion, cross-owner session and snapshot rejection.
- CAS claims, reclaiming an expired lease, stale-driver dispatch rejection, unique dispatch, concurrent and lost-delivery publication retries, provider receiving only supplied projected payload bytes.
- Actual batch rollback for stale epochs/tokens, expired lease, request deadline equality/expiry, permission revocation, key rotation, content/source/grant withdrawal, missing snapshots, erased basis, changed fragment commitments, frozen accounts.
- Parent withdrawal, parent content withdrawal and selected native source content withdrawal while the current request uses newer approved content.
- An injected failure after publication/accounting statements, delayed publication across the database deadline, dispatch mode off, insufficient dispatch budget, revocation between authorization and receipt.
- Known usage accounting, conservative unknown cost, no second call after uncertainty, repeated terminalization, cancellation before a late receipt, no accepted edition or residual held quota after terminalization.

`npm run typecheck`: passed. All commands used the installed Node 26.12.1 toolchain. Initial missing-module failure was observed before implementation; additional regression tests were observed failing for simultaneous publication, alias idempotency, cost settlement, insufficient dispatch budget, cancelled dispatch state, policy constants, per-account active-request admission, and cost overreservation, then passed after fixes.

The general `npm test` was also run as required by the TDD skill. At that time it failed to load the two D1 suites in the plain Node runner (`cloudflare:workers` unavailable), and `tests/tooling/gates.test.ts` failed for generated `docs/architecture/DOMAIN_CONTRACTS.ts` drift. These root-owned integration/configuration issues were reported to the coordinating agent; the D1 suite and typecheck pass independently. A later `npm test` rerun used the corrected split Node/workerd script and failed only the existing DOMAIN_CONTRACTS drift tooling test (74 passed); the Node/workerd routing problem is fixed. Biome format reported a shared-config deprecation for `recommended`; owned files were formatted without modifying configuration.

## Explicit limitations

This is **not** the production `GenerationService`. It has no private HTTP routes, authentication/CSRF/identity integration, encryption, scheduler, real provider adapter, or live inference. It requires preseeded synthetic session/basis rows. All `_enc` material is visibly marked `SYNTHETIC_ONLY_NOT_ENCRYPTED`; the plan placeholder contains synthetic identifiers and fixture metadata, not private question/context bodies. Plan/payload/prompt/validator commitments are injected fixture values, not cryptographic attestations. Only the edition placeholder byte delta is represented in `storage_bytes`; full encrypted-object storage accounting belongs with the M2 encryption adapter.

It publishes a synthetic placeholder after a candidate outcome; it does not implement domain validation or store/decrypt the candidate. Domain validation and complete-artifact binding must be integrated before this can be promoted beyond synthetic tests. The injected writer owns its transport behavior and must honor the supplied abort signal/timeout contract; no external network calls were made here. Non-candidate outcomes conservatively terminalize instead of implementing the production template recovery branch. Dispatch crash recovery, timer scheduling, uncertain-operation reconciliation, admission backlog limits, retention/deletion jobs, and full end-to-end provider delivery remain M2. At-most-one deliberate call is an application property, not a guarantee about a provider's execution count.
