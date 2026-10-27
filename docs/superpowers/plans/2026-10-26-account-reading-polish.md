# Account and reading polish implementation plan

> **For agentic workers:** Implement inline with the executing-plans workflow. Completed implementation steps are tracked below; the final gate result is recorded in `artifacts/verify.json` and the branch commit in git history.

**Goal:** Implement the user's seven account and reading improvements on `codex/account-reading-polish`.

**Architecture:** Keep accepted readings and domain facts unchanged. Resolve display names from a client catalog keyed by the exact deck hash, containing only names from the current synthetic deck and the launch draft. Share notice rendering and date formatting between the existing client screens.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Playwright, local Cloudflare Worker.

**Spec:** The user's numbered changes 1–7 in this chat.

## Global constraints

- Preserve the canonical fact sentences and reading API contracts.
- Keep local-build wording and simulated interpretations unchanged (item 8 is deferred).
- Preserve the pre-existing README and production/live-AI planning edits.
- Unknown deck versions show their canonical card IDs without borrowing another edition's names.
- Browser plugin is unavailable; use the repository's Playwright workflow.

## Review focus

- An account action must retain the visible workspace, its dimensions and unsaved draft while blocking interaction.
- Failure notices use an alert; confirmations and informational notices use status.
- Card names must match the exact deck version, with a safe fallback for unknown versions.
- Danger buttons must remain red when hovered and retain their existing confirmation controls.
- Saved stance labels must match the editor's options; dates use the same medium format.

### Task 1: Protect the affected account and reading flows

**Files:** `tests/browser/identity-account-controls.spec.ts`, `tests/browser/readings.spec.ts`, `tests/browser/identity.spec.ts`, `tests/browser/request-lifecycle.spec.ts`.

- [x] Add regression coverage for workspace preservation during a paused passkey request, success/error notice roles, matching card metadata and unknown-deck fallback.
- [x] Update the existing sign-out-all selector and conflict stance assertion.
- [x] Run focused browser cases and confirm the expected failures before implementation.
- [x] Update legacy recovery, lost-save and source-inspection expectations for the intentional copy, role and heading changes found by the full suite.

### Task 2: Implement the seven client improvements

**Files:** `src/client/identity.tsx`, `src/client/readings.tsx`, `src/client/deletion.tsx`, `src/client/style.css`; new `src/client/notice.tsx`, `src/client/date.ts`, `src/client/card-names.ts`, `src/client/card-names.json`.

**Interfaces:** `NoticeMessage` carries text plus `error | success | notice`; `Notice` renders the corresponding role/style. `date(value: string, dateOnly?: boolean): string` centralizes formatting. `cardName(deckEdition: string, cardId: string): string | undefined` resolves edition-specific metadata.

- [x] Move the workspace above passkeys and replace its `hidden` attribute with `inert`.
- [x] Classify account/workspace notices, share date formatting and stance labels, and unify sign-out copy.
- [x] Add edition-bound card names beside unchanged basis sentences and capitalize source headings.
- [x] Style the three final destructive actions with a danger class, including hover state.
- [x] Run the focused browser cases and inspect desktop/mobile rendering. The five new/extended cases and three affected legacy cases passed. Playwright QA at 1100×850 and 390×844 confirmed layout, source headings, all three danger buttons and hover states, date formatting, and deletion receipt behavior, with no unexpected console errors.

### Task 3: Verify and finish the branch

- Run the final `npm run verify` and inspect its complete stage results; see the verification receipt for the result.
- [x] Review the diff against changes 1–7, checking notice classifications and deck-catalog drift. Independent read-only review found no actionable issues.
- Commit only this task's files and report the branch, validation and synthetic-name limitation; git history records the resulting commit.
