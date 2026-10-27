# Reflection development app

The development app supports live OpenAI readings, local identity/recovery and saved-reading return workflows. Save without a reflection, sign back in to dated history, recover in a fresh browser, and reopen identical content. History, reflection editing, export and session deletion work with AI permission off.

## Hosted development preview

**https://reflection-preview.lfd.workers.dev**

Create an account, keep the recovery kit, and enable AI readings. The preview uses
GPT-6.1 Terra with fast service and xhigh reasoning. Its accounts and saved readings
use a separate Cloudflare D1 database and recovery bucket from the local app.

The deployment is configured in `wrangler.preview.jsonc`. With Wrangler authenticated
to the configured account, redeploy using `npm run deploy:preview`. Server secrets
are already installed and retained across deployments. The minute-by-minute maintenance
schedule handles unfinished work and retention. Start keeps its HTTP request open
while generating so longer readings can finish within the provider deadline.

## Live development app

```sh
npm run dev:live
```

Open **http://localhost:8787**, create an account, keep the recovery kit and enable AI
readings. Start reading calls GPT-6.1 Terra with fast service and xhigh reasoning, using
the current v2 editorial prompt and draft card meanings. No production qualification
receipt or content-approval ceremony is required for this development mode.

The command reads `OPENAI_API_KEY` and `OPENAI_PROJECT_ID` from the process environment,
the checkout's `.env.local`/`.env`, or the main checkout's `.env` when running in a
worktree. An explicit path is also supported:

```sh
npm run dev:live -- --env-file /absolute/path/to/.env
```

Credentials stay on the server and are not copied into the frontend or persisted app
settings. Live app data and its generated encryption keys persist under
`.wrangler/live-development`; keep that directory to retain access to saved readings.
The synthetic app uses separate storage. Stop the server with Ctrl+C.

The existing limits remain: three readings per day and thirty per month per account,
up to $0.16 reserved for an attempt, and $10/day/$100/month technical spend ceilings.
A recovery or reload does not resend an authorized provider call. Draft sources retain
their existing review metadata. This command starts the local app; it does not deploy
a public service. The synthetic commands and offline verification below remain available.

The [live app check](docs/superpowers/evidence/2026-10-27-live-app-activation.md) records
the actual Start, save and reopen result and the activation fixes.

The [local delivery guide](docs/LOCAL_DELIVERY.md) explains the runnable ZIP and its verification records. The [completion pass](docs/COMPLETION_PASS_RESULTS.md) adds passkey management, logout-all, durable generation recovery, actual candidate composition, retained-key rotation/receipts, operator telemetry and reproducible packaging. Production launch decisions are deferred for this delivery at the owner's instruction.

The [live-reading plan](docs/superpowers/plans/2026-10-27-live-ai-readings.md) records the implemented GPT-6.1 Terra development path and completed four-case live check. The [production key lifecycle](docs/superpowers/plans/2026-10-27-production-key-lifecycle.md) and [production qualification](docs/superpowers/plans/2026-10-27-production-qualification.md) plans retain the remaining production work; no production gate is marked complete.

