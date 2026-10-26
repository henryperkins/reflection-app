# User journeys, client state and HTTP behavior

Routes below are browser routes; API paths have `/api/v1` prefix. Generated interpretation, factual basis, traditional sources and personal response have distinct headings and semantics, not just colors. No visual brand is required. Exact schema names are in DOMAIN_CONTRACTS; [openapi.yaml](openapi.yaml) lists every operation.

## State ownership

Server owns identity, ownership, permission revisions, grants, request lifecycle, accepted editions, saved status and reflection revisions. Client owns current form text, expanded basis panels, focus, pending mutation intent and transient network state. Do not optimistically claim save, publication, consent or deletion completion. Query cache lives in RAM only and is keyed by subject plus resource; it is cleared before switching subject. Form drafts never enter URL/query strings, logs, analytics or persistent web storage. Only an opaque draft intent ID may enter sessionStorage.

Components: `AppShell` (auth/focus/nav), `QuestionForm` (bounded question, reversals, English confirmation), `PermissionNotice`, `RequestProgress`, `ReadingArticle`, `BasisPanel`, `SourceExcerpt`, `ReflectionEditor`, `SaveStatus`, `HistoryList`, `RevisitForm`, `ContextSelector`, `ImportPreview`, `PrivacySettings`, `RecoverySetup`. Client API wrapper parses responses with Zod, maps error codes and maintains ETag/If-Match and idempotency keys. Services never receive the user subject from form fields.

## Routes and states

| Route / journey | States, actions and recovery |
|---|---|
| `/sign-in`, `/recover` | Explain passkey and code recovery without collecting email. Loading disables duplicate factor actions but keeps Cancel. Generic authentication error avoids enumeration. Password-manager/cross-device passkeys work through platform UI. Recovery grants only credential replacement; no private view until complete. Missing factors show honest recovery limit. |
| `/setup` | Show recovery codes once, copy/download only by explicit action, then acknowledgement. Model use remains off until separate permission notice accepted. No reading persists until setup acknowledgement; demo is synthetic/local. Codes lost before acknowledgement: reauthenticate and rotate, never fetch old plaintext codes. |
| `/new` | Empty question form, default reversals off. Show three position names and “reflection, not prediction”. Draft is RAM only. English confidence unknown prompts confirmation; clearly unsupported language offers rewrite or a RAM-only private draft with explicit local copy/download; no server save without a reading. Start shows exact current question/context transmission preview and temporary-storage notice. Cancel before submit discards draft; after submit invokes cancellation service. |
| `/requests/:id` | Loading → queued/preparing/writing/checking/template → accepted or terminal. Announce one polite live-region status per change, no spinner-only communication and no fake progress %. Poll2s, backoff4s/10s, pause hidden; resume fetches current state/events. Network failure is “connection lost; work may continue”, not a new start. A repeated button uses same intent/key. Cancelled/expired/blocked have distinct copy and safe new-session action. |
| `/sessions/:id` | Fetch session then exact edition. Generated reading immediately persists as an **unsaved 24-hour recovery record**; say “Save to keep”. Empty reflection invites own response including disagreement. Reading remains visible while editor saves. Saving a reflection atomically marks session saved. Confirm saved timestamp and revision only after response; rejected/interrupted save retains RAM draft. |
| `/readings/:editionId/basis` | Exact draw/position/orientation/counts and source text/edition; textual card identity works with no image. Heading distinguishes “Drawn facts”, “Traditional interpretation” and “Generated interpretation”. Explain source IDs show inclusion, not proof. Close returns focus to invoking button. Old edition switch never calls model. |
| `/history` | Completed v1. Empty: start or import. Keyset load-more with stable order, saved by default; separate unsaved view. No text search box/embedding shortcut. Offline shows explicit unavailable list rather than cached private records. Deleted/withdrawn entries return unavailable tombstone when linked. |
| `/sessions/:id/revisit` | Completed v1. Select exact accepted edition, view unchanged text and earlier authored response, add a new dated note. Reopening alone does not create tracking/revisit records. A disagreement is saved without corrective persuasion. Cancel leaves old record unchanged. |
| `/readings/:editionId/follow-up` | Completed v1. Parent edition pinned and visible. New question; parent text and reflections initially unselected. Explicit eligible sources can be granted, previewed and excerpted. Existing draw reused; “No new draw” shown. Confirm exactly what goes to provider. If grant/source changed, refresh preview and require deliberate resubmit; no silent context substitution. |
| `/context` within follow-up/settings | Eligibility toggle separate from checkbox selection. Show source type, author, exact revision, excerpt and characters. Correct by adjusting range or editing the original reflection (new revision invalidates old selection). Revocation warns it cannot retract previous provider transmissions; erasure removes shared copies through separate action. |
| `/imports` | Completed v1. Local file selection, format/version detection; client divides bounded canonical pages. Upload encrypted preview; show count, source, unknown timestamps/provenance, duplicates/conflicts, authored versus generated fields. Select ready groups and confirm. Partial results per item with safe idempotent retry; invalid groups stay excluded. Never grant provider access during import. |
| `/settings/privacy` | Permission on/off, export, deletion, retention and provider disclosure. Export recent-auth step; progress pages in RAM, conflict restarts without creating mixed file; explicit download only after end. Deletion clearly names account/session/revision and consequence; receipt distinguishes fenced, pending, complete and backup expiry. |
| `/settings/security` | Add/remove passkeys, rotate recovery codes, logout-all; recent-auth challenge. Never show stored code values. Cannot remove last factor through normal credential removal. Shared-device mode blanks hidden private view. |

