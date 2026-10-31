# Follow-up readings — proposed design and acceptance

Status: specification only; follows dated notes and the selected-context preview/permission increment. Not a reinterpretation or mutation of the original accepted reading.

## Screens and behavior

- **Ask a follow-up** is available from a saved reading. The composer names the exact saved parent's question, date and edition, shows its original three-card draw and labels the new question as a follow-up. No implicit “latest reading” lookup.
- The original draw/orientations and approved source snapshot are reused; no new draw or replacement photograph is implied. A person wanting a new draw uses the existing new-reading flow.
- Additional reflection/revisit context starts unselected and goes through the separate preview/permission flow. Display allowance use and the full provider/storage disclosures before submission.
- Progress, lost acknowledgement, cancellation, refusal, failure and completion use the current single-request lifecycle. The result is a new accepted child with an exact parent edition ID and a **Back to original reading** link, not an overwritten parent.
- Saving the child and writing its reflection are explicit. Parent and child remain distinguishable in history and export; reopening either makes no new generation request.
- Proposed deletion rule, requiring privacy approval: child accepted content is an independent record; deleting its parent removes any separately retained parent-context excerpt and makes the parent link unavailable, but does not silently delete a separately saved child. Both confirmation and child tombstone must explain this. Account deletion covers the entire family. Do not implement until this policy is approved.

## Acceptance

- [ ] Parent identity is stable across navigation, retries, concurrent newer editions and reload. The server rechecks ownership, saved state and exact edition before dispatch; deleted/unsaved parents block submission with a recoverable draft.
- [ ] A follow-up cannot redraw, mutate accepted parent text, silently add context or exceed allowance through duplicate Start requests.
- [ ] Provenance records the exact parent, reused draw/source versions and acknowledged context snapshots. Child text is clearly labelled as a new AI interpretation, separate from authored notes and traditional sources.
- [ ] A saved child reopens byte-for-byte with AI off. Parent/child navigation preserves dirty-draft warnings, reading-completion focus and history return.
- [ ] Empty/long questions, unavailable parents, revoked context, pending/cancelled/failed requests, unsaved/saved children, and parent/child deletion are covered in both backend and browser tests.
- [ ] Full content, disclosures and parent references remain readable at 320/390/768/1280 px in both themes and enlarged text, with keyboard and assistive-technology acceptance recorded honestly.
- [ ] Approve the data/erasure policy, compare screenshots, run `npm run verify`, and refresh QA before acceptance.
