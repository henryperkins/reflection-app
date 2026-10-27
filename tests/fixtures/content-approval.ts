// Ephemeral signing keys and rewritten draft data exercise validation only.
// These fixtures are never editorial approval records or a deployment trust root.
import draft from '../../content/launch-canon-draft.json';
import { READING_PRODUCT_COPY } from '../../src/contracts/product-copy.ts';
import { ContentBundle, AnyContentBundle } from '../../src/contracts/index.ts';
import { bundleHash, sourceHash } from '../../src/domain/tarot/plan.ts';
import { sha256Json, sha256Bytes, canonicalJson } from '../../src/domain/json.ts';
import {
  authenticateContentApproval,
  contentApprovalDocument,
} from '../../src/worker/content/approval.ts';

export async function editorialBundle() {
  const b = ContentBundle.parse({
    ...structuredClone(draft),
    productCopy: { ...READING_PRODUCT_COPY },
  });
  b.licenseNotice = 'Catalog text licensed by its author for worldwide use.';
  for (const card of b.deck) card.attribution = 'Reflection catalog author';
  b.deckEdition = await sha256Json(b.deck);
  for (const s of b.sources) {
    s.id = s.id.replace('reflection-draft:', 'reflection-reviewed:');
    s.text = 'Consider the possibilities represented by this card.';
    s.rights = {
      status: 'cleared',
      evidence: 'Rights record R1',
      attribution: 'Reflection catalog author',
      territory: 'Worldwide',
    };
    s.review = {
      kind: 'human_approved',
      reviewer: 'editor-a',
      reviewedHash: 'a'.repeat(64),
      reviewedAt: '2026-10-26T00:00:00Z',
    };
    s.hash = await sourceHash(s);
    s.review.reviewedHash = s.hash;
  }
  b.editionHash = await bundleHash(b);
  return ContentBundle.parse(b);
}
export async function signedApproval(bundle: unknown) {
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const rightsEvidence = new TextEncoder().encode(
    'Ephemeral rights evidence for validation tests only.',
  );
  const document = await contentApprovalDocument(AnyContentBundle.parse(bundle), {
    reviewerId: 'editor-a',
    environmentId: 'test-environment',
    approvedAt: '2026-10-26T00:00:00Z',
    rightsEvidenceHash: await sha256Bytes(rightsEvidence),
  });
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      'Ed25519',
      keys.privateKey,
      new TextEncoder().encode(canonicalJson(document)),
    ),
  );
  const signature = btoa(String.fromCharCode(...sig))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  const signed = { document, signature };
  const trust = {
    publicKey: keys.publicKey,
    reviewerId: 'editor-a',
    environmentId: 'test-environment',
  };
  const options = { ...trust, bundle, rightsEvidence, now: Date.parse('2026-10-27T00:00:00Z') };
  return {
    keys,
    signed,
    trust,
    options,
    authenticate: () => authenticateContentApproval(signed, options),
  };
}