Every mutation uses an in-flight flag plus idempotency, not button disabling as the sole concurrency control. 409 reflection conflict shows server revision beside the unchanged local draft; user can copy their draft, discard or deliberately merge into a new revision with fresh If-Match. Do not auto-merge prose or silently rerun generation. Missing If-Match is428. On a timeout after save, GET the resource and compare the committed idempotency result/revision before retrying. Navigation away from dirty drafts asks a local discard choice; browser reload can still lose RAM text and the notice must be honest. No private offline persistence is added to “fix” it.

Reading unavailability: a content withdrawal or deletion may replace body with explanation; show retained user reflection independently, with a broken basis link. Do not fetch a replacement edition automatically or make deleted text accessible through export/cache. A provider refusal is “A reading wasn’t produced for this request”; an outage template is labeled as a prepared template. Product quota release and possible provider charges are internal accounting; only user-facing allowance is shown. Do not expose deployment jargon to readers.

## API conventions and representative payloads

Deletion bodies carry client-generated receiptId/receiptToken for lost-response status recovery;202 follows durable independent intent, and backupExpiresBy is null until active erasure completes. All JSON bodies are UTF-8, strict schemas, ordinary limit256KiB; import limit2MiB plus200k-character document cap. IDs are UUIDs except WebAuthn base64url credential IDs and opaque tokens. ISO UTC strings on wire, epoch ms in DB. Unknown resource owner gets404, not403. Authenticated owned erased resource gets410. Errors never include submitted text, SQL, provider body or secrets.

```
POST /api/v1/requests
Idempotency-Key: 54154279-048b-41a7-90bd-7b291ef1a510
X-CSRF-Token: <session-bound token>
```
```json
{"clientIntentId":"10101010-1010-4010-8010-101010101010","question":"What should I reflect on about this change?","languageConfirmed":"en","reversals":false,"permissionRevision":2,"parentEditionId":null,"selection":[]}
```

A start returns202 with request/session IDs and a `RequestStatus`. Follow-up uses the same body with exact parentEditionId, a new intent, and explicit selections. Server checks that `reversals` agrees with reused parent basis; it cannot change the old draw. A selected excerpt is produced by `/context-preview`, never trusted from client text:

```json
{"grantId":"20202020-2020-4020-8020-202020202020","grantRevision":1,"start":0,"end":42,"previewHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}
```

Example safe error:

```json
{"error":{"code":"CONTEXT_CHANGED","message":"Your selected context changed. Review it before starting again.","correlationId":"30303030-3030-4030-8030-303030303030","retry":"refresh_then_retry","retryAfterSeconds":null,"currentRevision":2}}
```

Progress events are ordered request-local integers, not a global user activity feed. `after` is last seen sequence, <=20 per response; clients discard events at or below their cursor and then trust the returned authoritative state. Events expire after7 days; old cursor returns a current state snapshot with nextSequence, not a reconstruction or error requiring regeneration. Each event is committed with its state transition. Cursor authorization is always by current subject, never by cursor possession. Only accepted events contain an edition ID; no candidate prose. Event polling is the chosen progress delivery, so there is no SSE/WebSocket/prose chunk schema.

Retry policy: network/503 → exponential jitter1,2,4,8 seconds, max3 HTTP retries with same key and body, then show recover action; never silently new intent. 429 honors Retry-After. 409 refresh/merge or preview; 401 authenticate then resolve existing intent; 403 obtain permission explicitly; 410 unavailable; 422 language/safety/refusal requires user change, never a loop. Rate rules are authoritative in OpenAPI plus global limits in ARCHITECTURE. Rate counters store daily HMAC scope, expire48h. History/revisits cursors use MAC over owner, filter, createdAt/id and expiry24h; limit default20/max50. Export cursor has a60-minute ticket and exact data revision, not ordinary mutable history semantics.

Service boundary for future MCP: resolve an authenticated, scoped Principal through a future adapter; invoke the same GenerationService/reflection/export/erasure services and return the same discriminated results. No direct SQL, automatic context grants or provider bypass. A future tool approval cannot substitute for stored model/source permission. No MCP transport, OAuth client, tokens or deployment is created in v1.

## Accessibility acceptance

Use [WCAG 2.2 AA](https://www.w3.org/TR/WCAG22/) as acceptance target, not a claim of conformance from axe alone. Semantic headings/landmarks, visible labels/error associations, descriptive button names, and native form controls. Tarot images use card/position/orientation alt text; decoration is hidden; source details are reachable without gestures. All actions keyboard-operable; focus rings at least3:1 against adjacent colors, never obscured by sticky controls. Dialogs trap focus while open, Escape cancels non-destructive dialogs, and focus returns to opener; destructive confirmation names target in accessible description.

Manual journey checks: start with keyboard only; screen reader hears one progress update per state; accepted result moves focus to result heading only on user-initiated completion and never steals focus from active editor; save/conflict/offline/cancel status announced; error summary links to inputs; load-more preserves focus and announces count. At320px and200% text, no horizontal page scrolling or obscured buttons; desktop400% zoom reflows where applicable. Minimum text contrast4.5:1 (3:1 large text), non-text controls3:1, 44px touch targets chosen above AA minimum. Reduced-motion disables card animations; no timed gesture or color-only state. Test iOS VoiceOver+Safari, Android TalkBack+Chrome, desktop NVDA+Firefox/Chrome and keyboard. Passkey flow must support assistive technology and platform fallbacks; no cognitive puzzle authentication. Any critical inaccessible save/recovery/privacy action blocks real-user rollout.
