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
Ed25519 provider/content public keys and named reviewer IDs, plus
qualification/<qualificationEvidenceDigest>.json in the separate
QUALIFICATION_ARTIFACTS bucket. The byte-hashed object contains the signed
provider qualification, base64url evaluation manifest and six evidence records.
Every invocation verifies the digest, signature, evidence, target identities and
expiry. A missing provider dependency blocks new generation while safe owned
record actions remain available.

The resource declarations bind reviewed configuration; they cannot establish
the actual platform permissions. The release-isolation drills must demonstrate
that preview credentials cannot reach production resources.
