# Reflection local foundation

Milestone 1 implementation, using synthetic data only. This is a new application repository based on the approved architecture at [`278d5fd`](https://github.com/henryperkins/reflection-architecture/commit/278d5fdb1636225887220368fbef52dc0d7ab889). The first-user experience, identity/recovery, production encryption, live provider, and hosted qualification belong to subsequent work.

Use Node 26.12.1 and Python 3 with SQLite supporting `unixepoch('subsec')` (3.42 or newer):

```sh
npm ci
npm run verify
```

The verification gate checks formatting/lint, strict TypeScript, generated schema drift, contracts, fixed private-field coverage, SQLite constraints, deterministic domain logic, actual local workerd D1 batches, and client/Worker builds. It has a 540-second deadline and writes an ignored `artifacts/verify.json` receipt. No live provider or hosted database is used. Tests deny outbound fetch before importing application code.

```sh
npm run test:domain
npm run test:db
npm run dev
npm run build
npm run dev:worker
npm run release -- --check
```

The Vite page is a static development status screen. The Worker has `/health`; private API routes return unavailable. The publication prototype is an internal test harness and never accepts personal input through HTTP. Wrangler configuration contains no remote database ID or deployment route. `release --check` reports outstanding qualifications; deployment is deliberately disabled in this milestone.

## Source ownership

- `src/contracts/index.ts` owns the Zod contracts. `checks/generate-openapi.ts` owns operation metadata; `scripts/schemas.ts` projects the OpenAPI/model schemas.
- Ordered SQL files in `src/worker/db/migrations/`, alongside `publication_guard.sql` and `column-registry.json`, own persistence, publication assertions and reviewed field policy.
- The corresponding files in `docs/architecture/` are generated mirrors. Edit the source, then run `npm run schemas`; `npm run verify` only checks them and never repairs drift automatically.
- Architecture prose and prior `CHECK_RESULTS.md`/`checks/RESULTS.json` are imported specification evidence. They do not claim this application's tests ran. New implementation evidence lives in [Milestone 1 results](docs/MILESTONE_1_RESULTS.md) and the local verification receipt.
- Synthetic canon fixtures contain explicit test-only review metadata. They are not human-approved launch content.

The [implementation plan](docs/superpowers/plans/2026-10-26-milestone-1.md) maps the work. The [architecture reading order](docs/architecture/ARCHITECTURE.md) links the source requirements. MVP01–MVP05 remain future browser acceptance; this foundation does not qualify real-user rollout.
