# Hosted runtime configuration

Copy a manifest example outside this directory, replace every required value with
the reviewed resource identities, and render it:

    node --import tsx scripts/render-hosted-config.ts --manifest /absolute/manifest.json --output /absolute/wrangler.hosted.json

The examples deliberately contain invalid placeholders and cannot be deployed.
The renderer validates the exact HTTPS origin/RP ID and rejects shared resources
across the selected environment and its reserved peers. Production output always
starts with ingress and generation off. Rendering creates no resources.

Install identity key material and provider credentials separately as server
secrets. Identity secrets must name the manifest's immutable environment ID;
public synthetic fixture keys are rejected in hosted modes.

Qualified generation additionally requires a pinned QUALIFICATION_TRUST with
Ed25519 provider/content public keys and pinned evidence-runner IDs, plus
qualification/<qualificationEvidenceDigest>.json in the separate
QUALIFICATION_ARTIFACTS bucket. The byte-hashed object contains the signed
provider qualification, base64url evaluation manifest and six evidence records.
Every invocation verifies the digest, signature, evidence, target identities and
expiry. A missing provider dependency blocks new generation while safe owned
record actions remain available.

The resource declarations bind reviewed configuration; they cannot establish
the actual platform permissions. The release-isolation drills must demonstrate
that preview credentials cannot reach production resources.

Hosted runtimes also require the server-only RECOVERY_CONTROL_SECRET and the
OFFLINE_COORDINATOR SQLite Durable Object binding. All private requests and Cron
work register with that independent coordinator. Restore/cleanup close admission
and drain those registrations; a crashed writer never expires open automatically.
The BACKUP_INVENTORY bucket is separate from the recovery bucket and D1. Its
signed complete index and protected backup bytes are required for destructive
cleanup and key-retirement checks. Completing an offline operation does not
resume ingress; a separate evidence-checked operator action does that.

Cron runs every minute. The bounded driver reserves the active provider deadline
plus 30 seconds (90 seconds for the current policy), serves security/erasure and
retention first, and starts no new inference that cannot fit its remaining budget.
The hosted HTTP handler awaits initial generation instead of depending on the
30-second post-response waitUntil extension for a 60-second call.
