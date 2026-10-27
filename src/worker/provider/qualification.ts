import { z } from 'zod';
import { READING_PROVIDER_POLICY } from '../../contracts/provider-policy.ts';
import { canonicalJson } from '../../domain/json.ts';

const Hash = z.string().regex(/^[a-f0-9]{64}$/);
const Identity = z.string().trim().min(1).max(200);
const Document = z.strictObject({
  version: z.literal('openai-responses.qualification.v2'),
  scope: z.literal('application'),
  model: z.literal(READING_PROVIDER_POLICY.model),
  policyHash: Hash,
  contentHash: Hash,
  projectId: Identity,
  environmentId: Identity,
  reviewerId: Identity,
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  evaluationManifestHash: Hash,
  evidence: z.strictObject({
    projectAccess: Hash,
    retention: Hash,
    editorial: Hash,
    corpus: Hash,
    tokenEstimator: Hash,
    pricing: Hash,
  }),
});
const Signed = z.strictObject({
  document: Document,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
type EvidenceName = keyof z.infer<typeof Document>['evidence'];
declare const authenticatedBrand: unique symbol;
export type ProviderQualification = Readonly<Omit<z.infer<typeof Document>, 'evidence'>> & {
  readonly evidence: Readonly<z.infer<typeof Document>['evidence']>;
  readonly [authenticatedBrand]: true;
};
const authenticated = new WeakSet<object>();

type Expected = { policyHash: string; contentHash: string; now: number };
const rejected = (): never => {
  throw new Error('Provider qualification rejected');
};
function current(document: z.infer<typeof Document>, expected: Expected) {
  if (
    !Number.isSafeInteger(expected.now) ||
    document.policyHash !== expected.policyHash ||
    document.contentHash !== expected.contentHash ||
    Date.parse(document.issuedAt) > expected.now ||
    Date.parse(document.expiresAt) <= expected.now ||
    Date.parse(document.expiresAt) <= Date.parse(document.issuedAt)
  )
    rejected();
}
async function hash(bytes: Uint8Array) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
function snapshot(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0 || bytes.byteLength > 1_000_000)
    rejected();
  return new Uint8Array(bytes);
}

/** Trusted deployment/bootstrap entrypoint. No paths, request parameters or network lookups. */
export async function authenticateProviderQualification(
  value: unknown,
  options: Expected & {
    publicKey: CryptoKey;
    evidence: Record<EvidenceName, Uint8Array>;
    evaluationManifest: Uint8Array;
    projectId: string;
    environmentId: string;
    reviewerId: string;
  },
): Promise<ProviderQualification> {
  try {
    const { document, signature } = Signed.parse(value);
    current(document, options);
    if (
      document.projectId !== options.projectId ||
      document.environmentId !== options.environmentId ||
      document.reviewerId !== options.reviewerId ||
      options.publicKey.type !== 'public' ||
      options.publicKey.algorithm.name !== 'Ed25519'
    )
      rejected();
    const names = Object.keys(document.evidence) as EvidenceName[];
    if (Object.keys(options.evidence).length !== names.length) rejected();
    const evidence = names.map((name) => [name, snapshot(options.evidence[name])] as const);
    const manifest = snapshot(options.evaluationManifest);
    const signatureBytes = Uint8Array.from(
      atob(`${signature.replaceAll('-', '+').replaceAll('_', '/')}==`),
      (c) => c.charCodeAt(0),
    );
    if (
      signatureBytes.length !== 64 ||
      !(await crypto.subtle.verify(
        'Ed25519',
        options.publicKey,
        signatureBytes,
        new TextEncoder().encode(canonicalJson(document)),
      ))
    )
      rejected();
    if ((await hash(manifest)) !== document.evaluationManifestHash) rejected();
    for (const [name, bytes] of evidence)
      if ((await hash(bytes)) !== document.evidence[name]) rejected();
    const artifact = Object.freeze({
      ...document,
      evidence: Object.freeze(document.evidence),
    }) as ProviderQualification;
    authenticated.add(artifact);
    return artifact;
  } catch {
    return rejected();
  }
}

/** A JSON-shaped document or evaluation permit is never a runtime capability. */
export function verifyProviderQualification(
  value: unknown,
  expected: Expected,
): ProviderQualification {
  if (typeof value !== 'object' || value === null || !authenticated.has(value)) rejected();
  const artifact = value as ProviderQualification;
  current(artifact, expected);
  return artifact;
}
