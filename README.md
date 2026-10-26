# Reflection local foundation

Milestone 1 is complete. The next local slice adds passkey account creation/sign-in, complete recovery-kit download and acknowledgement, and recovery with a replacement passkey after browser state is cleared. It uses synthetic accounts only and keeps deployment disabled. The five complete MVP journeys and production launch gates remain open.

Implementation evidence: [Milestone 1 baseline](docs/MILESTONE_1_RESULTS.md) and [local identity/recovery results](docs/IDENTITY_RECOVERY_RESULTS.md). The architecture baseline remains [`278d5fd`](https://github.com/henryperkins/reflection-architecture/commit/278d5fdb1636225887220368fbef52dc0d7ab889).

Use Node 26.12.1 and Python 3 with SQLite supporting `unixepoch('subsec')` (3.42 or newer):

```sh
npm ci
npx playwright install --with-deps chromium
npm run verify
```

The verification gate checks formatting/lint, strict TypeScript, generated schema drift, contracts, fixed private-field coverage, SQLite constraints, deterministic domain logic, actual local workerd D1 batches, client/Worker builds, and the clean-browser identity/recovery journey. It has a 540-second deadline and writes an ignored `artifacts/verify.json` receipt. No live provider or hosted database is used. Tests deny outbound fetch before importing application code.

```sh
npm run test:domain
npm run test:db
npm run dev
npm run build
npm run dev:worker
npm run dev:identity
npm run test:browser
npm run release -- --check
```

Run `npm run dev:identity` and open **http://localhost:8787** for the account screens. The explicit `wrangler.identity.jsonc` configuration binds local D1/R2 and public synthetic test keys; it must never hold real personal data or be deployed. The default Worker configuration does not enable identity routes. Reading generation, saved-reading history, reflections, export and deletion remain unavailable in this slice.

The browser test starts its own loopback Worker, applies migrations to a temporary local database, uses Chromium virtual authenticators, then disposes the temporary storage. The development command keeps its local data under `.wrangler/identity-development` and invokes local scheduled maintenance at startup and once per minute. `npm run dev` alone starts the frontend without an identity backend.

Wrangler configuration contains no remote database ID or deployment route. `release --check` reports outstanding qualifications and always returns `deploymentAllowed: false`. The publication prototype remains an internal synthetic test harness; local identity work does not make it a production reading service.

## Source ownership

- `src/contracts/index.ts` owns the Zod contracts. `checks/generate-openapi.ts` owns operation metadata; `scripts/schemas.ts` projects the OpenAPI/model schemas.
- Ordered SQL files in `src/worker/db/migrations/`, alongside `publication_guard.sql` and `column-registry.json`, own persistence, publication assertions and reviewed field policy.
- The corresponding files in `docs/architecture/` are generated mirrors. Edit the source, then run `npm run schemas`; `npm run verify` only checks them and never repairs drift automatically.
- Architecture prose and prior `CHECK_RESULTS.md`/`checks/RESULTS.json` are imported specification evidence. They do not claim this application's tests ran. New implementation evidence lives in [Milestone 1 results](docs/MILESTONE_1_RESULTS.md) and the local verification receipt.
- Synthetic canon fixtures contain explicit test-only review metadata. They are not human-approved launch content.

The [implementation plan](docs/superpowers/plans/2026-10-26-milestone-1.md) maps the work. The [architecture reading order](docs/architecture/ARCHITECTURE.md) links the source requirements. The [identity/recovery plan](docs/superpowers/plans/2026-10-26-identity-recovery.md) maps this slice. Its browser test proves account recovery; MVP03 remains open until recovery also finds and reopens the saved reading. MVP01–MVP05 and real-user rollout are not claimed complete.
