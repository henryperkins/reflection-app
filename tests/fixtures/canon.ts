import type { z } from 'zod';
import type { ContentBundle, PreparedPlan } from '../../src/contracts/index.ts';
import { sha256Json } from '../../src/domain/json.ts';
import { drawTarot } from '../../src/domain/tarot/draw.ts';
import { bundleHash, sourceHash, type BuildPlanInput } from '../../src/domain/tarot/plan.ts';
export const TEST_ONLY = 'SYNTHETIC TEST-ONLY — never production editorial approval';
export const TEST_IDS = {
  request: '00000000-0000-4000-8000-000000000001',
  basis: '00000000-0000-4000-8000-000000000002',
  parent: '00000000-0000-4000-8000-000000000003',
  grant: '00000000-0000-4000-8000-000000000004',
  source: '00000000-0000-4000-8000-000000000005',
};
export const TEST_TIME = '2026-10-26T00:00:00Z';
export const TEST_HASH = 'a'.repeat(64);
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
export async function syntheticPlanInput(): Promise<BuildPlanInput> {
  const content = await syntheticBundle();
  return {
    basis: await drawTarot({
      deck: content.deck.map((c) => c.id),
      deckEdition: content.deckEdition,
      basisId: TEST_IDS.basis,
      drawnAt: TEST_TIME,
      reversals: true,
      seed: new Uint8Array(32),
    }),
    content,
    requestId: TEST_IDS.request,
    question: '  What could I consider?  ',
    language: 'en',
    operation: 'initial',
    parentEditionId: null,
    selected: [],
    permissionRevision: 1,
    keyVersion: 1,
    promptHash: TEST_HASH,
    validatorHash: TEST_HASH,
    generationPolicyHash: TEST_HASH,
  };
}
export function syntheticCandidate(plan: PreparedPlan) {
  return {
    schemaVersion: 1,
    kind: 'tarot.interpretation.v1',
    units: plan.basis.cards.map((card, i) => ({
      position: card.position,
      factIds: [card.id],
      sourceIds: [plan.sources[i]!.id],
      interpretation: 'Consider what this image invites you to notice.',
      reflectionQuestion: 'What might be worth exploring?',
    })),
    closing: 'Take what is useful.',
  };
}
