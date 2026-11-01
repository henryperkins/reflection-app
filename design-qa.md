# Reflection design QA

## November 1 — Dated revisit notes

The approved dated-note increment is implemented. [Qualification and comparison scope](docs/verification/2026-11-01/dated-revisit-notes.md) identifies final-source receipts and captures. The chronological list follows the Return, with time board: original reflection first, complete note text and separate saved/edited dates, then a labelled text/stance editor. Full retention/encryption disclosure remains visible; illustrative board copy is not substituted.

The browser suite covers offline first-list retry, failed saves, conflicts, seven-day retry expiry, independent deletion outcomes, late acknowledgements, stale reads, focus and announcements. Standard Chromium tests use real synthetic service flows; distinct-date, legacy-unsaved and unavailable/two-edition presentation cases use labelled synthetic response fixtures. The engine matrix checks 320/390/768/1280 px in both themes, enlarged text, native Chromium zoom and supported forced colors. Screenshot inspection is sampled; automated reflow and focus checks cover the matrix. No physical-device, real-authenticator, screen-reader, Safari or hosted-feature acceptance is claimed.

## November 1 — Entry and return (historical scope)

The owner confirmed this scope: apply the concept boards' visual direction to existing screens and document the proposed flows. PR [#7](https://github.com/henryperkins/reflection-app/pull/7) was merged first as `08e227753f6942d71a5b7dfe717c6d39d6e693df`; this refinement starts from that merged baseline. **Automated verification passed; manual device/assistive-technology acceptance remains open.**

### Delivered surfaces and boundaries

- Landing now shares one paper composition between the large orbit artwork and account controls. The botanical footer reuses an existing optimized transparent sprig. At ≤900 px the controls precede a short orbit crop, keeping create/sign-in/recovery above the artwork.
- Saved readings has a reserved compact title motif, serif questions, fine list rules and navigation that marks the actual current destination. PR #7's date/question rows without arbitrary per-record thumbnails, status-first outcome cards and reduced copy remain intact.
- Solstice light/dark tokens, locally hosted Newsreader/Figtree/Outfit, Fluent icons and all factual disclosures remain authoritative. Native browser surfaces declare both color schemes. Only the landing focal image receives high fetch priority; the unused `leaves.png` is no longer imported.
- The [concept direction](docs/design/concept-direction.md) stores the three refined boards unchanged. At that earlier design-only boundary, dated revisit notes and selected context were **specification only**. Dated notes have since been implemented under separate approval, as recorded above. Their documents record the simple header, original-reflection-first chronology, complete excerpts/dates/revisions, quiet × Remove selection and the boundary at Continue to permission review. Permission copy and submission rules remain open.

### Review findings addressed

- Integration review found that the generic secondary-button hover rule overrode the active Saved readings text color in normal themes. Chromium reproduced 2.10:1 light / 1.89:1 dark contrast. The active hover rule now preserves its foreground, measuring 5.70:1 / 7.89:1. The existing responsive journeys check computed hover contrast for both navigation destinations, including empty and populated history; forced-colors behavior remains covered separately.

- A fixed 100% landing-card height could clip the existing post-deletion receipt. The final layout keeps a flexible column and natural card height. The original layout probe reproduced the clipping; the correction contained the receipt at 320/390/768/1280 px. Existing privacy tests now check full receipt containment on desktop and phone, including a lost deletion response.
- The new selected navigation cue disappeared under forced colors. A real Chromium assertion reproduced the failure. Current and current-hover states now use system Highlight/HighlightText. Rendered review caught a Chromium Canvas backplate obscuring the selected label despite passing computed-color assertions, so only that selected button opts out of automatic adjustment; its colors still come entirely from the user's system palette. The existing forced-colors journeys assert those platform colors for both destinations at rest and on hover; screenshot review checks the label itself.
- History screenshot capture could measure the previous reading before asynchronous navigation completed, producing a new history with an obsolete full-page height. The existing normal/native/forced-color harness now waits for the Saved readings heading before capturing. This is an evidence synchronization correction.
- The independent read-only code/requirements review found the forced-colors issue above and no other Critical, Important or Minor findings. Its excluded device/provider areas remain limitations below; automated outcomes are recorded separately.