Implementation evidence: [Milestone 1 baseline](docs/MILESTONE_1_RESULTS.md) and [local identity/recovery results](docs/IDENTITY_RECOVERY_RESULTS.md), plus [saved-reading return results](docs/SAVED_READING_RESULTS.md). The architecture baseline remains [`278d5fd`](https://github.com/henryperkins/reflection-architecture/commit/278d5fdb1636225887220368fbef52dc0d7ab889).

The [local privacy and restore slice](docs/PRIVACY_RESTORE_RESULTS.md) adds account/exact-reflection-revision deletion and synthetic offline replay of erasures and identity checkpoints. See the [local restore runbook](docs/LOCAL_RESTORE_RUNBOOK.md); hosted restore remains unqualified.

The [local retention and cleanup slice](docs/RETENTION_CLEANUP_RESULTS.md) adds transactional storage accounting, bounded expiry and offline recovery-record purge with a verified new backup boundary. See the [cleanup runbook](docs/LOCAL_CLEANUP_RUNBOOK.md) and [remaining Milestone 2 acceptance](docs/MILESTONE_2_ACCEPTANCE.md).

The [local request lifecycle](docs/REQUEST_LIFECYCLE_RESULTS.md) adds early Start acknowledgement, resumable progress, cancellation and distinct stopped outcomes. Reload or sign in at the same request URL to recover the result without starting again. Reading headings separate drawn cards, interpretation, source snapshots and personal reflection.

Use Node 26.12.1 and Python 3 with SQLite supporting `unixepoch('subsec')` (3.42 or newer):

```sh
npm ci
npx playwright install --with-deps chromium
npm run verify
```

The verification gate checks formatting/lint, strict TypeScript, generated schema drift, contracts, fixed private-field coverage, SQLite constraints, deterministic domain logic, actual local workerd D1 batches, client/Worker builds, and the identity/recovery and saved-reading browser journeys. It has a 540-second deadline and writes an ignored `artifacts/verify.json` receipt. No live provider or hosted database is used. Tests deny outbound fetch before importing application code.

```sh
npm run test:domain
npm run test:db
npm run dev
npm run build
npm run dev:worker
npm run dev:identity
npm run test:browser
npm run restore:rehearse
npm run cleanup:rehearse
npm run release -- --check
npm run package -- --local-snapshot /absolute/path/reflection-app-local.zip
npm run key:rotate -- --help
```

Run `npm run dev:identity` and open **http://localhost:8787** for the account and reading screens. The explicit `wrangler.identity.jsonc` configuration binds local D1/R2 and public synthetic test keys; it must never hold real personal data or be deployed. The default Worker configuration does not enable identity routes. A separate `READING_MODE=synthetic-local` switch enables the reading workflow in that local configuration. The writer never makes an external AI call. Use synthetic text only.

The browser test starts its own loopback Worker, applies migrations to a temporary local database, uses Chromium virtual authenticators, then disposes the temporary storage. The development command keeps its local data under `.wrangler/identity-development` and invokes local scheduled maintenance at startup and once per minute. `npm run dev` alone starts the frontend without an identity backend.

The default and identity Wrangler configurations remain local-only; `wrangler.preview.jsonc` deploys the hosted development preview above. `release --check` reports outstanding production qualifications and returns `deploymentAllowed: false`; it does not control development preview deployment. The synthetic commands use an intercepted writer, while `dev:live` and the hosted preview call OpenAI. The local create/save/return/reflect journey is covered by browser tests. The [current application inventory](docs/MILESTONE_2_ACCEPTANCE.md#current-application-inventory) separates verified local flows from the remaining product and launch gates.

## Source ownership

- `src/contracts/index.ts` owns the Zod contracts. `checks/generate-openapi.ts` owns operation metadata; `scripts/schemas.ts` projects the OpenAPI/model schemas.
- Ordered SQL files in `src/worker/db/migrations/`, alongside `publication_guard.sql` and `column-registry.json`, own persistence, publication assertions and reviewed field policy.
- The corresponding files in `docs/architecture/` are generated mirrors. Edit the source, then run `npm run schemas`; `npm run verify` only checks them and never repairs drift automatically.
- Architecture prose and prior `CHECK_RESULTS.md`/`checks/RESULTS.json` are imported specification evidence. They do not claim this application's tests ran. New implementation evidence lives in [Milestone 1 results](docs/MILESTONE_1_RESULTS.md) and the local verification receipt.
- Synthetic canon fixtures contain explicit test-only review metadata. They are not human-approved launch content.

The [Milestone 1 plan](docs/superpowers/plans/2026-10-26-milestone-1.md), [identity/recovery plan](docs/superpowers/plans/2026-10-26-identity-recovery.md) and [saved-reading return plan](docs/superpowers/plans/2026-10-26-saved-reading-return.md) map the implementations. The [architecture reading order](docs/architecture/ARCHITECTURE.md) links the source requirements. The new browser test connects complete-kit recovery to the same saved content; full Milestone 2, provider, privacy, browser/accessibility and hosted launch acceptance remain open.
