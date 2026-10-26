# Milestone 2 acceptance and delivery

Milestone 2 remains open. Deployment and live provider traffic remain disabled. Local test results do not close hosted, provider, content approval or manual acceptance gates.

## Carried baseline

Milestone 1 is complete. Identity/recovery, the complete downloadable handle-and-codes kit, and the saved-reading return journey are verified locally. Save needs no reflection; sign-in/history/recovery reopen identical accepted content without another generation/quota charge. Consent-off history, reopening, reflection edits, export and deletion remain regression requirements. Privacy deletion and stale-bookmark replay are recorded in `PRIVACY_RESTORE_RESULTS.md`.

The current local retention/accounting/cleanup slice is complete locally after independent review, correction of both material findings, and a 13-stage/260-test verification run. The disclosed minor request-cursor issue is addressed by the subsequent request-lifecycle integration. Its evidence is recorded in `RETENTION_CLEANUP_RESULTS.md`; it does not close all Milestone 2 gates.

## Current application inventory

Updated from application baseline `7c1d981` and the merged specification at `278d5fd` on 2026-10-26. The application checkout is available in this VM. [Request lifecycle evidence](REQUEST_LIFECYCLE_RESULTS.md) records the new integration; the ignored `artifacts/verify.json` and release check bind the latest full gate to the current source.

There are three distinct execution boundaries:

- `SyntheticGenerationPrototype` is an internal database/publication test harness.
- `LocalGeneration` is wired into the actual application: `Start reading` calls `POST /api/v1/requests`, which creates a three-card accepted artifact using `InterceptedWritingProvider`. `npm run dev:identity` enables this loopback-only flow with `READING_MODE=synthetic-local`; the browser tests use it. No external AI request occurs.
- The default Worker configuration leaves private routes disabled. Real-provider generation and deployment remain unavailable. Offline restore/cleanup also disables generation in its database; the simulation does not override that fence.

Thus “generation is internal/disabled” is accurate for the prototype and real-provider boundary, but incomplete as a description of the existing local application. A usable local simulated Start flow already exists.

| MVP experience | Current implementation and evidence | Acceptance still open |
|---|---|---|
| Create a reading | The UI question form, English/reversals controls and Start disclosure call the authenticated application route. The [browser helper](../tests/fixtures/browser-reading.ts) clicks the real controls and waits for the accepted reading; the [integrated journey](../tests/browser/readings.spec.ts) exercises it. | Real-provider operation and hosted durable execution remain open. Local Start now acknowledges durable admission, continues with Worker waitUntil, supports owned status/intent lookup and revision-checked cancellation, and shows distinct outcomes. Intercepted service tests exercise non-success outcomes; the default local writer remains synthetic. |
| Inspect interpretation, cards and sources | [Reading detail](../src/client/readings.tsx) renders position headings, basis text, interpretation and reflection questions, plus expandable card IDs/orientations and source text/attribution/ID/version. [Reading contract tests](../tests/db/readings.test.ts) preserve exact returned content. | Draw, interpretation and reflection-prompt headings now separate each unit. Browser acceptance opens the source panel by keyboard and checks all three card positions/orientations plus exact source text/attribution. Completion focus and 320px reflow are checked. Manual screen-reader, zoom and device acceptance remain open. |
| Save now, reflect later | The [integrated browser journey](../tests/browser/readings.spec.ts) saves with no reflection, verifies no reflection record was created, then adds and edits a reflection later. Further tests preserve an unsaved draft and verify conflict reconciliation. [D1 record-action tests](../tests/db/reading-record-actions.test.ts) verify immutable accepted text and authored revisions. | Broader browser/manual accessibility acceptance. This feature is already implemented and locally verified. |
| Dated history and exact reopening | The same browser journey saves, signs out/in, selects the dated history entry and compares exact accepted JSON/text. It counts exactly one Start request and verifies unchanged allowance after reopening/recovery. | Broader browser/device acceptance. The full local history-and-return journey is established, beyond merely having a reopen endpoint. |
| Recovery into existing saved content | The journey removes the old virtual authenticator, clears origin storage, closes the old page and recovers in a fresh mobile-sized context using the downloaded handle and unused code. Replacement passkey enrollment returns to the same account and reading. | Physical/synchronized authenticators and production domain/RP-ID qualification. |
| Separate AI/storage permission and consent-off use | Start and Save have distinct retention disclosures; AI permission is separate. Browser evidence turns AI off, keeps history/reopening and reflection add/edit available, and exports/deletes the same reading. [Admission tests](../tests/db/readings.test.ts) reject Start before private persistence without consent or kit acknowledgement. | Final approved privacy copy and production handling; broad accessibility acceptance. The application flows are locally verified. |
| Export and deletion controls | The [saved-reading browser journey](../tests/browser/readings.spec.ts) downloads and checks actual exported reading/reflection records and deletes the reading with AI off. [Privacy browser tests](../tests/browser/privacy.spec.ts) cover exact-revision deletion, account deletion and a lost account-deletion response with a usable receipt. | Hosted erasure/backup/retention assurances and manual accessibility. These are implemented UI flows, not backend-only claims. |
| Interruptions and conflicts | Browser tests cover stale reflection reconciliation, dirty-draft stay/discard, delayed responses after sign-out, lost deletion responses and deletion revision conflicts. [D1 interleaving tests](../tests/db/reading-interleavings.test.ts) cover consent/authentication/retention/export races. | Request progress, cancellation protocol, reload/sign-in resume, lost Start/Save reconciliation, explicit same-intent retry and cursor consistency now have local evidence. Real D1 barriers verify cancellation/revocation races; content-free browser status fixtures verify non-success UI handling. Hosted interruption recovery and complete manual/browser acceptance remain open. |

