# Automated browser coverage

Runner: repository Playwright 1.64.1, Chromium 156.0.8078.4, headless Linux, Node 26.12.1. The automated browser matrix currently consists of this Chromium version. The exact local origin is `http://localhost:8787`; WebAuthn uses virtual CTAP2 authenticators. No provider credentials or paid calls are used by verification.

The browser suite exercises registration, complete kit download/acknowledgement, passkey sign-in, reauthentication/add/remove, logout-all, lost-browser kit recovery and reopening exact saved content with consent off. Database tests additionally enforce last-factor and ten-factor protections, spent-code rejection, origin/counter checks and competing factor enrollment. These are complementary proofs; a database test is not a physical authenticator result.

Reading journeys cover explicit Start, progress/cancel/reload, lost acknowledgements, keyboard source expansion and completion focus, semantic source/synthesis/action headings, optional Save/reflection, dated history, dirty-draft conflict/offline behavior, consent-off export and exact-revision/account deletion. The inspection test checks 320px horizontal reflow and doubled rendered text/layout using CSS zoom at a 640px viewport, including controls and accessibility-tree headings. CSS zoom is an automated layout probe; it does not establish OS text enlargement or browser-native zoom behavior.

Screenshots are temporary test artifacts outside the checkout. The enlarged-text image was inspected; the tested surface rendered without horizontal clipping. Test logs and `artifacts/browser-tests.json` record actual outcomes; `npm run verify` rejects failed, skipped or flaky cases. Reports are bound to the final source by `artifacts/verify.json`.

Physical/synchronized authenticators, Safari/Firefox, native browser/OS enlargement and VoiceOver/NVDA experience have not been tested. These are explicit coverage limitations, not requirements for human reviewers. The production identity gate still needs the exact hosted origin/RP ID and automated journeys on the frozen hosted candidate. Local coverage does not close hosted acceptance.