### Implementation captures

These are unedited Chromium captures at DPR 1 and a 1000 px viewport height, using a real synthetic local account and three saved test readings. Questions are illustrative; displayed dates are actual server creation times, not the boards' October examples. The capture made exactly three Start requests, recorded no page JavaScript errors and found no horizontal overflow.

| Surface | Phone, light | Phone, evening | Desktop, light | Desktop, evening |
| --- | --- | --- | --- | --- |
| Landing | [390 px](docs/design/screens/2026-11-01/390-light-landing.png) | [390 px](docs/design/screens/2026-11-01/390-dark-landing.png) | [1280 px](docs/design/screens/2026-11-01/1280-light-landing.png) | [1280 px](docs/design/screens/2026-11-01/1280-dark-landing.png) |
| Saved readings | [390 px](docs/design/screens/2026-11-01/390-light-history.png) | [390 px](docs/design/screens/2026-11-01/390-dark-history.png) | [1280 px](docs/design/screens/2026-11-01/1280-light-history.png) | [1280 px](docs/design/screens/2026-11-01/1280-dark-history.png) |

The original implementation record stored receipts/logs and its capture manifest under the ignored local `artifacts/supporting-screen-concepts/` directory. Those local files are not published in this repository; the historical results below are separate from the integration verification linked below. The source and browser harness are copied to a clean local worktree for the synthetic gates, omitting the checkout's dotenv/dev-vars files. No environment file is read or moved, no hosted service is deployed, and no live provider is contacted. The ordinary matrix checks 320/390/768/1280 px in both themes, empty/populated history, long questions/filenames, complete readings/sources, reflection, Account and exact AI-off return; native Chromium 200% zoom and supported forced-colors journeys remain included.

**Historical implementation record: `npm run verify` passed in 290.65 seconds** — 397 domain/tooling tests, 465 workerd/database tests and 91 Chromium browser tests, with zero skipped/flaky. Formatting/lint, strict TypeScript, schema/publication-guard/contract/registry/SQL/OpenAPI checks, client/Worker builds and package-link checks passed. Both the sign-out and lost-response receipt cases passed with the new containment assertions.

**Historical implementation record: 36/36 cross-browser journeys passed in 252.29 seconds**, followed by **4/4 targeted Chromium/Firefox forced-colors journeys in 30.8 seconds** after the selected-state and rendered-label corrections. Both runs had zero skipped, unexpected or flaky tests. The latter conditionally changes forced colors only; the reviewed normal-theme captures remain applicable. That original record reported a byte-for-byte source audit of its own snapshot. It predates the integration hover fix and does not attest to the current branch; use the commit-scoped integration receipts below for the new results.

### Integration verification — November 1

