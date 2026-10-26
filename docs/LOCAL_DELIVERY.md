# Local application delivery

This delivery is a runnable local application with deployment disabled. The owner clarified on 2026-10-26 that production domain, audience and budget decisions must not hold up this delivery. They remain deferred production decisions; this does not invent hosted, provider, human editorial or real-device evidence.

Use Node 26.x and Python 3. From the extracted `reflection-app` directory:

```sh
npm ci
npm run verify
npm run dev:identity
```

Open **http://localhost:8787**. Use exactly `localhost`, the origin used for local passkeys. The server binds to loopback. A browser that supports passkeys and a usable authenticator are needed for interactive registration; automated tests use Chromium virtual authenticators. This local environment uses published synthetic keys and intercepted AI output. Use invented questions and reflections. It is not suitable for private personal data.

The normal application flow supports registration, downloading and acknowledging the complete recovery kit, separate AI permission, starting a three-card reading, progress/cancel/reload, inspecting cards and sources, saving without a reflection, dated history, exact reopening, later reflection editing, export and deletion. Recovery requires the downloaded handle plus one unused code and replacement-passkey enrollment. Account controls list/add/remove passkeys and sign out all sessions. AI-off mode preserves owned saved-content actions.

`npm run dev:identity` persists local synthetic state under `.wrangler/identity-development`; restarting the server keeps those local accounts. The downloaded recovery kit is intentionally not part of the source ZIP. Do not share a real kit. Browser clearing removes browser state, not the local service database.

The UI and driver still use the synthetic writer in this delivery. The disabled OpenAI adapter is tested with intercepted responses; no live model evaluation or paid request was performed. The draft launch canon is review material, not activated content.

The deterministic gate requires Playwright's matching Chromium binary. If absent, install it with the pinned Playwright CLI before running verification. A missing browser is a setup failure, never a passing/skipped acceptance result.

The ZIP includes source, migrations, lockfile, tests, documentation, qualification status and verification records. `artifacts/DELIVERY.json` lists every packaged file and its SHA-256. The adjacent `.sha256` file verifies the whole ZIP. It excludes Git history, dependencies, build caches, local databases and secret files.

```sh
npm run release -- --check
npm run package -- --local-snapshot /absolute/path/reflection-app-local.zip
```

Packaging requires an unchanged source with a passing verification receipt. A completed-milestone package additionally requires all recorded external acceptance gates; local packaging never enables deployment. The source archive can be rebuilt deterministically from the same source and verification evidence.

See [operational procedures](OPERATIONS_RUNBOOK.md), [production acceptance](PRODUCTION_ACCEPTANCE.md), and [the milestone acceptance record](MILESTONE_2_ACCEPTANCE.md) for the precise remaining boundaries.
