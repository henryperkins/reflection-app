# Supporting screen concepts implementation plan

> Execute in this session using superpowers:executing-plans. User scope: apply the visual direction to existing screens and document the proposed flows.

**Goal:** Bring the November 1 concept boards into the existing landing and saved-reading screens and record their implications for future personal writing and context selection.

**Architecture:** Refine the current React components and CSS with existing illustration assets. Keep the shared Solstice tokens, local fonts, Fluent icons, navigation handlers, disclosures and reading persistence. Future flows stay in design documentation.

**Tech stack:** React 19, TypeScript, Vite, CSS, Playwright; existing Cloudflare synthetic backend for verification.

**Spec:** The owner's three concept boards and `docs/design/concept-direction.md`; current boundaries in `docs/design/README.md` and `src/client/design/art/README.md`.

## Constraints

- Refined references: Photo 4 (entry/history), Photo 2 (dated notes), Photo 1 (context review). Photo 5 and Photo 3 are earlier variants.
- Preserve Newsreader / Figtree / Outfit, existing Solstice light/dark colors and complete product disclosures. Compressed board colors do not replace tokens.
- Preserve the recent clarity pass: history rows use dates and questions, without decorative record thumbnails; progress and deletion statuses stay free of decoration.
- No new endpoints, storage, generation, permissions, invented history or runtime proposal controls.
- Check 320/390/768/1280 px, light/dark, empty/populated history and long questions. Keep existing physical-device and assistive-technology limitations explicit.

## Review focus

- Account creation, sign-in and recovery remain easy to reach on a small phone.
- The orbit artwork and title motif reserve space and cannot overlap text or controls.
- Reading navigation accurately indicates the current history/new-reading destination.
- Full runtime notices and long reading questions can wrap without clipping.
- A proposal illustration cannot imply that notes or context permission have shipped.

## Task 1: Existing entry and history surfaces

**Files:** `src/client/identity.tsx`, `src/client/readings.tsx`, `src/client/style.css`, `src/client/art.tsx`, `index.html`.

**Interfaces:** Existing `Art` component, identity state and reading navigation handlers. Add an optional `fetchPriority` to `Art`; reuse `account-sprig` at the landing footer. No business logic or API changes.

- [x] Make landing a shared editorial panel: orbit at desktop scale, unboxed content, small botanical footer. Put controls before the orbit on phones/tablets.
- [x] Give the saved-reading title a separate compact illustration slot. Keep record rows free of art, with serif questions and fine rules.
- [x] Give history/new navigation a shared pill with `aria-current="page"` for the actual current destination, preserving ordinary button semantics and handlers.
- [x] Declare both color schemes in HTML and prioritize only the landing focal image.
- [x] Run the existing responsive journey matrix and inspect landing, empty/populated history and long content in both themes. Do not create implementation-mirroring tests for this styling change.

Evidence correction: `tests/browser/journey-layout.spec.ts` and `tests/fixtures/browser-display.ts` now wait for the Saved readings heading after history navigation. Previously their screenshot could combine the old reading's measured page height with the new history's rendered content. This changes capture synchronization, not application behavior.

Receipt preservation: an actual DOM layout probe found that a 100%-height landing card clipped the existing post-deletion receipt (receipt bottom 1349 px, panel bottom 1050 px). Retaining the flexible column and natural card height fixes containment at 320/390/768/1280 px. The existing `tests/browser/privacy.spec.ts` checks now assert complete receipt containment on desktop and phone, including the lost-response case.

Review correction: the current destination lost its visible fill under forced colors. A Chromium regression probe failed against the ordinary token colors. The active navigation now uses system Highlight / HighlightText, including hover. Rendered review then caught a Chromium Canvas backplate obscuring the HighlightText label despite passing computed-color assertions; only the selected button opts out of automatic adjustment, with the user's system colors still supplying all of its colors. `tests/browser/journey-forced-colors.spec.ts` checks the platform's actual selection colors for both destinations at rest and on hover during the existing journeys; rendered captures check the label itself.

## Task 2: Durable concept documentation and evidence

**Files:** `docs/design/concept-direction.md`, `docs/design/concepts/2026-11-01/`, `docs/design/README.md`, `docs/design/dated-revisit-notes.md`, `docs/design/selected-context.md`, `src/client/design/art/README.md`, `design-qa.md`.

**Interfaces:** Existing design/acceptance documents remain the source of proposal status. Store the three refined boards unchanged; link actual implementation captures separately.

- [x] Record the artwork scale hierarchy, font roles, two foundations and existing palette authority.
- [x] Specify the simple Reflection / Account header and original-reflection-first chronology for proposed notes.
- [x] Specify empty context selection, complete dated/revisioned excerpts, quiet × Remove selection, and the boundary at Continue to permission review. Leave final copy and submission rules open.
- [x] Update the placement inventory, link fresh captures and record the real matrix/targeted verification results without closing manual acceptance gaps. The final full gate remains the last step below.
- [x] Review the automatic Impeccable hook output and the full diff. The active hook reported no deterministic findings; the independent reviewer found the forced-colors correction recorded above. No duplicate manual detector run was added.
- [x] Run `npm run verify` after final source changes: passed in 290.65 seconds; 397 domain/tooling, 465 database and 91 Chromium browser tests. The 36-case cross-browser matrix and four final forced-colors cases also passed. All manual/device/provider limitations remain open in `design-qa.md`.
