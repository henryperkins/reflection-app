# Local identity and recovery implementation evidence

Prepared 2026-10-26 for the next implementation slice after accepted Milestone 1. Baseline: `e1bc1fc1dc316d81f398c5da6442fedb1fbc2e12`. The implementation is on `codex/milestone-2-identity-recovery` in this application repository. Deployment stays disabled.

## Implemented behavior

- Real WebAuthn verification through pinned SimpleWebAuthn server 14.0.3/browser 14.0.0, exercised in local workerd and Chromium with synthetic authenticators. Registration requires a discoverable passkey and user verification. Login checks the subject handle, signature, challenge/browser/purpose, counter and current account epoch.
- Random session tokens, hashed verifiers, secure HttpOnly cookies, exact Origin/JSON/CSRF enforcement, seven-day absolute and 24-hour idle deadlines, five-minute recent authentication, generic closed error envelopes, and content-free rate-limit keys. AI permission starts false.
- Random account data/index keys wrapped with AES-GCM and owner/purpose-bound authenticated data. The independent recovery key encrypts complete identity checkpoints. Checkpoint contents contain public credential material and recovery verifiers, not raw recovery factors, account data keys or sessions.
- D1 security fences, immutable conditional R2 writes, and atomic D1 application before returning privileged results. Pending mutations resume through the scheduled handler; it also cleans expired challenges/sessions/rate buckets and applied D1 operations after 30 days. A failed checkpoint write does not issue a session. Hosted scheduling and operator restore replay remain unqualified.
- Registration and completed recovery issue a new handle and ten codes. Explicit download/copy includes both factors, the canonical origin and instructions. Kit acknowledgement and rotation use the security saga. No automatic browser persistence is added.
- A handle plus unused code only permits replacement-passkey enrollment. Completion preserves the subject and wrapped keys while replacing prior credentials/codes and issuing a replacement kit. New sign-in and recovery do not grant AI permission.
- Account UI with separate create/sign-in/recover flows, explicit kit acknowledgement, passkey-backed kit rotation, logout and cross-tab invalidation. It remains a clearly labelled local test build with personal-reading features unavailable.

## Executed evidence

The full `npm run verify` gate now has 13 stages. A complete run passed in **16.19 seconds** against the existing 540-second deadline: **82 domain/tooling tests**, **62 actual D1 tests**, and **5 browser checks** (149 total). This is a recorded run, not a fixed performance guarantee; `artifacts/verify.json` holds the latest duration, source digest and stage results. Machine-readable test receipts reject missing, empty, skipped, failed or inconsistent test evidence. Browser evidence also rejects expected failures and retries/flakes.

The browser journey uses Playwright 1.64.1 and pinned Chromium. It creates an account, downloads and parses the complete kit, acknowledges it, signs out/in, removes the original virtual authenticator, clears browser cookies, closes the page and opens a fresh browser context. It recovers using only the downloaded handle/code, confirms `/me` is unavailable before replacement enrollment, enrolls a new authenticator, and verifies the same subject with AI permission still false and a new complete kit. The test checks empty localStorage/sessionStorage/IndexedDB, no external browser requests, no page runtime errors, response security headers and mobile overflow. Screenshots were inspected at desktop 1100×850 and mobile 390×844; screenshots and failure diagnostics are disposable files under `/tmp`.

Actual D1/R2 and Web Crypto checks exercise owner/purpose-bound decryption, immutable checkpoint creation, R2 failure/resume, stale epoch rejection, unchanged wrapped keys, challenge races and browser binding, wrong origin, missing user verification, session expiry, positive-counter rollback, old passkey/code rejection, CSRF, kit rotation/recent-auth checks, rate bounds, and expiry cleanup. Earlier failing tests identified the missing implementation before these checks passed. No live provider, remote database or real account was used.

The browser host initially lacked required Chromium shared libraries; the first launch failed. The pinned browser and required Linux dependencies were installed, and the browser run then executed successfully. Browser installation is an explicit prerequisite in README. The Browser plugin was not available; regular Playwright was used.

The implementation follows the [official SimpleWebAuthn server](https://simplewebauthn.dev/docs/packages/server) and [browser APIs](https://simplewebauthn.dev/docs/packages/browser). Library behavior is verified locally; this does not qualify every hosted runtime or real authenticator. Dependency installation reported zero vulnerabilities; no production dependency/retention qualification is implied.

## Review and remaining gates

An independent read-only whole-branch review examined `e1bc1fc..b3a791c`, inspected the security boundaries, and ran isolated Chromium probes. It found no authentication bypass, but identified four material issues. All four were addressed in the final implementation and verification pass:

| Finding | Resolution and executed evidence |
|---|---|
| Focus changes erased recovery inputs/grants; transient session reads could lose a newly issued kit. | Anonymous recovery no longer triggers focus-based session refresh; transient errors preserve the one-time kit. The browser journey now switches focus while entering the handle and after code verification; a separate fault test rejects the follow-up `/me` request while keeping the downloadable kit. These regressions failed before the fix and pass afterward. A separate rotation test proves an explicit 401 clears the replacement kit; temporary connection errors preserve it. |
| Delayed async actions could repopulate account secrets after cross-tab invalidation. | Every async action captures an operation generation and checks it before subsequent requests/state commits. A browser test holds a registration response, broadcasts sign-out, then releases it and verifies no kit or account screen returns. It failed before the fix and passes afterward. |
| Local development never invoked pending security recovery. | The local runner now enables Wrangler's loopback scheduled-event adapter and drives it at startup and once per minute. A browser-runner check invokes the real adapter; the D1/R2 failure test resumes through the actual Worker scheduled handler. The driver test failed before implementation and passes afterward. |
| Required security interleavings lacked behavioral tests. | Added actual-D1 tests for concurrent pending checkpoint apply, a successful apply whose response is lost, concurrent use of one recovery code, and expiry after verification but before commit. All pass. Temporarily removing the commit-time expiry predicate made the expiry regression fail; the predicate was restored before the passing full gate. |

The final fix pass was verified by the author against these regressions and the complete gate; the reviewer did not independently re-review the fixes. No material finding from this bounded review remains unresolved. The review did not qualify the intentionally deferred features listed below.

The full five MVP journeys remain open. In particular, the identity portion of MVP03 now has browser evidence, but saved-reading creation/history/exact reopening after recovery still requires its own implemented services and browser proof. Production body encryption/lifecycle, account/session/reflection deletion, export, approved content and candidate validation, live-provider qualification, hosted release/isolation/D1/restore, manual accessibility and real-device/browser passkey qualification remain open.

The local-only configuration uses public synthetic keys and an exact loopback origin; no production domain/RP ID or secrets were provisioned. Additional passkey management, logout-all, operator checkpoint restore/key rotation and R2 superseded-checkpoint cleanup are not implemented in this slice. Recovery is conservatively limited to five attempts per hour per IP and handle, including successful attempts; refine to the planned failure-only accounting before broader use. The scheduled handler and loopback development driver are tested; actual hosted Cron operation is not established by local development.

These results complete only the approved local account/recovery implementation slice. They do not complete Milestone 2, qualify production privacy, or authorize deployment/provider egress.
