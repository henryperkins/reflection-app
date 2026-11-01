# Selected context — proposed design and acceptance

Status: specification only; follows dated revisit notes and precedes follow-up generation. General AI permission and permission for a particular context submission are separate choices.

## November 1 visual reference

See [Choose what travels forward](concepts/2026-11-01/03-selected-context.jpg) and the [shared concept direction](concept-direction.md). The refined board uses the simple Reflection / Account header and two distinct states: empty selection and review of complete excerpts with their saved dates and exact revisions. Use a quiet × **Remove selection**, not a trash icon or destructive color; removing request context does not delete the original writing. The concept ends at **Continue to permission review**, before acknowledgement or dispatch. Final permission wording and submission rules remain open; **this flow remains specification only** and the implementation gate below still applies.

## Screens and behavior

- A context picker starts empty. Eligible saved readings, reflection revisions and dated revisit notes show a question/title, author type, date and exact revision. Never preselect the whole history or a newly edited revision.
- A **Review selected context** screen displays the complete exact excerpts that will be submitted, their provenance, item/size limits and individual remove controls. Selection counts are descriptive, not a substitute for the preview.
- The final submission surface explains recipients, purpose and retention using approved full copy. An explicit context-specific acknowledgement applies only to this request and the displayed content, not future readings. AI-off blocks generation but not inspection/removal.
- Changed, deleted, inaccessible or superseded selections become invalid and require a fresh preview and acknowledgement. Never silently swap in a different revision or truncate a selected excerpt.
- A permission panel lists the pending request's selections and offers **Remove selection** / **Revoke before sending**. After dispatch, explain that revocation prevents future use but cannot retract data already sent to a provider. Reconnect checks the same request instead of resubmitting it.

## Acceptance

- [ ] Network payload content equals the reviewed, acknowledged snapshot exactly; no unselected reading, note, stance, filename or photo is included. Photo sharing needs a separately explicit preview/choice.
- [ ] Server checks ownership, exact revisions, approved limits, general AI consent and the per-request acknowledgement again at dispatch. A stale preview fails closed and leaves the draft available.
- [ ] Removing/revoking context before dispatch cancels its use across retries and reconnects. Revocation races have observable, accurate “not sent” versus “already sent” outcomes, never a misleading zero-retention claim.
- [ ] Turning off AI or losing access cannot cause automatic retry with older consent. Permission records contain only the minimum audit data and follow an approved erasure/retention policy.
- [ ] Full excerpts and recipients remain readable on mobile and with enlarged text; keyboard users can select, preview, remove, cancel and submit; announcements identify the changed selection without reading unrelated private content.
- [ ] Tests assert exact outbound fields, ownership/revision failures, deletion and consent races, no unintended provider call, idempotent retry, export/erasure and session expiry.
- [ ] Review 320/390/768/1280 px in both themes, compare screenshots, run `npm run verify`, and update QA before implementation acceptance.

Implementation gate: approve context categories, byte limits, photo policy, dispatch/revocation semantics and provider disclosures. A checkbox alone does not satisfy this design.
