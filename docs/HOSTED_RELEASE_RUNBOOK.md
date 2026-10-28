# Hosted candidate preparation

The prepared pipeline builds and deploys a synthetic qualification environment. It has no production deploy command. `npm run release -- --check` remains an inspection command and always returns `deploymentAllowed:false`.

The only connected Cloudflare account on 2026-10-28 is Henry Flare (`a77e479f6736120eadd99973dbeb705e`). The development preview runs there. A separate production account, protected credentials and exact domain are outstanding; no new production resources have been provisioned. The [build configuration](../config/hosted-builds.json) records the intended commands without inventing account or resource IDs.

## Isolation and permissions

Create production and synthetic qualification resources in separate accounts. A Worker Editor can attach storage bindings without separate permissions on those resources; per-Worker permissions inside one account do not establish a storage boundary. Keep production account membership and tokens out of preview and qualification build contexts. Inspect the actual token policies and account membership before provisioning. Use independently retained inventory/secret backups and restrict their mutation separately from the normal application deploy role. [Cloudflare authorization](https://developers.cloudflare.com/workers/authorization/).

Complete an exact runtime manifest from the [qualification example](../config/qualification.manifest.example.json). Wrap it as `{version:1,accountId,isolatedAccounts:[{environmentId,accountId}],runtime}` in protected `REFLECTION_HOSTED_TARGET_JSON`. Every peer in `runtime.isolatedFrom` must have an independently identified account. The validator rejects shared account/resource IDs and invalid origins/RP IDs. These declarations are cross-checked locally; actual account permissions still require direct credential probes.

## Controlled builds

Pin Node 26.12.1 and npm 11.20.0, use `npm ci`, disable build caching for qualification, and restrict the trigger to main. Set the commands exactly as recorded in `config/hosted-builds.json`. `hosted:build` installs the pinned Playwright Chromium and dependencies, runs all 14 verification stages, then bundles the hosted entry point, client assets and migrations. The gate has a nine-minute deadline. Failed, skipped, flaky, partial or stale verification cannot produce a passing candidate.

The command obtains build metadata using the authenticated Cloudflare API and matches the build UUID, checkout commit, branch and configured commands. User-set CI variables alone cannot establish that context. The deploy command rechecks the live build, source, target, configuration and artifact bytes before deploying only the synthetic bundle with `--no-bundle`. Metadata responses can contain secret environment values; never print or retain the full API response. [Workers Builds configuration](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/).

The candidate directory `artifacts/hosted/` contains the exact Worker, assets, SQL migrations, Wrangler configuration and `candidate.json`. Its digest excludes only the self-describing candidate file. Migration application is a separate operator step against the exact synthetic database; this command does not apply schema changes automatically. Keep ingress and generation off until those migrations and synthetic dependency bindings have been verified.

## Required hosted observations

Record an actual failing main build and show it cannot promote. Attempt a non-main production deployment and directly exercise preview credentials against synthetic markers in the separate production account; script rejection alone is insufficient. Restore the passing candidate, run a clean-cache build, record setup and total gate durations, and perform the [hosted restore scenarios](HOSTED_RESTORE_RUNBOOK.md). Do not attach paid provider credentials to fault-injection scenarios.

These hosted observations have not run. A local receipt proves local checks only. Production activation requires the final evidence packet, exact target, budget decisions and separate launch authorization; the prepared scripts cannot enable it.

## Automated content

Automated content uses signed `content-approval.v3`, `reviewMethod:automated`, `runnerVersion:content-validator.v1` and a validator identity. Exact source/catalog/copy/evidence hashes and an independently configured trust key remain required. Unknown rights stay unknown; disallowed sources are rejected. Migration 0015 preserves historical content and dependent readings, checks the complete foreign-key graph before resetting SQLite's deferred replacement counter, and rolls back if the copied parent set is incomplete. Activation leaves generation off. Legacy signed approvals remain readable without relabeling them as automated.
