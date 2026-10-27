import catalog from './card-names.json';

// Names from content/launch-canon-draft.json and syntheticBundle() only; the
// tooling test checks this catalog against both sources to catch edition drift.
// Public name metadata only, keyed by the exact deckEdition hash. Never infer a
// name from another edition: its card ordering or terminology may differ.
export function cardName(deckEdition: string, cardId: string): string | undefined {
  const editions: Record<string, Record<string, string>> = catalog;
  return editions[deckEdition]?.[cardId];
}
