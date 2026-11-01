# Legacy imports — proposed design and acceptance

Status: specification only; scheduled after dated notes, selected context and exact-parent follow-ups. No import button, parser or persistence is added by the current frontend batch.

## Screens and behavior

- **Choose legacy export** describes the explicitly supported formats/versions and size limits. Parse as untrusted data, not executable HTML or instructions. Never infer a supported format from a filename alone.
- **Preview and validate** shows record counts, original dates (or “date unavailable”), text, draw/source provenance, unsupported fields, errors and duplicates before any write. Unknown card/source formats remain labelled as imported, not approved native meanings or freshly recognized cards.
- Allow explicit selection of valid records. Invalid records remain excluded with row-specific reasons; no silent repair, truncation, invented dates or AI-generated replacement content. Do not import credentials, recovery codes, provider keys or account identity.
- Duplicate review distinguishes exact duplicates from similar questions with different text/dates. Default exact duplicates to **Skip**. Never overwrite a saved native reading or reflection; an explicit keep-both choice creates a separately labelled imported record only where the approved format permits it.
- **Import progress/result** shows saved, skipped, invalid and failed counts. Successful records stay saved; a retry targets only failed records. A downloadable non-sensitive result/validation report identifies source record positions and reasons, not private text by default.
- Interrupted imports have a scoped batch receipt and resumable status. Reconciliation, not re-upload guessing, determines whether a record committed. Removing a batch is an explicit reviewed deletion action, not an automatic rollback of unrelated work.

## Acceptance

- [ ] The supported schema/version matrix, field mapping, encoding, timezone rules, payload limits and private-field denylist are frozen before implementation.
- [ ] Validation does not write records or contact AI/recognition providers. A file containing invalid/malicious markup, over-limit text or unsupported nested fields cannot execute content or bypass validation.
- [ ] Exact-duplicate identity is deterministic and account-scoped, based on approved canonical content/provenance rather than question text alone. Repeated uploads and lost acknowledgements cannot duplicate committed records.
- [ ] A mixed valid/invalid/duplicate batch displays accurate counts; partial write failures and cancellation preserve successes and retry only unresolved records. No pre-existing content is overwritten.
- [ ] Imported notes retain their original dates only when verified by the format. Missing dates, missing source rights and unresolved parent links stay explicit. Native/imported provenance is visible in detail, history and export.
- [ ] Ownership, quota/storage accounting, complete exports, deletion/backup expiry, retention of uploaded raw files and batch receipts, and cleanup after failure have approved contracts and tests.
- [ ] Keyboard users can choose a file, inspect errors, resolve duplicates, confirm, cancel and resume; progress and row errors have accessible announcements. Long filenames and large previews reflow at 320/390/768/1280 px, both themes and enlarged text.
- [ ] Compare success/error/recovery screenshots, run `npm run verify` with new parser/database/browser coverage, and refresh QA before acceptance.
