import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { prepareEvaluation } from '../../scripts/provider-evaluation-corpus.ts';

test.each([
  {
    cases: ['I01', 'I02'],
    cards: [
      ['major-13', 'upright'],
      ['wands-10', 'upright'],
      ['swords-14', 'upright'],
    ],
  },
  {
    cases: ['I03', 'I04'],
    cards: [
      ['wands-04', 'reversed'],
      ['major-17', 'reversed'],
      ['major-16', 'reversed'],
    ],
  },
])(
  'L7 preserves historical editorial regression draws and sources: $cases',
  async ({ cases, cards }) => {
    const proposal = JSON.parse(
      readFileSync('qualification/evidence/provider-v2-proposal.json', 'utf8'),
    );
    const historical = await prepareEvaluation('reading-v2-editorial-fast-xhigh');
    for (const id of cases) {
      const proposed = proposal.schedule.find((row: { caseId: string }) => row.caseId === id);
      expect(
        proposed.basis.cards.map((c: { cardId: string; orientation: string }) => [
          c.cardId,
          c.orientation,
        ]),
      ).toEqual(cards);
      const original = historical.requests.find((r) => r.caseId === id)!;
      expect(proposed.basis).toEqual(original.plan.basis);
      expect(proposed.question).toBe(original.plan.question);
      expect(
        proposed.sourceBindings.map((s: { sourceId: string; hash: string }) => [
          s.sourceId,
          s.hash,
        ]),
      ).toEqual(original.plan.sources.map((s) => [s.id, s.hash]));
    }
  },
);
