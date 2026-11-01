# Reflection concept direction — November 1, 2026

Scope confirmed by the owner: **apply the visual direction to existing screens and document the proposed flows**. This is an extension of the existing Solstice system. The concept text, dates and revisions are illustrative, not actual account data or evidence that a proposed feature exists.

## Reference boards

The three refined boards are saved unchanged with this document:

| Board | Reference | Current application |
| --- | --- | --- |
| 01 — A place to begin. A place to return. | [Entry and saved readings](concepts/2026-11-01/01-entry-and-return.jpg), supplied Photo 4 | Existing landing and saved-reading workflows; visual refinement only. |
| 02 — Return, with time. | [Dated revisit notes](concepts/2026-11-01/02-return-with-time.jpg), supplied Photo 2 | **Proposed, specification only.** [Behavior and acceptance](dated-revisit-notes.md). |
| 03 — Choose what travels forward. | [Selected context](concepts/2026-11-01/03-selected-context.jpg), supplied Photo 1 | **Proposed, specification only.** [Behavior and acceptance](selected-context.md). |

Photo 2 refines Photo 5 by using the simple Reflection / Account header. Photo 1 refines Photo 3 by using that same header and a quiet × **Remove selection** action instead of a destructive trash icon. These refined boards are the visual authority; the earlier sidebar, hamburger menus and destructive removal styling do not carry forward. Proposal status applies to the refined boards even where the older board's separate “Specification only” callout is absent.

## Artwork changes scale with the task

| Context | Artwork role | Implementation rule |
| --- | --- | --- |
| Entry | One large editorial composition | The existing orbit artwork and account controls share a paper panel on desktop. On phones and tablets the controls come first, followed by a short orbit crop. A small botanical footer is reserved for the wide layout. |
| Everyday navigation | A compact recognizable motif | The saved-reading heading uses a separate 112 × 88 px slot on desktop and 72 × 72 px slot on phones. It never sits behind the heading or competes with it. |
| Personal writing | Restrained accents and generous quiet space | Keep decoration beside a heading or outside the writing area. Fine rules organize reflection and chronological notes; artwork cannot imply authorship, a saved date, stance or security state. |
| Context review | Quiet accents in the evening foundation | Complete exact text, provenance and individual remove actions take precedence over decoration. No ornamental crop may hide an excerpt. |
| Progress and deletion | Status leads | Preserve PR #7: no decorative status banners. A result is communicated by its status text and live region. |

The board's small list illustrations are an exploration, not record metadata. **The implementation retains PR #7's date-and-question rows without decorative per-record thumbnails.** The compact title crop carries the visual character without suggesting that an arbitrary picture previews a particular reading. Actual uploaded photographs and recognized/drawn cards remain distinct from decorative art.

All decorative images use empty alternative text, `aria-hidden`, intrinsic dimensions and reserved layout space. Use existing local assets and optimized transparent delivery variants. The orbit has high fetch priority; footer decoration loads lazily. These boards do not justify new image generation, remote asset dependencies or rewriting an original raster.

## Color and type

Warm paper and deep teal remain the light and evening foundations. Mint/sage, coral and butter-yellow connect the artwork across them. Preserve the semantic Solstice values in [`tokens.css`](../../src/client/design/tokens.css); do not sample replacement UI colors from compressed JPEG boards. Input, focus and destructive states retain their verified contrast colors. Both themes follow the system preference, including native browser controls.

Newsreader carries questions and reflective headings. Figtree carries body text, labels and actions; Outfit remains the brand and existing utility heading face. Questions in saved-reading rows use Newsreader while dates stay small, legible sans serif. Use the current Fluent icon family, full-size controls, fine rules and the existing spacing/radius tokens. No new sidebar or menu is implied by these concepts.

History and new-reading navigation share a quiet pill. Only the active destination is filled and marked with `aria-current="page"`; these remain ordinary navigation buttons, not ARIA tabs. Existing navigation, dirty-draft protections and AI-off restrictions still apply.

## Proposed personal writing

[Dated revisit notes](dated-revisit-notes.md) keep the original reflection above a chronological list of later observations. A list entry shows its actual saved date, optional stance and edit/delete actions. The separate mobile editor puts note text first, optional stance second, then Save note and Cancel. Use the simple Reflection / Account header and a small botanical accent outside the text area.

The board's short excerpts and dates are examples. Save/retry, conflicts, revision dates, draft protection, export, erasure and retention still require the full acceptance specification. Existing reflection editing is not a dated revisit note, and no dated-note UI or persistence is introduced by this visual pass.

## Proposed context selection

[Selected context](selected-context.md) has two distinct states: empty selection, then review after an explicit selection. Start with nothing selected; disable Review selected context until at least one eligible item is selected. Review shows each **complete exact excerpt**, author type, question, saved date and exact revision. Never replace full text with a summary, line clamp or count alone.

Use a quiet × icon with the visible label **Remove selection**. It removes an item from the pending request; it does not delete the saved writing. Actual deletion remains a separate action with its own confirmation and retention disclosures. The remove control needs an accessible name that identifies its item when several excerpts share the same question.

The visual concept ends at **Continue to permission review**. It is not Send, an authorization acknowledgement or a completed provider submission. Final recipient/purpose/retention wording, item and byte limits, submission rules, photo policy, ownership/revision checks and dispatch/revocation semantics remain open under the existing implementation gate. The evening theme is a visual option, not evidence that selection or permission is enabled.

## Verification and boundaries

Use the existing 320/390/768/1280 px, two-theme browser matrix, including empty/populated history and long questions. Preserve actual runtime notices and all security, retention and transmission copy even where it makes the app taller than a board. See [`design-qa.md`](../../design-qa.md) for the executed checks and implementation screenshots. Composited boards are visual guidance, not a pixel-exact application specification.

This frontend pass does not close physical-device, real-passkey, screen-reader, hosted-origin or live-provider acceptance gaps. Neither proposed flow is implemented or approved by these images.