The combined recovery/design source at [`acc06ae`](https://github.com/henryperkins/reflection-app/commit/acc06ae5c7295560fd6a953d0191dd2e87f47572) passed all 14 stages of `npm run verify` in 322.45 seconds: 397 domain/tooling, 467 database and 91 Chromium browser tests. The fresh Chromium/Firefox/WebKit matrix passed all 36 cases in 289.22 seconds. Both runs had zero skipped, unexpected or flaky tests. The matrix includes the computed hover-contrast assertions and supported forced-colors/native-zoom cases.

Published evidence: [full design verification receipt](docs/verification/2026-11-01/design-verify.json), [test counts, browser statistics and contrast regression](docs/verification/2026-11-01/test-summary.json), and [PR #4 verification receipt](docs/verification/2026-11-01/pr4-verify.json). These receipts identify the tested source; subsequent changes publish this evidence and clarify documentation only. No application, test or runtime-configuration file changed after these runs. Complete logs and reports are retained in the local integration backup.

Physical devices, real/synchronized passkeys, screen readers, actual Safari, hosted-origin/RP qualification and live-provider acceptance remain open. This visual scope does not mark those earlier manual gaps passed or approve either proposed product increment.

## October 31 — Historical core journey visual and accessibility pass

Updated 2026-10-31. **Accessibility follow-through: both full gates passed. Manual device/assistive-technology acceptance: blocked (no devices available).** The first frontend batch remains complete. This increment extends acceptance for read → save → reflect → return before supporting-screen styling. Actual Safari/devices/screen-reader acceptance remains outstanding.

## Accessibility follow-through

- Added actual **Chromium 200% page zoom** using a disposable test extension and un-emulated browser window. The browser reports zoom 2, DPR 2, CSS zoom 1 and visual-viewport scale 1. Window widths 640/780/1536/2560 produce effective 320/390/768/1280 CSS-pixel widths in both themes. Keyboard photo attachment/removal, full source expansion, save/reflection/stance, Account, AI-off history reopening and exact content return are exercised.
- Added **Chromium and Firefox forced-colors journeys** at the same widths, with both light/dark preferences. Fixed the extra 50% opacity on disabled controls and busy Back to readings: system `GrayText` is now retained at full opacity. This is a visibility correction, not a claimed WCAG contrast failure for exempt inactive controls. Normal-theme styling is unaffected.
- The original failure is retained in `artifacts/accessibility-pass/baseline/tests.log`; it expected the platform's disabled color without another opacity reduction. Separate component probes document why Linux WebKit cannot qualify forced-color palette substitution. Native screenshots now use zoom-adjusted browser capture coordinates; initial cropped screenshots are archived as harness failures, not product failures or acceptance evidence.
- Added device-session cases D1–D6 with exact actions, expected results and required version/evidence fields in [browser qualification](docs/BROWSER_QUALIFICATION.md#device-acceptance-session). **Blocked:** the owner reports no devices available for these checks. Real-device and AT evidence is still needed before the supporting-screen increment.

### Final results for this increment

- **`npm run verify`: passed in 293.11 seconds.** 397 domain/tooling, 465 database and **85 Chromium browser tests**; zero skipped/flaky. Formatting/lint, TypeScript, schema/contract/registry/SQL/OpenAPI checks, client/Worker builds and package-link checks passed.
- **`npm run test:journey`: 36/36 passed in 270.28 seconds**, zero skipped/flaky. Chromium/Firefox/WebKit retain the ordinary journey matrix; the additional display checks run only on engines that support their test mechanism.
- **472 captured layout states:** 312 ordinary, 64 native Chromium zoom and 96 Chromium/Firefox forced-colors states; zero horizontal overflow or page JavaScript errors. Evidence: `artifacts/accessibility-pass/summary.json`, receipts/logs, `screens/` and `matrix-screens/`.
- Reviewed the high-contrast before/after Account board and final native-zoom/forced-color screenshots. Compared **48 ordinary form screenshots** against the first batch: 45 are pixel-identical; the other three differ only in Choose photo hover styling (two WebKit captures) and a small checkbox rasterization difference (one Chromium capture). Sizes and layout match. Evidence: `forced-colors-before-after.png`, `normal-theme-comparisons.json`, `normal-theme-difference-review.png` and `comparison-review.json` in the same artifact directory.
- `artifacts/accessibility-pass/source-audit.json` verifies all **145 application source files** against both final snapshots and **137 harness/config/fixture files**, with only the explicit loopback-port substitutions. The core gate used 8792; the engine matrix used 8791/8843. Test servers have been closed; the personal instance on 8787 was not stopped or reconfigured.

The current increment changes disabled-control rendering only in forced colors and extends the test harness. Supporting-screen styling and product implementation remain queued behind the manual acceptance step. These results qualify the isolated local tests; hosted-origin and physical-device acceptance remain separate.

## Evidence-based issues and corrections

| Finding | Evidence | Correction / disposition |
| --- | --- | --- |
| Photo attachment/removal was not announced | The new keyboard regression failed against the initial app: no completion status after selecting a file. | Persistent, atomic polite status for preparation, successful attachment (with filename) and removal. Preparation never announces success early; removal returns focus to Choose photo. |
| Reading deletion lost keyboard focus | Initial regression showed the confirmation checkbox inactive after its initiating button unmounted. | Focus moves into confirmation, returns to Delete reading on cancellation, and lands on Saved readings after deletion. History reopening focuses the accepted question; intentional Account sign-out/deletion focuses the signed-out heading. |
| Control boundaries had insufficient contrast | Canvas/sRGB measurement: input stroke **1.37:1 light / 1.67:1 dark** against card surfaces, below 3:1. | Shared `--input` now measures **3.46:1 / 3.58:1** on cards (3.28:1 / 3.72:1 on the page). The matrix asserts ≥3:1 for strokes and ≥4.5:1 for the checked text/button-label pairs. Palette identity is retained. |
| Miniature mobile ribbon and repeated framing weakened hierarchy | Previous/current screenshots with the same normal question, photo, options and two illustrative passkeys. | Dedicated three-leaf corner in its own grid cell; tighter form notices and Account groups; numbered reading rows instead of repeated cards; smaller reflection reference. Complete copy is preserved. |
| WebKit fetched unused desktop artwork on mobile | The 2× delivery regression observed speculative account-sprig/ribbon requests before picture selection. | Compact mobile fallback, media-qualified desktop source. All three engines now pass the 2× delivery check with only the mobile corner and three-card variants requested for those decorations. |
| Empty-photo artwork stretched vertically despite passing horizontal reflow | Manual WebKit screenshot review found HTML intrinsic height overriding the intended responsive aspect ratio; the frame became excessively tall. | Fluid decorative-image height, explicit aspect-ratio/frame-height regression checks, and a stable eager reference for the already-loaded spread photo. Tablet Start remains on one line with reduced horizontal button padding. |

The first two failures are recorded in `artifacts/visual-pass/baseline.log` / `baseline.json`; contrast evidence is `artifacts/visual-pass/contrast-before.json`. Newly added test-harness failures (duplicate text locators, waiting for navigation focus, and WebKit's HTTP Secure-cookie transport) were corrected rather than treated as product defects or skipped tests.

## Visual decisions

- **Mobile:** the corner occupies 64 × 72 CSS px with a 12 px heading gap; it is not an absolutely positioned ribbon/crop. The mobile breakpoint is consistently 760 px, including enlarged-layout probes. Inputs use 16 px text on mobile. Long questions remain complete (up to the existing 500-character limit); long filenames wrap rather than being ellipsized.
- **Reading detail:** photograph → situation → tension → possibility → synthesis/action → sources remains the order. The photograph is contained, never cropped to mimic a concept. Photo readings no longer compete with header decoration. Drawn readings retain their card labels/orientations and compact illustrative faces. Complete basis text, interpretations, closing sections, source text, attribution, IDs and versions remain available.
- **Account:** mobile permission/disclosure content is full-width, passkeys use hairline rows, and tools/sign-out/deletion have clear section headings. Full retention, session-invalidation, encryption and deletion disclosures remain visible. No disclosure was collapsed to achieve density.
- **Palette:** retain Solstice cream/teal, existing fonts and Fluent icons. No mint/deeper-teal resampling. Destructive variants moved into `src/client/design/tokens.css`; the input stroke is the accessibility-only color refinement.
- **Supporting screens:** landing, empty/populated history, recovery and progress were reviewed using the existing illustration language. Their retain/replace/park decisions are mapped in [`src/client/design/art/README.md`](src/client/design/art/README.md). A broader supporting-screen restyle remains a separate increment, not an unreported feature expansion.

Normal-input, DPR-1 comparison measurements (not the long-content stress fixtures):

| Panel | Previous | Current |
| --- | ---: | ---: |
| Reading form, 390 px | 350 × 1390 | 350 × 1261 (**129 px shorter**) |
| Account, 390 px | 390 × 1673 | 390 × 1465 (**208 px shorter**) |
| Passkeys, 390 px | 350 × 392 | 350 × 357 |
| Reflection editor, 390 px | 350 × 748 | 350 × 693 |
| Accepted photo reading, desktop | 720 × 1456 | 720 × 1312 |

Reading draw/text/date differences are expected in synthetic results, so reading height is structural evidence, not a pixel-fidelity target. Desktop form and Account panel heights remain 1040 × 887 and 940 × 1278 respectively. Full disclosures account for the remaining height difference from the concepts.

## Artwork and transfer

`mobile-corner.png` is a dedicated ImageGen composition from the existing botanical references, not a miniature desktop ribbon. All full-resolution originals remain untouched. `scripts/optimize-illustrations.py` creates 11 lossless RGBA WebP variants and verifies exact decoded RGBA, including translucent edges, against each resized source. The manifest records sizes and original SHA-256 values. Runtime code does not import the full-resolution PNGs or the parked hero/position artwork.

For the two visible decorations in an empty mobile form: **56.5 kB at DPR 1 versus 3.07 MB previously** (98.2% less); about **182 kB at DPR 2** (94.1% less). Account's mobile decoration is 7.1 kB / 21.6 kB at DPR 1 / 2 instead of 1.27 MB. These are asset-byte comparisons, not total page-weight claims. Separate 2× screenshots and selected-source assertions check that delivery is sharp enough for its CSS slot in both themes. No lossy color/alpha encoding or visible matte is introduced.

## Validation and evidence — first batch

Final standard gate, including the post-review composition corrections: **passed in 254.17 seconds** — 397 domain/tooling tests, 465 workerd/database tests and 81 Chromium browser tests; zero skipped or flaky. Formatting/lint, strict TypeScript, generated schema/publication guards, contracts, registry, SQL/OpenAPI, client/Worker builds and package-link checks also passed.

Final expanded engine gate: **30/30 passed in 220.36 seconds**, zero skipped/flaky, across Chromium, Firefox and WebKit. The 24 width/theme/engine layout cases checked **312 captured states with zero horizontal overflows or page JavaScript errors**, including explicit empty-illustration aspect-ratio/frame-height assertions. The evidence contains 330 matrix screenshots, plus 40 fresh normal-input/worst-case captures and the comparison boards. `artifacts/visual-pass/summary.json` records the results and 2× asset choices.

- Standard gate: `npm run verify`, including the original Chromium virtual-passkey journeys and the new keyboard/layout regressions. Receipt/log: `artifacts/visual-pass/verify.json` and `verify.log`.
- Expanded gate: `npm run test:journey`, Chromium 156.0.8078.4 / Firefox 157.0 / Playwright WebKit 27.2 on Linux, at **320, 390, 768 and 1280 px in both themes**. Receipt/log: `artifacts/visual-pass/browser-matrix.json` and `browser-matrix.log`.
- Matrix screenshots, ARIA snapshots, contrast/reflow/image-source evidence and 2× delivery checks: `artifacts/visual-pass/screens/`. States cover landing, recovery, empty/populated saved readings, Account, empty/attached forms, processing, photo/drawn details, expanded sources and reflection editing. Long questions and filenames are exercised. CSS 200% reflow probes cover reading and Account.
- Fresh normal-input captures: `artifacts/visual-pass/comparison-inputs/`. Same-input previous/current boards and concept/current crops: `artifacts/visual-pass/comparisons/`. Board metadata records native dimensions, source crops and proportional scaling; no vertical stretching. The prior evidence under `artifacts/spread-design/` is retained, not overwritten.
- Additional `new-unbroken-*` captures exercise a 500-character unbroken question and a filename with a 240-character unbroken stem, at all four widths and both themes, without starting another reading.
- Capture scripts: `artifacts/visual-pass/capture-comparisons.ts` and `compare.py`. The normal-input capture checks the real backend is synthetic before creating a test account. Live-notice and two-passkey responses are screenshot-only fixtures; they do not establish real recognition or physical-passkey behavior. The original illustrative photo fixture is unchanged.

No copy in `src/contracts/product-copy.ts` was changed. Automated assertions compare full accepted content and sources, verify keyboard focus/live-region semantics, preserve the uploaded reference through reflection saving, and check that return/history reopening creates no additional Start. Normal captures record only the expected initial unauthenticated 401, with no page JavaScript errors, CSP violations or horizontal overflow.

Verification is isolated because a personal instance occupies 8787 and the working checkout contains local configuration. Test snapshots omit dotenv/dev-vars files; only their loopback harness origins move. `src/` must match the working app byte-for-byte. Firefox/WebKit UI tests use an isolated HTTPS proxy with unchanged Secure/HttpOnly/SameSite cookies and Chromium-provisioned synthetic sessions. This is not hosted-origin/RP qualification. See [`docs/BROWSER_QUALIFICATION.md`](docs/BROWSER_QUALIFICATION.md).

The first batch's `artifacts/visual-pass/source-comparison.json` recorded all **145 `src/` files identical** to its verified snapshot. Its `final-source-audit.json` also checked 129 harness files with explicit loopback-port substitutions; the current increment's audit is recorded above. `production-assets.json` confirms no full-resolution illustration PNG, parked hero/position art or synthetic photo fixture was bundled. Verification ran on isolated port 8792, the engine matrix on 8791/8843, without relaxing any test timeout. After a previous concurrent run hit a tooling timeout, the final timing-sensitive domain stage ran alone; the independent matrix overlapped only later stages. The personal server on 8787 was not stopped or reconfigured; no hosted deployment was performed.

## Coverage gaps — still open

- **Actual Safari/macOS/iOS, physical phones/tablets, native file pickers and keyboard viewport behavior:** not available here. Linux Playwright WebKit is engine coverage, not Safari/device evidence.
- **Physical/synchronized passkeys and successful Firefox/WebKit ceremonies:** not tested. Full virtual ceremonies run only in Chromium; Firefox tests synthetic cancellation recovery. This WebKit build lacks the credentials API and tests its unsupported-browser error. No physical-authenticator claim is made.
- **VoiceOver/NVDA listening and browse/form-mode order:** not run. Keyboard tests and ARIA snapshots validate semantics, not spoken output or assistive-technology usability.
- **Safari/Firefox native zoom / OS text enlargement / mobile text scaling / real Windows contrast themes:** still open. Headless Linux Chromium native 200% zoom and Chromium/Firefox forced-colors emulation are now exercised separately from the original CSS-zoom probes; neither closes these other platform combinations.
- **Hosted release, exact production origin/RP ID and live-provider recognition:** outside this frontend batch.

Manual device/AT results must be recorded and any functional/accessibility failures fixed before the next product increment. These gaps are not marked passed or silently converted into skipped tests.

## Separate milestones

[`docs/design/README.md`](docs/design/README.md) separates supporting-screen refinement from product work. Four proposed design/acceptance specifications are written, with no feature implementation:

1. [Dated revisit notes](docs/design/dated-revisit-notes.md).
2. [Selected-context preview, permission and revocation](docs/design/selected-context.md).
3. [Follow-up readings tied to an exact saved parent](docs/design/follow-up-readings.md).
4. [Legacy import preview, validation, duplicates and partial-failure recovery](docs/design/legacy-imports.md).

<details>
<summary>Previous integration QA — historical record, not the current acceptance result</summary>

## Spread-photo and Account design pass (previous batch)

final result: passed

No actionable P0/P1/P2 findings remain in the priority photo-attachment and dedicated Account layouts. The original content and retention disclosures remain authoritative. This is an integration into the existing application, with the concepts as visual guidance, rather than a reproduction of the shortened illustrative copy.

## Visual targets and evidence

The source images are the owner's attached concepts at:

`/tmp/codex-remote-attachments/01a19356-2df3-7281-8fde-4a3dc8822175/6B83CCBB-3C27-40DB-B367-6B5B0CEE8AB3/`

- `4-Photo-4.jpg`: photo attached, question populated, English and reversals checked; desktop and mobile.
- `2-Photo-2.jpg`: dedicated Account, AI off, two illustrative passkeys, dark mode.
- `1-Photo-1.jpg`: original spread above position sections and a reference thumbnail in the reflection editor.
- `3-Photo-3.jpg`: exactly three abstract cards, used as the source for the transparent production asset.

Browser evidence lives under `artifacts/spread-design/screens/`. Same-input, side-by-side comparison boards are under `artifacts/spread-design/comparisons/`:

- `new-desktop.png` and `new-mobile.png`: complete new-reading panels.
- `account-desktop.png` and `account-mobile.png`: complete Account panels.
- `passkeys-mobile.png`: focused passkey names, metadata, removal and addition controls.
- `reflection-mobile.png`: focused reference image, authored writing, stance, disclosure and save controls.
- `reading-desktop.png`: structural comparison of the photo and three position sections. The synthetic interpretation and unsaved state differ from the reference's illustrative saved reading, so text length and overall height are not pixel-fidelity targets.

Screenshots use Chromium, CSS viewports 1280 × 1000, 390 × 1000 and 320 × 1000, deviceScaleFactor 1. Full-page screenshots extend beyond viewport height. The supplied design boards are 1280 × 853 pixels; their frames are cropped before comparison. Implementation panel captures are scaled proportionally to the matching source panel width, without vertical stretching. Device chrome and the reference board headings are excluded. Source CSS density is unknown because these are composited concept boards; no pixel-exact claim is made.

Implementation panel pixels (also CSS pixels at DPR 1): new reading 1040 × 887 at desktop, 350 × 1390 at 390 px, and 280 × 1472 at 320 px; Account 940 × 1278 at desktop, 390 × 1673 at 390 px, and 320 × 1803 at 320 px; focused passkeys 350 × 392; reflection editor 350 × 748; accepted reading 720 × 1456. Comparison images scale these proportionally to their source crop widths.

Source crops (x, y, width, height): new desktop (38, 147, 877, 680); new mobile (935, 142, 308, 685); account desktop (85, 127, 781, 698); account mobile (888, 81, 308, 745); passkeys mobile (905, 296, 278, 282); reflection mobile (906, 143, 336, 570).

## Comparison history and fixes

1. First rendered review found mobile title/art overlap (P2) and low-contrast dark destructive text (P1). The existing destructive color measured 3.29:1 on the account card. The mobile ribbon was moved into its own space above the heading, and destructive text now uses a lighter coral mix, measuring 5.61:1 on the same surface. The light destructive color remains 6.37:1. These fixes are visible in the final `new-mobile.png` and `passkeys-mobile.png` boards.
2. A follow-up found that the first mobile ribbon adjustment clipped too much artwork (P2). The final image uses `object-fit: contain` in a 140 × 50 slot, keeping the entire ribbon separate from the title. Account tool buttons become flat rows on mobile; desktop retains the paired outlined controls. The header and footer widths align with their respective page columns.
3. Final comparison re-opened both source and implementation together. No heading overlap, horizontal overflow, cropped user photograph, inaccessible removal action or missing disclosure remains. Mobile widths of 320 and 390 px and desktop width 1280 px were checked. The photograph uses `object-fit: contain`, preserving all three cards and any portrait image boundaries.

## Required fidelity surfaces

- **Typography:** Uses the established locally hosted Newsreader display headings, Figtree body text and existing Fluent UI icons. Serif account section headings and the new-reading headline follow the concepts. Longer source copy and existing question help remain visible. The reading title keeps the application's responsive wrapping.
- **Layout:** Desktop photo form and notices use two columns; mobile follows question → photo → controls → options → complete notices → Start. The Account page has Back to readings, AI permission, passkeys, account tools, sign-out and deletion in separate groups. A photograph and its filename/actions have a clear boundary from decorative artwork.
- **Colors:** Retains the application's established Solstice cream/teal light and dark tokens. It deliberately does not replace the entire product palette with colors sampled from compressed mockups. Small dark destructive labels now exceed 4.5:1. Body muted text measures 5.67:1 in light and 6.54:1 in dark on their card surfaces.
- **Images:** New raster artwork was generated with built-in ImageGen from the owner's references. Actual PNG files are RGBA: ribbon 2172 × 724, account sprig 1945 × 809, three-card illustration 1983 × 793. Transparent backgrounds were verified and inspected on rendered light/dark surfaces. No custom decorative SVG or CSS drawing replaces the botanical images. The photo fixture is illustrative test data and is excluded from the application bundle.
- **Copy/content:** `src/contracts/product-copy.ts` is unchanged. Full Meta/OpenAI processing and retention disclosures remain visible before submission and in Account, including on mobile. The reference's condensed mobile notices are not substituted. Passkey session-invalidation, encryption, temporary storage and unsaved-draft copy is preserved. Recognition output and interpretation are never inferred from decorative artwork.

## Interactions and accessibility

Browser captures exercised account navigation, enabling AI, selecting a file through the Choose photo button, both reading options, starting a synthetic reading, and editing the reflection. Regression coverage checks photo replacement/removal, pending reads, account navigation with unsaved photos/questions/reflections, passkeys, recovery, sign-out, export and deletion. Removal restores keyboard focus to Choose photo. The button's accessible description includes the full photo-processing notice.

The added reflection reference uses the accepted reading's existing image. A browser test saves a reflection and confirms that the reference remains the same and no additional Start request occurs.

`artifacts/spread-design/screens/evidence.json` records no page JavaScript errors and no horizontal overflow in the captured states. The only console error was the expected unauthenticated `/api/v1/me` 401 when the test first opened the signed-out page. Screenshot-only health and passkey responses are explicitly documented in the capture script; the backend remains synthetic throughout. No live provider recognition accuracy is asserted.

## Accepted differences and follow-up polish

- Full disclosures, development notices, question guidance and actual generated interpretations make pages taller than the concepts. The application retains navigation and its existing saved/unsaved behavior.
- The existing Fluent icon library and theme tokens are retained, including the primary button shade, rather than adding a second product-wide design system.
- The mobile header uses a small complete ribbon instead of a bespoke leaf-only crop (P3). A later illustration pass could produce a dedicated corner asset.
- The reading photo remains above all positions. Its synthetic cards and interpretation differ from the illustrative photo; this is a layout check, not recognition evidence.

Implementation checklist: complete. The full `npm run verify` gate passed in 184.59 seconds: 397 domain/tooling tests, 465 workerd/database tests, 69 browser tests, formatting/lint, TypeScript, generated contracts, SQL/OpenAPI checks, client/Worker builds and package links. Zero tests skipped. Evidence is in `artifacts/spread-design/verify.log` and `artifacts/spread-design/verify.json`.

Verification ran in an isolated source snapshot on port 8791 because an existing local instance occupied 8787. Test harness origins and the synthetic runtime were adjusted to that isolated port. The snapshot's entire `src/` tree was compared byte-for-byte with the working application after verification; there were no differences. Hosted deployment and live provider evaluation are outside this design pass.

</details>
