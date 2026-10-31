# Journey milestones

The current implementation batch is **existing-frontend steps 1–3 only**: functional/accessibility corrections, mobile hierarchy and reading composition, and essential illustration delivery. It does not add data models, routes, permissions or generation behavior.

## Next visual increment: supporting screens

Start with landing and saved readings, then recovery/replacement/recovery-kit and progress/outcome states. Use the placement inventory in [`src/client/design/art/README.md`](../../src/client/design/art/README.md). Keep Newsreader/Figtree/Outfit, Fluent icons and the Solstice light/dark tokens. Do not replace the current palette just to sample compressed concepts.

Acceptance: the same 320/390/768/1280 px, two-theme matrix; empty/populated history and long questions; all recovery warnings/codes and progress outcomes; no decorative art mistaken for a user photograph, recognized card or security status. Extend the existing evidence harness and update `design-qa.md`, then run `npm run verify`. No illustration-only change closes the physical-device or assistive-technology gaps.

## Product increments — specification before implementation

1. [Dated revisit notes](dated-revisit-notes.md): extend read → save → reflect → return without a new AI call.
2. [Selected-context preview and permission](selected-context.md): explicit, inspectable context and revocation.
3. [Follow-up readings](follow-up-readings.md): exact saved-parent identity, using the context controls above.
4. [Legacy imports](legacy-imports.md): preview, validation, duplicates and recoverable partial failures.

These are separate proposed design/acceptance specifications, **not implemented features**. Each needs product/privacy approval and its own implementation milestone. New persistence requires contract, storage, export, erasure and retention work; none belongs in the frontend visual batch. Each increment must pass the existing verification gate and add targeted tests and comparison screenshots before its QA status changes to accepted.
