import { expect, test } from 'vitest';
import { buildPlanV2, validatePlanV2 } from '../../src/domain/tarot/context-v2.ts';
import { v2Input, rehashBundle, reviewHash, relationship } from '../fixtures/canon-v2.ts';

test('v2 freezes the exact reader text, actual metadata and explicit position definitions', async () => {
  const input = await v2Input(),
    plan = await buildPlanV2(input);
  expect(plan.question).toBe(input.question);
  expect(plan.version).toBe('tarot-plan.v2');
  expect(plan.reader).toEqual({ id: 'reader:question', text: input.question });
  expect(plan.spread).toEqual({
    version: input.content.spreadVersion,
    positions: input.content.positionFrames,
  });
  expect(plan.draw.map((c) => c.cardId)).toEqual(input.basis.cards.map((c) => c.cardId));
  expect(plan.draw[0]).toMatchObject({
    name: 'Synthetic wands-08',
    orientation: 'reversed',
    factId: 'card:situation',
    deckEdition: input.basis.deckEdition,
  });
  expect(plan.relationships).toEqual([]);
  expect(plan.selected).toEqual([]);
  await expect(validatePlanV2(plan)).resolves.toEqual(plan);
});
test('v2 keeps exact position preference and approved neutral fallback', async () => {
  const input = await v2Input();
  const neutral = input.content.sources.find(
    (s) =>
      s.cardId === input.basis.cards[0]!.cardId &&
      s.orientation === input.basis.cards[0]!.orientation,
  )!;
  const override = {
    ...structuredClone(neutral),
    id: 'synthetic:position-override',
    position: 'situation' as const,
  };
  override.hash = await reviewHash(override);
  override.review.reviewedHash = override.hash;
  input.content.sources.push(override);
  await rehashBundle(input.content);
  expect((await buildPlanV2(input)).sources[0]!.id).toBe(override.id);
  override.review.kind = 'agent_reviewed';
  await rehashBundle(input.content);
  expect((await buildPlanV2(input)).sources[0]!.id).toBe(neutral.id);
});
test('relationships require all cards, orientations, themes, deck and selected sources, then stable priority', async () => {
  const input = await v2Input();
  const good = await Promise.all(
    ['note:c', 'note:b', 'note:a'].map((id) => relationship(input, id)),
  );
  const missing = await relationship(input, 'note:absent', 0);
  missing.cards[1]!.cardId = 'major-21';
  missing.hash = await reviewHash(missing);
  missing.review.reviewedHash = missing.hash;
  const orientation = await relationship(input, 'note:orientation', 0);
  orientation.cards[0]!.orientations = ['upright'];
  orientation.hash = await reviewHash(orientation);
  orientation.review.reviewedHash = orientation.hash;
  const theme = await relationship(input, 'note:theme', 0);
  theme.themes = ['absent-theme'];
  theme.hash = await reviewHash(theme);
  theme.review.reviewedHash = theme.hash;
  const source = await relationship(input, 'note:source', 0);
  source.sourceIds[0] = 'source:not-selected';
  source.hash = await reviewHash(source);
  source.review.reviewedHash = source.hash;
  const deck = await relationship(input, 'note:deck', 0);
  deck.deckEdition = 'c'.repeat(64);
  deck.hash = await reviewHash(deck);
  deck.review.reviewedHash = deck.hash;
  input.content.relationships = [missing, orientation, theme, source, deck, ...good];
  await rehashBundle(input.content);
  expect((await buildPlanV2(input)).relationships.map((r) => r.id)).toEqual(['note:a', 'note:b']);
});
test('unreviewed content fails standard admission and explicit diagnostic scope remains marked', async () => {
  const input = await v2Input();
  for (const s of input.content.sources) {
    s.review.kind = 'agent_reviewed';
    s.review.reviewedHash = null;
    s.rights.status = 'unknown';
    s.hash = await reviewHash(s);
  }
  await rehashBundle(input.content);
  await expect(buildPlanV2(input)).rejects.toThrow('CONTENT_UNAVAILABLE');
  const plan = await buildPlanV2(input, true);
  expect(plan.diagnosticOnly).toBe(true);
  expect(plan.sources[0]!.review.kind).toBe('agent_reviewed');
  expect(plan.sources[0]!.rights.status).toBe('unknown');
});
test.each(['coverage', 'source', 'frames', 'history'])(
  'v2 rejects malformed %s without altering required inputs',
  async (kind) => {
    const input = await v2Input();
    if (kind === 'coverage') input.content.sources.pop();
    if (kind === 'source') input.content.sources[0]!.meaning.positive += ' Changed';
    if (kind === 'frames') input.content.positionFrames[1]!.position = 'situation';
    if (kind === 'history') input.selected.push({} as never);
    await rehashBundle(input.content);
    await expect(buildPlanV2(input)).rejects.toThrow();
  },
);
test('frozen reader, frames and source changes are detected at the egress boundary', async () => {
  const plan = await buildPlanV2(await v2Input());
  for (const change of [
    (p: typeof plan) => {
      p.spread.positions[0]!.text += ' changed';
    },
    (p: typeof plan) => {
      p.question = 'different';
    },
    (p: typeof plan) => {
      p.sources[0]!.meaning.core += ' changed';
    },
  ]) {
    const altered = structuredClone(plan);
    change(altered);
    await expect(validatePlanV2(altered)).rejects.toThrow();
  }
});
