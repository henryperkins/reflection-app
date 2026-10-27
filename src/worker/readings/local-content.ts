import { READING_PRODUCT_COPY } from '../../contracts/product-copy.ts';
import type { z } from 'zod';
import type { ContentBundle } from '../../contracts/index.ts';
import { sha256Json } from '../../domain/json.ts';
import { bundleHash, sourceHash } from '../../domain/tarot/plan.ts';
// Explicit local simulation only. These markers are NOT real editorial approval.
const TEST_ONLY = 'SYNTHETIC LOCAL SIMULATION — never production editorial approval';
const TEST_HASH = 'a'.repeat(64);
const TEST_TIME = '2026-10-26T00:00:00Z';
export async function syntheticBundle(): Promise<z.infer<typeof ContentBundle>> {
  const ids = [
    ...Array.from({ length: 22 }, (_, i) => `major-${String(i).padStart(2, '0')}`),
    ...['wands', 'cups', 'swords', 'pentacles'].flatMap((s) =>
      Array.from({ length: 14 }, (_, i) => `${s}-${String(i + 1).padStart(2, '0')}`),
    ),
  ];
  const deck = ids.map((id) => ({
    id,
    name: `Synthetic ${id}`,
    imageHash: null,
    imagePath: null,
    attribution: TEST_ONLY,
  }));
  const sources: z.infer<typeof ContentBundle>['sources'] = [];
  for (const cardId of ids)
    for (const orientation of ['upright', 'reversed'] as const) {
      const source = {
        id: `synthetic:${cardId}:${orientation}`,
        version: 1,
        hash: TEST_HASH,
        kind: 'traditional_interpretation' as const,
        cardId,
        orientation,
        position: null,
        text: `${TEST_ONLY}. Consider this image as an invitation to pause.`,
        fallbackText: 'Consider what is available to you as you pause.',
        reflectionQuestion: 'What feels useful to consider?',
        rights: {
          status: 'cleared' as const,
          evidence: `${TEST_ONLY}. PRIVATE_RIGHTS_SENTINEL`,
          attribution: TEST_ONLY,
          territory: 'Synthetic tests only',
        },
        review: {
          kind: 'human_approved' as const,
          reviewer: `${TEST_ONLY}: fixture reviewer`,
          reviewedHash: TEST_HASH,
          reviewedAt: TEST_TIME,
        },
      };
      source.hash = await sourceHash(source);
      source.review.reviewedHash = source.hash;
      sources.push(source);
    }
  const bundle: z.infer<typeof ContentBundle> = {
    schemaVersion: 1,
    editionHash: TEST_HASH,
    deckEdition: await sha256Json(deck),
    deck,
    positionFrames: [
      { position: 'situation', text: `${TEST_ONLY}: situation` },
      { position: 'tension', text: `${TEST_ONLY}: tension` },
      { position: 'possibility', text: `${TEST_ONLY}: possibility` },
    ],
    productCopy: {
      ...READING_PRODUCT_COPY,
      unsupportedLanguage: TEST_ONLY,
      crisis: TEST_ONLY,
      uncertainSafety: TEST_ONLY,
      sensitiveAdvice: TEST_ONLY,
      providerRefusal: TEST_ONLY,
    },
    sources,
    createdAt: TEST_TIME,
    licenseNotice: TEST_ONLY,
  };
  bundle.editionHash = await bundleHash(bundle);
  return bundle;
}
