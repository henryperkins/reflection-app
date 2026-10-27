import { describe, expect, it } from 'vitest';
import draft from '../../content/launch-canon-draft.json';
import catalog from '../../src/client/card-names.json';
import { cardName } from '../../src/client/card-names.ts';
import { sha256Json } from '../../src/domain/json.ts';
import { syntheticBundle } from '../../src/worker/readings/local-content.ts';

describe('edition-specific display metadata', () => {
  it('keeps the client catalog synchronized with the two source decks', async () => {
    const bundles = [draft, await syntheticBundle()];
    expect(Object.keys(catalog).sort()).toEqual(bundles.map((bundle) => bundle.deckEdition).sort());
    for (const bundle of bundles) {
      expect(await sha256Json(bundle.deck)).toBe(bundle.deckEdition);
      for (const card of bundle.deck) {
        expect(cardName(bundle.deckEdition, card.id)).toBe(card.name);
      }
    }
  });
});
