# Dated revisit notes — proposed design and acceptance

Status: specification only; first product increment after the existing-journey visual batch. No new AI permission is required. Existing reflection editing and revision erasure remain unchanged.

## November 1 visual reference

See [Return, with time](concepts/2026-11-01/02-return-with-time.jpg) and the [shared concept direction](concept-direction.md). Use the refined Reflection / Account header, with no sidebar or hamburger menu. Keep the original reflection above dated notes, separated by fine rules and generous space. The mobile editor orders note text, optional stance, Save note and Cancel. Botanical accents stay outside personal text. The dates, stance labels and excerpts in the board are illustrative; **this flow remains specification only** and the implementation gate below still applies.

## Screens and behavior

- A saved reading keeps its complete accepted interpretation, draw, sources and original reflection. Below the reflection, a chronological **Revisit notes** list shows authored notes with an explicit saved date, stance if supplied, and edit/delete actions.
- **Add revisit note** opens a separately labelled editor with the reading question/date as context. It never replaces the original reflection. An unsaved reading must be explicitly saved before creating a dated note; explain that choice and retention before saving.
- Show empty, editing, saving, saved, failed-save/retry, newer-version conflict, deletion-confirmation and deleted states. Preserve a failed or conflicting draft. Cancel returns focus to the initiating control.
- Persist a stable note ID, exact reading/edition reference, server creation time, update time and revision. Show creation date and an “edited” date separately, using the user's local timezone with a machine-readable timestamp. Never backdate existing reflections or invent a historical revisit date.
- No automatic AI requests or context selection. Notes remain usable with AI off. No automatic storage of private drafts in browser storage.

## Acceptance

- [ ] A person can add two notes on different dates, return later and read them in chronological order without changing any accepted reading text or original reflection.
- [ ] Editing an existing reflection is not presented as creating a dated note. Historical revisions remain distinguishable from dated revisits.
- [ ] Save is idempotent: retry after a lost acknowledgement creates one note, not two. Concurrent edits require explicit reconciliation; stale content cannot silently overwrite a note.
- [ ] Account navigation, browser Back, reload and session expiry follow the established dirty-draft/expiry protections. Save failures keep the editable text in the current session.
- [ ] Each editor/action has an accessible name, keyboard focus is preserved, and save/error/deletion outcomes are announced. Dates are understandable without color or icon cues.
- [ ] Export includes note identity, timestamps, revisions and exact reading linkage. Note erasure and reading/account deletion cover notes, revisions, search/index copies and backup deadlines under the approved retention policy.
- [ ] Approved disclosures describe saved-note retention and service-readable encryption in full. AI-off creation/edit/return, offline failure, conflict, idempotency, ownership and deletion are covered by tests.
- [ ] Review the complete journey at 320/390/768/1280 px, both themes and enlarged text; run `npm run verify` and refresh screenshots/QA.

Implementation gate: approve the note contract, revision/erasure policy, quotas, storage accounting and copy before adding any endpoint or screen.
