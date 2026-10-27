import { z } from 'zod';
import { ContentBundle, Hash, Instant } from '../../contracts/index.ts';
import { READING_PRODUCT_COPY } from '../../contracts/product-copy.ts';
import { bundleHash, sourceHash } from '../../domain/tarot/plan.ts';
import { canonicalJson, sha256Bytes, sha256Json } from '../../domain/json.ts';
export type Bundle = z.infer<typeof ContentBundle>;
export type ContentTrust = { publicKey: CryptoKey; environmentId: string; reviewerId: string };
const Identity = z.string().trim().min(1).max(200);
const Document = z.strictObject({
  version: z.literal('content-approval.v1'),
  scope: z.literal('editorial-content'),
  reviewerId: Identity,
  environmentId: Identity,
  approvedAt: Instant,
  bundleHash: Hash,
  deckHash: Hash,
  copyHash: Hash,
  positionsHash: Hash,
  licenseHash: Hash,
  sources: z.array(z.strictObject({ id: z.string(), hash: Hash })).length(156),
  attributionsHash: Hash,
  territoriesHash: Hash,
  rightsEvidenceHash: Hash,
});
const Signed = z.strictObject({
  document: Document,
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
});
type SignedApproval = z.infer<typeof Signed>;
declare const approvedBrand: unique symbol;
export type ContentApproval = Readonly<SignedApproval> & { readonly [approvedBrand]: true };
const authenticated = new WeakSet<object>();
const denied = (): never => {
  throw new Error('Content not approved');
};
const marker = /\b(synthetic|unapproved|test.only|not human approval|pending|codex draft)\b/i;

