# Milestone 2 acceptance and delivery

Milestone 2 remains open. Deployment and live provider traffic remain disabled. Local test results do not close hosted, provider, content approval or manual acceptance gates.

## Carried baseline

Milestone 1 is complete. Identity/recovery, the complete downloadable handle-and-codes kit, and the saved-reading return journey are verified locally. Save needs no reflection; sign-in/history/recovery reopen identical accepted content without another generation/quota charge. Consent-off history, reopening, reflection edits, export and deletion remain regression requirements. Privacy deletion and stale-bookmark replay are recorded in `PRIVACY_RESTORE_RESULTS.md`.

The current local retention/accounting/cleanup slice is complete locally after independent review, correction of both material findings, and a 13-stage/260-test verification run. One disclosed minor request-cursor issue remains deferred. Its evidence is recorded in `RETENTION_CLEANUP_RESULTS.md`; it does not close all Milestone 2 gates.

## Remaining acceptance

| Gate | Required evidence / next work |
|---|---|
| Request status | Fix the disclosed minor event-retention race that can regress `nextSequence`; saved-reading history/reopening is unaffected. |
| Identity completion | Passkey listing/removal and last-factor protection, logout-all, failure-only recovery throttling, and browser acceptance of those controls. Qualify stable production domain/RP ID and physical/synchronized passkeys separately. |
| Generation and provider | Complete durable generation/recovery behavior and intercepted egress checks; bounded real-provider qualification only under explicit separate authorization, with verified privacy/access/pricing and no hidden retry. Preserve consent-off operation. |
| Content and user experience | Human-reviewed English default/non-reading outcomes, cleared launch canon and rights, precise reading/source UI, accessible interruption/conflict/offline states. Synthetic approval fixtures do not count as launch approval. |
| Production privacy and operations | Production keys/rotation, retained-key receipt serving, independent backup inventory and loss assurance, durable crash recovery, monitored security/erasure jobs and spend, incident/deletion-lag/key-recovery runbooks. Local purge alone does not establish hosted retention. |
| Hosted acceptance | Main failing-test proof, preview isolation, D1 batch/race and Cron evidence, actual synthetic hosted restore/RPO with erased data, used code, removed credential and pre-dispatch bookmark. Keep deployment disabled until separately authorized and qualified. |
| Browser/manual acceptance | Keyboard, screen reader, mobile and physical-authenticator checks; browsers beyond the recorded local Chromium virtual-authenticator journeys. |
| Owner decisions | Geography/age policy, budget acceptance, launch canon approval and operational acceptance. No default inferred approval. |

Next local implementation target after this slice: identity account controls and failure-only recovery throttling, preserving saved-reading and recovery regressions. Full Milestone 2 cannot be marked complete from the current synthetic gate alone.

## Requested deliverable

The user requested a ZIP of `reflection-app` **after Milestone 2 is complete** (2026-10-26). Keep this request pending until the applicable acceptance gates have recorded evidence and the milestone is actually closed. Then produce a reproducible ZIP of the verified application source, lockfile, migrations, tests, documentation and verification records, with a checksum and download link. Exclude Git internals, dependencies, caches, temporary/local databases, credentials and local secrets. Do not label an interim local snapshot as the completed Milestone 2 package.

## Workspace roles

`/home/ext_allthesecrushes_gmail_com/reflection-architecture` is the specification/design-check checkout. `/home/ext_allthesecrushes_gmail_com/reflection-app` is the runnable application and milestone implementation checkout. Both currently point to the same GitHub repository; application work is on local `codex/` branches. The architecture checkout's existing uncommitted work is separate and is not modified by this application slice.
