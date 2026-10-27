import { sha256Json } from '../../src/domain/json.ts';
import { syntheticPlanInput } from './canon.ts';

export async function reviewHash<T extends { hash: string; review: unknown }>(value: T) {
  const { hash: _hash, review: _review, ...body } = value;
  return sha256Json(body);
}
export async function rehashBundle<T extends { editionHash: string }>(value: T) {
  const { editionHash: _hash, ...body } = value;
  value.editionHash = await sha256Json(body);
  return value;
}
export async function v2Input() {
  const old = await syntheticPlanInput();
  const sources = await Promise.all(
    old.content.sources.map(async (s) => {
      const source = {
        ...s,
        meaning: {
          core: `A synthetic orientation-specific resource for ${s.cardId} ${s.orientation}.`,
          distinctions: [
            'Distinguish what supports a goal from what merely adds work.',
            'A useful arrangement can be retained while alternatives are considered.',
          ],
          positive: 'An already manageable process can provide a useful baseline for comparison.',
          limits: ['No personal difficulty or necessary change follows from the symbol.'],
          themes: ['continuity', 'comparison'],
          imagery: null,
        },
      };
      source.hash = await reviewHash(source);
      source.review.reviewedHash = source.hash;
      return source;
    }),
  );
  const content = await rehashBundle({
    ...old.content,
    schemaVersion: 2 as const,
    spreadVersion: 'situation-tension-possibility.v2',
    sources,
    relationships: [] as Awaited<ReturnType<typeof relationship>>[],
    fallbackV2: {
      synthesis: 'Consider how the supported perspectives connect to the question.',
      action: 'You could compare the available options against what matters to your goal.',
      question: null,
    },
    positionFrames: [
      {
        position: 'situation' as const,
        text: 'Apply the selected idea to the current question and what the reader described.',
      },
      {
        position: 'tension' as const,
        text: 'Consider a trade-off that may already be managed; no problem is required.',
      },
      {
        position: 'possibility' as const,
        text: 'Develop an available method without predicting its result.',
      },
    ],
  });
  return {
    ...old,
    content,
    question: '  I am not discouraged.\nMy workload is manageable. What could I explore?  ',
  };
}
export async function relationship(
  input: {
    basis: {
      deckEdition: string;
      cards: Array<{ cardId: string; orientation: 'upright' | 'reversed' }>;
    };
    content: {
      sources: Array<{
        id: string;
        cardId: string;
        orientation: 'upright' | 'reversed';
        rights: unknown;
        review: {
          kind: 'unreviewed' | 'agent_reviewed' | 'human_approved';
          reviewer: string | null;
          reviewedHash: string | null;
          reviewedAt: string | null;
        };
      }>;
    };
  },
  id: string,
  priority = 10,
) {
  const selected = input.basis.cards
    .slice(0, 2)
    .map(
      (c) =>
        input.content.sources.find(
          (s) => s.cardId === c.cardId && s.orientation === c.orientation,
        )!,
    );
  const result = {
    id,
    version: 1,
    hash: 'a'.repeat(64),
    deckEdition: input.basis.deckEdition,
    priority,
    cards: input.basis.cards
      .slice(0, 2)
      .map((c) => ({ cardId: c.cardId, orientations: [c.orientation] })),
    themes: ['continuity'],
    sourceIds: selected.map((s) => s.id),
    text: 'Compare a possible adjustment against the support worth retaining.',
    limits: 'This does not establish that a change or personal difficulty has occurred.',
    rights: {
      status: 'cleared' as const,
      evidence: 'SYNTHETIC TEST ONLY',
      attribution: 'Synthetic fixture',
      territory: 'Tests',
    },
    review: { ...selected[0]!.review },
  };
  result.hash = await reviewHash(result);
  result.review.reviewedHash = result.hash;
  return result;
}
