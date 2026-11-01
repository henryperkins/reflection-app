# Dated revisit notes — implementation and local acceptance

Status: implemented under the November 1 approval, with synthetic local qualification recorded in the [dated-note verification record](../verification/2026-11-01/dated-revisit-notes.md). Migration 0017 and the feature have not been deployed. No new AI permission is required.

## November 1 visual reference

See [Return, with time](concepts/2026-11-01/02-return-with-time.jpg) and the [shared concept direction](concept-direction.md). Use the refined Reflection / Account header, with no sidebar or hamburger menu. Keep the original reflection above dated notes, separated by fine rules and generous space. The mobile editor orders note text, optional stance, Save note and Cancel. Botanical accents stay outside personal text. The dates, stance labels and excerpts in the board are illustrative; the implemented flow follows the approved contract, with the full factual disclosure retained.

## Screens and behavior

- A saved reading keeps its complete accepted interpretation, draw, sources and original reflection. Below the reflection, a chronological **Revisit notes** list shows authored notes with an explicit saved date, stance if supplied, and edit/delete actions.
- **Add revisit note** opens a separately labelled editor with the reading question/date as context. It never replaces the original reflection. An unsaved reading must be explicitly saved before creating a dated note; explain that choice and retention before saving.
- Show empty, editing, saving, saved, failed-save/retry, newer-version conflict, deletion-confirmation and deleted states. Preserve a failed or conflicting draft. Cancel returns focus to the initiating control.
- Persist a stable note ID, exact reading/edition reference, server creation time, update time and revision. Show creation date and an “edited” date separately, using the user's local timezone with a machine-readable timestamp. Never backdate existing reflections or invent a historical revisit date.
- No automatic AI requests or context selection. Notes remain usable with AI off. No automatic storage of private drafts in browser storage.

## Acceptance

- [x] A person can add two notes on different dates, return later and read them in chronological order without changing any accepted reading text or original reflection.
- [x] Editing an existing reflection is not presented as creating a dated note. Historical revisions remain distinguishable from dated revisits.
- [x] Save is idempotent: retry after a lost acknowledgement creates one note, not two. Concurrent edits require explicit reconciliation; stale content cannot silently overwrite a note.
- [x] Account navigation, browser Back, reload and session expiry follow the established dirty-draft/expiry protections. Save failures keep the editable text in the current session.
- [x] Each editor/action has an accessible name, keyboard focus is preserved, and save/error/deletion outcomes are announced. Dates are understandable without color or icon cues.
- [x] Export includes note identity, timestamps, revisions and exact reading linkage. Note erasure and reading/account deletion cover notes, revisions, search/index copies and backup deadlines under the approved retention policy.
- [x] Approved disclosures describe saved-note retention and service-readable encryption in full. AI-off creation/edit/return, offline failure, conflict, idempotency, ownership and deletion are covered by tests.
- Final-source journey review at 320/390/768/1280 px, both themes and enlarged text, full verification and refreshed captures: execution status is recorded in the source-bound receipt linked above.

The owner approved the note contract, revision/erasure policy, limits, storage accounting and copy on November 1. Checked items describe automated synthetic local coverage; sampled visual review does not qualify physical devices or screen readers. Production activation remains separate.

## Implemented limits and retention

New text is 1–2,000 Unicode code points, with a non-whitespace character, preserved without trimming or normalization. Omitted stance becomes `unspecified`; other values are `resonates`, `unsure`, and `disagree`. Each exact reading edition admits 100 active notes; each note admits 100 saved revisions including creation. Earlier revisions remain until whole-note, reading or account deletion; there is no individual historical-revision deletion control. Existing notes survive editorial withdrawal.

Notes require an explicitly saved parent. Active notes prevent unsaving, while whole-reading deletion remains available. Legacy notes retain their authenticated identity/date and the original unsaved parent's expiry; migration never silently saves a parent. Valid legacy blank notes remain readable/exportable, while new blank writes are rejected. Pagination is ascending `(createdAt, id)`, default 20/max 50, with owner/authentication-epoch/edition/order-bound cursors.

The existing 20 MiB admission estimate counts encrypted UTF-8 bytes plus 1 KiB per owned row, including retained revisions and tombstones. Reads and deletion remain available at capacity. Automatic resubmission stops after the existing seven-day idempotency window; reconcile saved state and deliberately choose a new intent. Offline drafts remain in memory only. Initial list failures stop the loading state and offer an explicit retry without implying an empty list.

The approved disclosure is sourced verbatim from `REVISIT_PRODUCT_COPY.disclosure` in `src/contracts/product-copy.ts`. Original readings, sources and reflections are preserved. Notes work with AI off without provider calls, context grants or generation quota use. See the [operations compatibility boundary](../OPERATIONS_RUNBOOK.md#dated-revisit-notes-migration-0017).