/** Complete neutral catalog and compiled copy are checked even for check-only commands. */
export async function inspectReviewedBundle(
  value: unknown,
  reviewerId?: string,
  requireCompiledCopy = true,
): Promise<Bundle> {
  try {
    const b = ContentBundle.parse(value);
    if (
      b.editionHash !== (await bundleHash(b)) ||
      b.deckEdition !== (await sha256Json(b.deck)) ||
      (requireCompiledCopy &&
        canonicalJson(b.productCopy) !== canonicalJson(READING_PRODUCT_COPY)) ||
      b.sources.length !== 156 ||
      !b.licenseNotice.trim() ||
      marker.test(b.licenseNotice)
    )
      denied();
    if (
      new Set(b.deck.map((c) => c.id)).size !== 78 ||
      b.deck.some(
        (c) =>
          !c.name.trim() ||
          !c.attribution.trim() ||
          marker.test(c.attribution) ||
          marker.test(c.name) ||
          (c.imageHash === null) !== (c.imagePath === null),
      )
    )
      denied();
    if (
      new Set(b.positionFrames.map((p) => p.position)).size !== 3 ||
      b.positionFrames.some((p) => !p.text.trim() || marker.test(p.text))
    )
      denied();
    const ids = new Set<string>(),
      bindings = new Set<string>();
    for (const s of b.sources) {
      if (
        ids.has(s.id) ||
        bindings.has(`${s.cardId}:${s.orientation}`) ||
        !s.id.trim() ||
        /^(synthetic|reflection-draft):/i.test(s.id) ||
        s.position !== null ||
        !b.deck.some((c) => c.id === s.cardId) ||
        s.hash !== (await sourceHash(s)) ||
        s.review.kind !== 'human_approved' ||
        !s.review.reviewer?.trim() ||
        marker.test(s.review.reviewer) ||
        (reviewerId !== undefined && s.review.reviewer !== reviewerId) ||
        s.review.reviewedHash !== s.hash ||
        s.review.reviewedAt === null ||
        s.rights.status !== 'cleared' ||
        [s.rights.evidence, s.rights.attribution, s.rights.territory].some(
          (v) => !v.trim() || marker.test(v),
        ) ||
        [s.text, s.fallbackText, s.reflectionQuestion].some((v) => !v.trim())
      )
        denied();
      ids.add(s.id);
      bindings.add(`${s.cardId}:${s.orientation}`);
    }
    for (const c of b.deck)
      for (const o of ['upright', 'reversed']) if (!bindings.has(`${c.id}:${o}`)) denied();
    return b;
  } catch {
    return denied();
  }
}
export async function contentApprovalDocument(
  bundle: Bundle,
  metadata: {
    reviewerId: string;
    environmentId: string;
    approvedAt: string;
    rightsEvidenceHash: string;
  },
  requireCompiledCopy = true,
) {
  const b = await inspectReviewedBundle(bundle, metadata.reviewerId, requireCompiledCopy);
  return Document.parse({
    version: 'content-approval.v1',
    scope: 'editorial-content',
    ...metadata,
    bundleHash: b.editionHash,
    deckHash: b.deckEdition,
    copyHash: await sha256Json(b.productCopy),
    positionsHash: await sha256Json(b.positionFrames),
    licenseHash: await sha256Json(b.licenseNotice),
    sources: b.sources.map((s) => ({ id: s.id, hash: s.hash })),
    attributionsHash: await sha256Json({
      deck: b.deck.map((c) => c.attribution),
      sources: b.sources.map((s) => s.rights.attribution),
    }),
    territoriesHash: await sha256Json(b.sources.map((s) => s.rights.territory)),
  });
}
export async function verifySignedContentApproval(
  value: unknown,
  bundle: unknown,
  trust: ContentTrust,
  now = Date.now(),
  requireCompiledCopy = true,
): Promise<SignedApproval> {
  try {
    const signed = Signed.parse(value),
      d = signed.document,
      b = await inspectReviewedBundle(bundle, trust.reviewerId, requireCompiledCopy);
    if (
      trust.publicKey.type !== 'public' ||
      trust.publicKey.algorithm.name !== 'Ed25519' ||
      d.environmentId !== trust.environmentId ||
      d.reviewerId !== trust.reviewerId ||
      marker.test(d.reviewerId) ||
      !Number.isSafeInteger(now) ||
      Date.parse(d.approvedAt) > now ||
      b.sources.some((s) => Date.parse(s.review.reviewedAt!) > Date.parse(d.approvedAt)) ||
      Date.parse(b.createdAt) > Date.parse(d.approvedAt)
    )
      denied();
    if (
      canonicalJson(d) !==
      canonicalJson(
        await contentApprovalDocument(
          b,
          {
            reviewerId: d.reviewerId,
            environmentId: d.environmentId,
            approvedAt: d.approvedAt,
            rightsEvidenceHash: d.rightsEvidenceHash,
          },
          requireCompiledCopy,
        ),
      )
    )
      denied();
    const signature = Uint8Array.from(
      atob(`${signed.signature.replaceAll('-', '+').replaceAll('_', '/')}==`),
      (c) => c.charCodeAt(0),
    );
    if (
      !(await crypto.subtle.verify(
        'Ed25519',
        trust.publicKey,
        signature,
        new TextEncoder().encode(canonicalJson(d)),
      ))
    )
      denied();
    return signed;
  } catch {
    return denied();
  }
}
function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) freezeDeep(v);
    Object.freeze(value);
  }
  return value;
}
/** Protected operator/bootstrap input. Private evidence is verified here and never stored in D1. */
export async function authenticateContentApproval(
  value: unknown,
  options: ContentTrust & { bundle: unknown; rightsEvidence: Uint8Array; now: number },
): Promise<ContentApproval> {
  const evidence = new Uint8Array(options.rightsEvidence);
  if (evidence.byteLength === 0 || evidence.byteLength > 1_000_000) denied();
  const signed = await verifySignedContentApproval(value, options.bundle, options, options.now);
  if ((await sha256Bytes(evidence)) !== signed.document.rightsEvidenceHash) denied();
  const artifact = freezeDeep(signed) as ContentApproval;
  authenticated.add(artifact);
  return artifact;
}
export async function verifyContentApproval(approval: ContentApproval, bundle: Bundle) {
  if (!authenticated.has(approval)) denied();
  const d = approval.document;
  if (
    Date.parse(d.approvedAt) > Date.now() ||
    canonicalJson(d) !==
      canonicalJson(
        await contentApprovalDocument(bundle, {
          reviewerId: d.reviewerId,
          environmentId: d.environmentId,
          approvedAt: d.approvedAt,
          rightsEvidenceHash: d.rightsEvidenceHash,
        }),
      )
  )
    denied();
  return approval;
}
