import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256Json } from '../../src/domain/json.ts';
import { renderFacts } from '../../src/domain/tarot/facts.ts';
import {
  buildPlan,
  bundleHash,
  sourceHash,
  validateCandidateBindings,
} from '../../src/domain/tarot/plan.ts';
import { syntheticPlanInput, syntheticCandidate } from '../fixtures/canon.ts';
describe('canonical JSON identities', () => {
  it('uses JCS property order and UTF-8 SHA256', async () => {
    expect(canonicalJson({ z: -0, a: ['é', 1e30, true, null] })).toBe(
      '{"a":["é",1e+30,true,null],"z":0}',
    );
    expect(await sha256Json({ b: 2, a: 1 })).toBe(
      '43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777',
    );
  });
  it.each([NaN, undefined, { a: undefined }, '\ud800', new Date(), [Infinity]])(
    'rejects non-I-JSON values',
    (value) => expect(() => canonicalJson(value)).toThrow(),
  );
});
describe('complete reviewed prepared plan', () => {
  it('selects exact orientation canon and renders seven controlled facts', async () => {
    const plan = await buildPlan(await syntheticPlanInput());
    expect(plan.question).toBe('What could I consider?');
    expect(plan.sources.map((s) => [s.cardId, s.orientation])).toEqual([
      ['wands-08', 'reversed'],
      ['major-04', 'upright'],
      ['cups-10', 'upright'],
    ]);
    expect(renderFacts(plan.basis)).toEqual([
      { id: 'card:situation', text: 'The situation card is wands-08 (reversed).' },
      { id: 'card:tension', text: 'The tension card is major-04 (upright).' },
      { id: 'card:possibility', text: 'The possibility card is cups-10 (upright).' },
      { id: 'count:wands', text: 'The draw contains 1 Wands card.' },
      { id: 'count:cups', text: 'The draw contains 1 Cups card.' },
      { id: 'count:swords', text: 'The draw contains 0 Swords cards.' },
      { id: 'count:pentacles', text: 'The draw contains 0 Pentacles cards.' },
    ]);
  });
  it('prefers an approved exact position override and otherwise uses the neutral entry', async () => {
    const input = await syntheticPlanInput();
    const neutral = input.content.sources.find(
      (s) => s.cardId === 'wands-08' && s.orientation === 'reversed',
    )!;
    const override = structuredClone(neutral);
    override.id = 'synthetic:override';
    override.position = 'situation';
    override.text = 'SYNTHETIC TEST-ONLY exact position source.';
    override.hash = await sourceHash(override);
    override.review.reviewedHash = override.hash;
    input.content.sources.push(override);
    input.content.editionHash = await bundleHash(input.content);
    expect((await buildPlan(input)).sources[0]!.id).toBe('synthetic:override');
    override.review.kind = 'unreviewed';
    input.content.editionHash = await bundleHash(input.content);
    expect((await buildPlan(input)).sources[0]!.id).toBe(neutral.id);
  });
  it.each([
    'review',
    'reviewedHash',
    'rights',
    'sourceHash',
    'bundleHash',
    'deckHash',
    'coverage',
    'positionFrames',
    'duplicateSource',
  ])('fails closed on %s', async (failure) => {
    const input = await syntheticPlanInput();
    const source = input.content.sources.find(
      (s) => s.cardId === 'wands-08' && s.orientation === 'reversed',
    )!;
    if (failure === 'review') source.review.kind = 'agent_reviewed';
    if (failure === 'reviewedHash') source.review.reviewedHash = 'b'.repeat(64);
    if (failure === 'rights') source.rights.status = 'unknown';
    if (failure === 'sourceHash') source.text += ' modified after review';
    if (failure === 'bundleHash') input.content.editionHash = 'b'.repeat(64);
    if (failure === 'deckHash') input.content.deck[0]!.name += ' changed';
    if (failure === 'coverage') input.content.sources.pop();
    if (failure === 'positionFrames') input.content.positionFrames[1]!.position = 'situation';
    if (failure === 'duplicateSource') input.content.sources.push(structuredClone(source));
    if (failure !== 'bundleHash') input.content.editionHash = await bundleHash(input.content);
    await expect(buildPlan(input)).rejects.toThrow('CONTENT_UNAVAILABLE');
  });
  it.each(['count', 'factId', 'duplicateCard', 'orientation', 'position', 'seed'])(
    'rejects invalid basis %s',
    async (failure) => {
      const input = await syntheticPlanInput();
      if (failure === 'count') input.basis.counts[0]!.count = 3;
      if (failure === 'factId') input.basis.cards[0]!.id = 'card:tension';
      if (failure === 'duplicateCard') input.basis.cards[1]!.cardId = input.basis.cards[0]!.cardId;
      if (failure === 'orientation') input.basis.reversals = false;
      if (failure === 'position') input.basis.cards[1]!.position = 'situation';
      if (failure === 'seed') input.basis.seed = 'AA';
      await expect(buildPlan(input)).rejects.toThrow('BAD_INPUT');
    },
  );
  it('requires a followup parent and rejects an initial parent', async () => {
    const input = await syntheticPlanInput();
    input.operation = 'followup';
    await expect(buildPlan(input)).rejects.toThrow('BAD_INPUT');
    input.operation = 'initial';
    input.parentEditionId = input.requestId;
    await expect(buildPlan(input)).rejects.toThrow('BAD_INPUT');
  });
  it('validates one exact card fact and matching source per unit', async () => {
    const plan = await buildPlan(await syntheticPlanInput());
    const candidate = syntheticCandidate(plan);
    expect(() => validateCandidateBindings(plan, candidate)).not.toThrow();
    candidate.units[0]!.factIds.push('count:wands');
    expect(() => validateCandidateBindings(plan, candidate)).not.toThrow();
  });
  it.each([
    'unknownSource',
    'otherSource',
    'unknownFact',
    'wrongFact',
    'otherSuitCount',
    'duplicateFact',
    'duplicatePosition',
    'extraField',
  ])('rejects candidate %s bindings', async (failure) => {
    const plan = await buildPlan(await syntheticPlanInput());
    const c = syntheticCandidate(plan);
    if (failure === 'unknownSource') c.units[0]!.sourceIds = ['unknown'];
    if (failure === 'otherSource') c.units[0]!.sourceIds = c.units[1]!.sourceIds;
    if (failure === 'unknownFact') c.units[0]!.factIds = ['unknown'];
    if (failure === 'wrongFact') c.units[0]!.factIds = ['card:tension'];
    if (failure === 'otherSuitCount') c.units[0]!.factIds.push('count:swords');
    if (failure === 'duplicateFact') c.units[0]!.factIds.push('card:situation');
    if (failure === 'duplicatePosition') c.units[1]!.position = 'situation';
    if (failure === 'extraField') Object.assign(c, { privateReasoning: 'unexpected' });
    expect(() => validateCandidateBindings(plan, c)).toThrow('INVALID_CANDIDATE');
  });
});
