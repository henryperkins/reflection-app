# Local identity and recovery implementation plan

> **For agentic workers:** Use superpowers:executing-plans for implementation and a fresh whole-branch security review. Steps use checkboxes to record completion.

**Goal:** Create a synthetic local account with a real WebAuthn passkey, explicitly download a complete recovery kit, sign in/out, and recover the same account after browser state and the original authenticator are gone.

**Architecture:** Extend the existing Hono/React application and actual D1 harness. SimpleWebAuthn verifies credentials; D1 owns single-use challenges, sessions and security fences. An independently encrypted immutable R2 checkpoint commits each identity mutation before credentials or privileged results become available. Existing deployment remains disabled; only an explicit loopback development configuration enables these routes.

**Tech Stack:** Existing strict TypeScript/Hono/React/Vite/workerd/D1, Web Crypto, SimpleWebAuthn server 14.0.3/browser 14.0.0, Playwright 1.64.1 with Chromium virtual authenticators.

**Spec:** `docs/architecture/PRIVACY_OPERATIONS.md` identity/encryption sections, `SECURITY_RESTORE.md` recovery kit and security saga, `VERIFICATION_PLAN.md` A01/A02 and the identity portion of MVP03; owner-approved immediate implementation slice in the chat.

## Global constraints

- Synthetic local data only; no real credentials/data, paid inference, remote resources or deployment.
- Keep `npm run verify` and release refusal. The five complete MVP journeys and production qualifications remain open.
- Registration: resident key and user verification required; attestation none; algorithms ES256 and RS256. Challenges expire after five minutes and bind to a browser cookie; finishes are single-use and epoch-checked.
- Sessions: random 32-byte token; store HMAC only; seven-day absolute and 24-hour idle expiry; five-minute recent authentication. Exact Origin, JSON and session-bound CSRF protect mutations.
- Recovery: random 128-bit handle and ten independent 128-bit codes, shown once; only keyed verifiers persist. Download contains origin, instructions, handle and codes. No silent browser persistence.
- Every security mutation follows D1 fence → immutable encrypted R2 checkpoint → D1 apply. No account DEK, raw kit, session or CSRF secret in checkpoint. Recovery grants only new-passkey enrollment and replaces old factors on completion.
- Source schemas/migrations/registry remain authoritative. Use existing tables; any schema adjustment must update registry and projections.

## Review focus

1. Concurrent challenge/code reuse must produce at most one result; a database-clock expiry crossed during verification must reject at commit.
2. R2 failure or a lost apply response must leave a resumable fence and must never issue an uncommitted session.
3. Browser mismatch, substituted purpose/subject, wrong origin, absent user verification and positive-counter rollback must fail generically.
4. Recovery must preserve the original subject and wrapped data keys, revoke old sessions/factors and leave AI permission false.
5. Raw kit values must not leak through D1/R2, logs, automatic browser storage, or background requests.

## Task 1 — Cryptography and durable identity mutation

Files: `src/worker/identity/crypto.ts`, `checkpoint.ts`, `types.ts`; `tests/db/identity-checkpoint.test.ts`, synthetic key fixtures; D1/R2 test bindings.

Interfaces: domain-separated `IdentityCrypto` hashes, AES-GCM key wrapping and checkpoint envelopes; `IdentityCheckpoints.commit(snapshot, initialStatements)` and `resumePending()` over D1/R2. Shared snapshot shape is existing `IdentityCheckpoint`.

- [ ] Write and run failing tests for immutable checkpoint durability, failure/resume, concurrent apply, secret exclusion and unchanged keys across recovery.
- [ ] Implement strict envelope validation, account key provisioning, conditional R2 writes, D1 fences and atomic state apply. Resume pending work without issuing bearer results.
- [ ] Run task tests and typecheck; commit the completed task.

## Task 2 — WebAuthn, sessions and HTTP boundaries

Files: `src/worker/identity/{service,sessions,passkeys,routes}.ts`, `src/worker/index.ts`; `tests/db/identity.test.ts`, synthetic WebAuthn fixture helper.

Interfaces: `IdentityService` uses the crypto/checkpoint layer; routes parse existing `apiSchemas` for options/register/authenticate/recover/ack/rotation/me/logout. Service returns raw session tokens only to the cookie adapter. Nonlocal/unconfigured requests remain unavailable.

- [ ] Run failing actual-D1 tests for registration/login, purpose/browser/epoch/expiry/replay guards, session expiry/CSRF/origin, complete recovery and rate bounds.
- [ ] Implement maintained-library WebAuthn verification, hash-only challenge/recovery/session storage, permission false at account creation, recovery kit issuance/ack/rotation, logout and scheduled pending-operation recovery.
- [ ] Verify same subject/key ownership after recovery and rejection of old factors; keep unimplemented private product routes unavailable.
- [ ] Run all domain/D1 tests and typecheck; commit the completed task.

## Task 3 — Local account UI and clean-browser acceptance

Files: `src/client/{main,identity,api}.tsx/ts`, styles; local-only Wrangler configuration and development script; `tests/browser/identity.spec.ts`, Playwright configuration and verification browser evidence.

Interfaces: UI consumes the existing parsed auth contracts and SimpleWebAuthn browser library. Kit download/copy serializes both handle and codes plus canonical origin/instructions; auth/kit state lives only in RAM. Local browser tests use virtual authenticators with real signatures against the Worker.

- [ ] Write and run failing browser journeys for create/download/ack/logout/login, then recover with only the saved kit in a new context and new authenticator.
- [ ] Build accessible account/recovery screens, generic error handling, explicit kit acknowledgement, replacement kit, and account state that clearly leaves readings unavailable in this slice.
- [ ] Assert no browser persistence of kit, zero provider calls, old session/code/passkey rejection, and no private access before new-passkey completion.
- [ ] Integrate executed browser-test evidence into the deterministic gate; preserve the distinction from full MVP03 reading acceptance.
- [ ] Run complete verification, fresh security review, resolve material findings, record evidence and remaining gates; commit the completed work.

## Execution decisions

The owner approved proceeding with the immediate local identity/recovery slice. Implement in the existing separate application checkout on `codex/milestone-2-identity-recovery`; no additional approval round or new chat is needed. Browser account recovery is in scope; saved-reading history/reopen and the full MVP03 journey remain subsequent work. Additional passkey add/remove settings and operator restore replay are later identity/launch work, not claims made by this slice.
