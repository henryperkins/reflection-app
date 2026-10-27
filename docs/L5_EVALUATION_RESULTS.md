# L5 evaluator implementation and live smoke

Implemented in the existing `codex/terra-model-policy-migration` worktree. The evaluator
is a CLI-only tool; application provider qualification and production activation remain
pending. Usage and limits are documented in [evaluation/README.md](../evaluation/README.md).

## Fixed corpus and authorization

The staged corpus has 240 synthetic cases in grouped 60%/20%/20% splits: 80 must-accept,
80 adversarial, 40 non-reading, and 40 lifecycle/privacy/import contract sequences.
The baseline manifest schedules 200 generation slots; input admission currently allows
160 and blocks 40. The lifecycle entries point to existing offline suites and are not
counted as live generations. Twenty required genuinely human-approved examples are still
missing. Synthetic local source metadata is not editorial approval.

The owner explicitly requested live API testing and supplied a local key and project ID.
The run was bounded to three synthetic development cases, one concurrent call, a $0.12
conservative reservation cap, and no retries. The original API credential file was not
modified. The protected permit binds the project, credential hash, frozen inputs,
authorization expiry and external encrypted archive; the encryption key and permit are
outside the checkout. Project access was checked by a successful model lookup before the
run; that lookup is not proof of project retention settings or production qualification.

## Observed live results

Run date: October 26, 2026, America/Chicago.

- Run ID: `147ed7ab-1e40-4944-963b-9aa65cfe3ff4`.
- Smoke manifest: `857d80233cb25ad0d973c4b8cb37992e880e382c90a2e87716a5dc70ebc293bd`.
- Policy: the existing `gpt-6.1-terra` Standard/30-minute-cache policy.

| Case | Observation | Known usage | Calculated cost |
| --- | --- | --- | --- |
| A01-1: quiet reflection | No HTTP headers/body before the 18-second deadline; uncertain outcome | Unknown | $0.04 reservation retained |
| A11-1: follow-up contract | HTTP 200; candidate passed schema, binding and local safety checks; 4,114 ms | 722 input / 243 output | $0.001937 |
| A16-1: ordinary metaphor | HTTP 200; candidate passed schema, binding and local safety checks; 3,525 ms | 723 input / 235 output | $0.001898 |

The two known receipts report zero cache-read, cache-write and reasoning tokens. Their
calculated cost totals **$0.003835**. Including the uncertain attempt's full reservation,
the journal retains **$0.043835** in liability. These are receipt-based calculations and
conservative liability, not an independently reconciled invoice. Three observations are
not a latency, quality, privacy or cost qualification. No human usefulness scores were
assigned and no application content was activated.

The first attempt's original outcome was recorded as `uncertain/network`: a second
deadline signal in the evaluator raced the shared transport's timer. Its archive timing
shows about 18,023 ms with no returned bytes. A deterministic regression reproduced the
misclassification; the evaluator now leaves the deadline to the shared transport. The
original evidence is retained unchanged. No further paid call was made after that fix.

Resuming the original run was checked with a transport trap: **zero dispatches**, the same
three attempts, and unchanged liability. The uncertain attempt was never resent. Exact
request/response bytes and outcomes are encrypted outside the checkout with integrity
hashes and a 90-day retention deadline. The content-free journal also retains the run-ID
tombstone. Unattended deletion requires the operator to schedule `--purge-expired`.

## Verification

The offline evaluator/package tests cover invalid and expired permits; wrong project,
content and manifest; absent credentials; reused run IDs; call and cost caps; concurrent
reservations and execution locks; actual process kills after reservation and after writer
completion; resume without redispatch; receipt idempotency/conflicts; archive integrity;
90-day cleanup; no private packaging; extracted source digest equality; and the full-body
provider deadline. They run under the existing network deny setup.

Independent review found no blocking implementation defect. Two test coverage gaps were
corrected: wrong-project validation now supplies otherwise complete credentials, and the
response-persistence crash occurs after the writer resolves. The final verification
receipt is generated in `artifacts/verify.json`; it covers lint, typecheck, schema/SQL/API
checks, domain and D1 suites, builds, and browser journeys.

L6 integration, genuine human content approval, project privacy review, billing
reconciliation and the L7 qualification run remain separate work. The proposed rendering
comparison needs distinct frozen rendering policies before authorization; this baseline
does not pretend to run three variants of the same request.
