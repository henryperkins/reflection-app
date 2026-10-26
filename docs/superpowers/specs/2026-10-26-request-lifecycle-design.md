# Recoverable local reading requests

The approved next integration closes the existing local create → inspect → save journey. The merged architecture and `docs/MILESTONE_2_ACCEPTANCE.md` remain binding. Deployment and live-provider traffic remain disabled; the synthetic writer is not provider qualification.

Start records one encrypted question, draw, request, held allowance and idempotency identity before returning 202. The Worker continues that request with `waitUntil`; status reads never dispatch. Losing the Worker eventually expires unfinished work through existing maintenance. This local continuation is not hosted durable execution evidence.

Cancellation requires ownership, CSRF, the current request revision and an idempotency key. Its atomic transaction fences publication, releases a held reservation once and records STOPPED. A published request returns conflict and retains the accepted reading. Refusal, unavailable writer, uncertain timeout, expiry and revoked consent receive distinct content-free statuses. No automatic provider retry or fallback is introduced.

Read status and events in one database snapshot. Honor `after`, retain a monotonic sequence watermark through event pruning, and include at most 20 ordered events. Emit events with the relevant state transaction, including consent stops.

The browser shows progress independently of a pending submission, polls at 2/4/10 seconds with hidden-tab pause, and can cancel while work continues. A path containing only an opaque intent ID is set before submitting; after acknowledgement it becomes `/requests/:id`. An owned, read-only intent lookup resolves a lost Start acknowledgement after reload without storing question text or automatically submitting a fresh request. In-memory retry retains the original body and key. No result is announced until it is read from the server. Late responses after unmount, cancellation or navigation cannot overwrite another view.

An accepted reading keeps its opaque request path until explicit navigation, so an interrupted Save can be reconciled by reopening the same session. UI headings distinguish the draw, interpretation, reflection prompt, traditional source snapshot and the user's own reflection. Keyboard source expansion and result focus receive browser acceptance.

## Approaches and implementation calls

The author selects the existing D1 request ledger plus Worker continuation and a read-only intent lookup. This preserves the existing guards and avoids a new queue/platform. Retaining the blocking Start handler would prevent timely cancellation and acknowledgement. A hosted durable queue is deferred to its own qualification. Opaque URLs are selected over sessionStorage so drafts and keys remain RAM-only; an unknown intent after reload is reported honestly and cannot recreate missing private input.

Tests use injected intercepted writer outcomes and controlled database barriers at the application service boundary. Browser transport fault injection may delay or lose real responses; no user-facing fixture selectors or special question strings control server behavior.

## Acceptance

Regression evidence must preserve exact saved reading/recovery/consent-off behavior. New evidence covers cancellation before publication and after publication, cross-owner and revision guards, lost Start/Save responses, reload, consent revocation, expiry, refusal and uncertain outcomes, event pruning, and no duplicate dispatch or allowance consumption. All 13 verification stages and one independent whole-branch review are required. Manual assistive technology, physical passkeys, real providers, hosted crash recovery and all other launch gates remain open. The requested Milestone 2 ZIP remains pending until the whole milestone closes.
