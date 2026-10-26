# Reflection successor specification

Complete proposed architecture package, prepared 2026-10-26 from the supplied brief and selected evidence. This directory is outside the predecessor repositories. It contains specifications and disposable artifact checks, not an implemented application.

Start with [ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md), which supplies the reading order, scope, decisions, source ledger and bounded unknowns. The seven required deliverables are:

- [ARCHITECTURE.md](docs/architecture/ARCHITECTURE.md)
- [DOMAIN_CONTRACTS.ts](docs/architecture/DOMAIN_CONTRACTS.ts)
- [schema.sql](docs/architecture/schema.sql)
- [openapi.yaml](docs/architecture/openapi.yaml)
- [VERIFICATION_PLAN.md](docs/architecture/VERIFICATION_PLAN.md)
- [IMPLEMENTATION_PLAN.md](docs/architecture/IMPLEMENTATION_PLAN.md)
- [ASSETS_AND_MIGRATION.md](docs/architecture/ASSETS_AND_MIGRATION.md)

Linked companion files cover generation, privacy, restore, user journeys, field lifecycle and the synthetic evaluation corpus. [CHECK_RESULTS.md](docs/architecture/CHECK_RESULTS.md) records executed checks, review resolutions, six consistency traces and unexecuted launch qualifications.

Reproduce the artifact checks from this directory:

```sh
npm ci
npm run schemas
npm run check:contracts
npm run check:sql
npm run check:openapi
python3 checks/check-package.py
```

`checks/make-registry.py` and `checks/make-corpus.py` are one-time authoring aids; do not regenerate policy or expected outcomes simply to pass a check. No command above calls a writing provider. The proposed application command `npm run verify` is a milestone 1 deliverable and is not implemented by this artifact-only package.

The distribution archive includes documents, checks, lockfile and TypeScript configuration. It excludes installed dependencies and research source copies. Exact predecessor revisions and paths remain in the source ledger; their code/assets are not adopted or redistributed as a successor foundation.
