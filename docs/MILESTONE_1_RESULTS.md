# Milestone 1 implementation evidence

This application repository implements the local synthetic foundation specified by `reflection-architecture` at [278d5fd](https://github.com/henryperkins/reflection-architecture/commit/278d5fdb1636225887220368fbef52dc0d7ab889). The architecture repository remains unchanged. This repository has no remote or deployed resources.

## Implemented scope

- Strict TypeScript/Hono/React/Vite/Zod scaffold with exact dependency lockfile. Only a development status page and Worker health endpoint are exposed; private API routes return unavailable.
- Source-owned contracts, ordered D1 migrations, publication guard and reviewed field registry. Six documentation/API/schema projections have a check-only drift gate.
- Deterministic HMAC-SHA256/Fisher–Yates drawing, three-card plans, all seven controlled facts, source integrity/binding checks, deterministic templates and a closed writer payload projection. Independent Python-generated golden vectors pin the draw algorithm.
- An intercepted writer and an actual workerd/D1 lifecycle prototype covering ownership, unique intent/dispatch/publication, leases, database-clock deadlines, revocation, cost/product quota and transactional rollback. A cross-module test sends the real prepared plan projection through the intercepted writer and publishes once under concurrent retries.
- A 12-stage `npm run verify` gate with a 540-second deadline, child-process cancellation, environment filtering, local dotenv rejection, test execution receipts and source-digest validation. The release wrapper checks current local evidence and always disables deployment during this milestone.

## Local evidence

Runtime measured on 2026-10-26: Node 26.12.1, npm 11.20.0, Python 3.14.4, SQLite 3.46.1, workerd 1.20261023.1. Worker compatibility date is pinned to 2026-10-23, matching the installed runtime. The current [Cloudflare Vitest plugin](https://developers.cloudflare.com/workers/testing/vitest-integration/) runs the D1 suites against actual local bindings.

A clean `npm ci` succeeded from the lockfile and reported zero dependency vulnerabilities before final verification.

`npm run verify` passes formatting/lint, strict TypeScript, six projection comparisons, contract/reference checks, private-field coverage, SQLite assertions, OpenAPI validation, domain/tooling tests, actual D1 tests, client build, Worker dry-run build, and specification package integrity. An initial complete run took **6.24 seconds** against the 540-second limit. The final run's measured duration, source digest and per-stage results are recorded in `artifacts/verify.json`; this generated local receipt is deliberately untracked.

The test inventory comprises **125 passing tests**: 71 domain, 10 tooling, and 44 actual D1 lifecycle/scaffold/integration tests. The gate reads Vitest JSON evidence and rejects zero tests, skipped/todo tests, failures or inconsistent counts. It does not accept a successful process exit as proof that tests executed. Registry coverage is **36 tables / 309 columns**, SQLite checks contain **26 assertions**, and OpenAPI validates **37 operations**.

Negative probes establish that verification rejects an edited generated artifact without rewriting it, ordinary or generated unregistered private columns, an unregistered column in a later migration, missing erasure policy, skipped/empty test evidence, and local dotenv files. Child environments exclude application credentials and Vite variables while retaining execution-required proxy/CA settings. Test setup rejects unexpected global `fetch` calls, including caught attempts; it is not an OS-level network sandbox.

Independent review identified and corrected coverage gaps for generated columns, later migrations, skipped tests and inherited environment values. A separate final review assessed the deterministic domain and D1 interleavings; its disabled-mode admission finding was fixed and independently verified. Clock-only deadline tests additionally pause publication after eligibility sampling until the unchanged lease or absolute deadline passes, proving actual D1 rollback of edition and accounting writes. Review records and task evidence are retained in the local `.superpowers/milestone-1/` working directory.

## Boundaries before Milestone 2

This is a synthetic test foundation, not a usable private-reading product. No real credentials, personal records, paid inference, remote D1 database or deployment was used. All fixture review identities are explicitly synthetic; none constitutes human approval of launch content.

The D1 prototype stores visible `SYNTHETIC_ONLY_NOT_ENCRYPTED` placeholders and accepts trusted fixture metadata. It does not authenticate people, encrypt/decrypt accepted readings, validate the full semantic model output, or implement the production service, durable driver, retention/deletion jobs or template recovery branch. The integration test validates candidate bindings before publication, but the prototype itself is not a production acceptance boundary.

Templates and writer projection use the same plan. Source IDs establish which approved-status source was supplied; they do not prove that generated wording is entailed by that source. Fact sentences currently use canonical card IDs. The payload budget uses a conservative UTF-8-byte estimate, which can reject inputs a qualified model tokenizer would accept. Model-specific tokenization, semantic/safety/readability validation and live provider qualification remain outstanding.

The authoritative selected-fragment schema retains its existing 1200-UTF-16-unit cap, while offset/aggregate domain checks count code points; resolving that astral-text limit belongs with later selected-context work. This does not enable selected-context product controls in the first slice.

MVP01–MVP05 have not been executed in an application/browser. Identity/recovery, reviewed launch canon, server-readable encryption, saved-reading UI, export/deletion, accessibility, hosted race/release/restore proof and provider qualification remain required subsequent work. `npm run release -- --check` lists these unmet qualifications and returns `deploymentAllowed: false` even with current passing local verification.
