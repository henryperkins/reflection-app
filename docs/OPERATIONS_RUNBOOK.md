# Operations and incident procedures

These procedures accompany local implementation. Hosted alert delivery, backup availability, resource isolation and response-time targets remain unverified. They are separate from the local source delivery.

## Content-free maintenance signals

Scheduled maintenance emits `maintenance_health` after completing identity, generation, erasure and retention work. Fields contain only counts, oldest ages and aggregate micro-USD amounts. No account/request IDs, questions, ciphertexts, provider response text or recovery material is selected for telemetry. Errors emit `maintenance_failed` without the caught exception's payload.

| Signal | Trigger | Operator action |
| --- | --- | --- |
| `GENERATION_BACKLOG` | At least 100 unfinished requests or oldest age over 60 seconds | Disable new generation, inspect scheduler/runtime availability, run bounded recovery. Preserve existing saved-content access. |
| `SECURITY_LAG` | Unapplied security operation older than five minutes | Preserve write fences; check independent recovery storage and retained keys. Replay the operation through the existing maintenance service. |
| `ERASURE_LAG` | Incomplete deletion older than 24 hours | Preserve immediate logical erasure, repair the independent ledger/store dependency, retry bounded erasure, confirm receipts. Never erase a pending intent to silence the alert. |
| `PROVIDER_COST_UNKNOWN` | At least one unknown cost reservation | Keep the full reserved liability. Reconcile against verified provider usage/account billing; a timeout or local quota refund is not evidence of zero cost. |
| `SPEND_LIMIT` | At least $10 daily or $100 monthly committed spend | Keep dispatch disabled; confirm limits and reconcile actual liabilities before any separately authorized change. These are technical defaults, not an owner-approved production budget. |
| `maintenance_failed` | Scheduled work throws | Check the content-free failure count and dependency health. Do not print database exceptions or private rows into monitoring. |

Hosted monitoring must also detect **absence** of the minute heartbeat; absence of log entries does not mean zero backlog. Before production, prove delivery of a synthetic alert to the chosen operator, acknowledgement, and recovery. This repository does not configure a notification recipient or send external messages.

## Generation incident

Use the supported system-state generation switch to deny new dispatch/publication, keeping ordinary saved-reading, reflection, export and deletion routes available where the incident permits. Do not redeploy older data, delete readings, clear financial reservations, enable template bypass of consent or replay provider dispatches. Preserve the current database and immutable recovery objects for diagnosis. Recover only local durable work; an already authorized external call must never be sent again.

## Privacy or key incident

Establish the persistent offline/restore fence before recovery work. Preserve all earlier keys and independent recovery objects. Follow [the restore runbook](LOCAL_RESTORE_RUNBOOK.md) and [cleanup runbook](LOCAL_CLEANUP_RUNBOOK.md); a successful local cleanup is not proof that hosted backups expired. Keep the system offline on missing keys, invalid chains, missing independent targets, or unknown source inventory.

The local key-rotation operator validates explicit current/candidate key files and supports add-only keyring transitions and envelope rewrapping. It does not authorize retirement of keys needed by external backups or rewrite all account record DEKs. Use `npm run key:rotate -- --help` and its documented check/rewrap commands. Keep key files outside the checkout and out of command arguments; the operator produces redacted receipts. Do not reuse the published synthetic fixture secrets for a hosted environment.

## Deletion delay

Confirm the record is already logically inaccessible through authenticated read/export paths. Check that its independent target and incomplete pass remain recoverable. Repair storage access and run the existing bounded maintenance/replay path. Confirm completion through the receipt and registry-aware erasure checks. Describe actual active-store and backup deadlines; do not assert hosted erasure based solely on the local test report.

## Restore drill

Use synthetic data and stop ingress/egress first. Save a marker, take a bookmark, remove a credential, spend a recovery code, revoke AI permission, delete the marker and record the receipt. Include a request admitted before dispatch. Restore the earlier bookmark, replay independent security/erasure state, and prove: marker absent from reads/export/copies, removed factor and used code rejected, permission off, no redispatch, and spend not reset. Repeat with independent storage unavailable and confirm the system stays closed. Measure the actual loss interval and elapsed recovery time. Record backup inventory, operator exclusion and retained-key requirements with the evidence.