The client now has a separate request progress screen. Start returns after durable admission; the local Worker continues asynchronously. Read-only intent lookup recovers a lost acknowledgement, and cancellation fences late publication and releases held quota atomically. There is still no qualified hosted durable driver or production transport. A lost Worker continuation expires through local scheduled maintenance rather than redispatching. These local proofs do not close hosted/provider gates. See [the client flow](../src/client/readings.tsx), [application routes](../src/worker/readings/routes.ts), [local generator](../src/worker/readings/generation.ts), and [saved-reading evidence](SAVED_READING_RESULTS.md).

## Remaining acceptance

| Gate | Required evidence / next work |
|---|---|
| Request status | Local cursor/retention consistency, after-cursor pagination and cancellation are verified. Hosted continuation/crash recovery and manual progress announcements remain open. |
| Identity completion | Passkey listing/removal and last-factor protection, logout-all, failure-only recovery throttling, and browser acceptance of those controls. Qualify stable production domain/RP ID and physical/synchronized passkeys separately. |
| Generation and provider | Complete durable generation/recovery behavior and intercepted egress checks; bounded real-provider qualification only under explicit separate authorization, with verified privacy/access/pricing and no hidden retry. Preserve consent-off operation. |
| Content and user experience | Human-reviewed English default/non-reading outcomes, cleared launch canon and rights, manual acceptance of the implemented semantic reading/source separation and interruption/conflict/offline states. Existing source rendering is inventoried above; synthetic approval fixtures do not count as launch approval. |
| Production privacy and operations | Production keys/rotation, retained-key receipt serving, independent backup inventory and loss assurance, durable crash recovery, monitored security/erasure jobs and spend, incident/deletion-lag/key-recovery runbooks. Local purge alone does not establish hosted retention. |
| Hosted acceptance | Main failing-test proof, preview isolation, D1 batch/race and Cron evidence, actual synthetic hosted restore/RPO with erased data, used code, removed credential and pre-dispatch bookmark. Keep deployment disabled until separately authorized and qualified. |
| Browser/manual acceptance | Keyboard, screen reader, mobile and physical-authenticator checks; browsers beyond the recorded local Chromium virtual-authenticator journeys. |
| Owner decisions | Geography/age policy, budget acceptance, launch canon approval and operational acceptance. No default inferred approval. |

## Next local integration

The request lifecycle and inspection integration closes the next local product slice, subject to the independent review and source-bound evidence in [its result record](REQUEST_LIFECYCLE_RESULTS.md). Preserve its request identity, cancellation, quota and exact-content tests alongside the existing recovery/privacy baseline.

The next local implementation target is identity account controls: passkey listing/removal and last-factor protection, logout-all, and failure-only recovery throttling, followed by integrated browser acceptance. Production domain/RP-ID, physical/synchronized authenticators, provider/content qualification, hosted operations and manual assistive-technology acceptance remain distinct gates requiring their own evidence. Keep deployment and live-provider traffic disabled.

Full Milestone 2 cannot be marked complete from the synthetic gate alone.

## Later scope

Milestone 3 retains follow-ups tied to an exact saved parent, selected-context preview/grant/revocation, separate dated revisit notes and supported legacy imports/export-import round trips. Ordinary saved history, reopening and initial reflection editing remain Milestone 2 and already have local evidence.

Astrology, coaching/check-ins, narration, recognition, Time Travel as a product feature, astrocartography, portraits, MCP and billing remain conditional later work. Product Time Travel is distinct from the database restore/privacy qualification required for launch. No later-feature scaffolding is needed to close this local MVP journey.

## Requested deliverable

The user requested a ZIP of `reflection-app` **after Milestone 2 is complete** (2026-10-26). Keep this request pending until the applicable acceptance gates have recorded evidence and the milestone is actually closed. Then produce a reproducible ZIP of the verified application source, lockfile, migrations, tests, documentation and verification records, with a checksum and download link. Exclude Git internals, dependencies, caches, temporary/local databases, credentials and local secrets. Do not label an interim local snapshot as the completed Milestone 2 package.

## Workspace roles

`/home/ext_allthesecrushes_gmail_com/reflection-architecture` is the specification/design-check checkout. `/home/ext_allthesecrushes_gmail_com/reflection-app` is the runnable application and milestone implementation checkout. Both currently point to the same GitHub repository; application work is on local `codex/` branches. The architecture checkout's existing uncommitted work is separate and is not modified by this application slice.
