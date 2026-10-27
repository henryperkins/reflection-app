import { READING_PROVIDER_POLICY } from '../../src/contracts/provider-policy.ts';
import { describe, expect, it } from 'vitest';
import { buildPlan, bundleHash, sourceHash } from '../../src/domain/tarot/plan.ts';
import { composeTemplate, projectWriterPayload } from '../../src/domain/tarot/render.ts';
import { syntheticPlanInput, TEST_HASH, TEST_IDS } from '../fixtures/canon.ts';
function fragment(text: string, ordinal = 0) {
  return {
    ordinal,
    grantId: TEST_IDS.grant,
    grantRevision: 1,
    sourceKind: 'reflection_revision' as const,
    sourceId: TEST_IDS.source,
    sourceRevision: 1,
    start: 0,
    end: Array.from(text).length,
    text,
    textHash: TEST_HASH,
    availability: 'retained' as const,
    authorship: 'user' as const,
  };
}
async function payload(plan: Parameters<typeof projectWriterPayload>[0]) {
  return JSON.parse(
    new TextDecoder().decode(await projectWriterPayload(plan, READING_PROVIDER_POLICY)),
  );
}
describe('shared template and egress plan', () => {
  it('composes exact approved fallback beside controlled facts and the approved question', async () => {
    const plan = await buildPlan(await syntheticPlanInput());
    const template = await composeTemplate(plan);
    expect(template.label).toBe('Prepared reflection template');
    expect(template.question).toBe(plan.question);
    expect(template.facts).toHaveLength(7);
    expect(template.units.map((u) => u.interpretation)).toEqual(
      plan.sources.map((s) => s.fallbackText),
    );
    expect(template.units[0]!.basisText).toBe('The situation card is wands-08 (reversed).');
    expect(template.units.map((u) => u.sourceIds)).toEqual(plan.sources.map((s) => [s.id]));
  });
  it('uses the same selected sources and code-rendered facts in writer projection', async () => {
    const plan = await buildPlan(await syntheticPlanInput());
    const template = await composeTemplate(plan);
    const body = await payload(plan);
    const data = JSON.parse(body.input[2].content);
    expect(data.facts).toEqual(template.facts);
    expect(data.sources.map((s: { id: string; text: string }) => [s.id, s.text])).toEqual(
      plan.sources.map((s) => [s.id, s.text]),
    );
    expect(body.text.format.schema.properties.units.items.properties.sourceIds.items.enum).toEqual(
      plan.sources.map((s) => s.id),
    );
    expect(body.model).toBe('gpt-6.1-terra');
    expect(body.service_tier).toBe('default');
    expect(body.prompt_cache_options).toEqual({ mode: 'implicit', ttl: '30m' });
    expect(body.store).toBe(false);
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.max_output_tokens).toBe(1600);
    expect(body).not.toHaveProperty('tools');
    expect(body).not.toHaveProperty('previous_response_id');
  });
  it('includes only explicitly selected fragments with authorship and excludes private metadata', async () => {
    const input = await syntheticPlanInput();
    input.selected = [fragment('SELECTED_TEXT_SENTINEL')];
    const plan = await buildPlan(input);
    const encoded = new TextDecoder().decode(
      await projectWriterPayload(plan, READING_PROVIDER_POLICY),
    );
    const body = JSON.parse(encoded);
    const data = JSON.parse(body.input[2].content);
    expect(data.selected).toEqual([
      { label: 'selection:0', authorship: 'user', text: 'SELECTED_TEXT_SENTINEL' },
    ]);
    for (const forbidden of [
      TEST_IDS.request,
      TEST_IDS.basis,
      TEST_IDS.grant,
      TEST_IDS.source,
      plan.basis.seed,
      'PRIVATE_RIGHTS_SENTINEL',
      'reviewer',
      'reviewedAt',
      'grantId',
      'sourceRevision',
      'permissionRevision',
      'requestId',
      'basisId',
    ])
      expect(encoded).not.toContain(forbidden);
    const template = await composeTemplate(plan);
    expect(JSON.stringify(template)).not.toContain('SELECTED_TEXT_SENTINEL');
  });
  it('labels followup templates as another prompt based on the original draw', async () => {
    const input = await syntheticPlanInput();
    input.operation = 'followup';
    input.parentEditionId = TEST_IDS.parent;
    expect((await composeTemplate(await buildPlan(input))).closing).toContain(
      'another reflection prompt based on the original draw',
    );
  });
  it('preserves source, question and selected text exactly without truncation', async () => {
    const input = await syntheticPlanInput();
    input.question = 'Q'.repeat(500);
    input.selected = [fragment('é'.repeat(900))];
    const chosen = input.content.sources.find(
      (s) => s.cardId === 'wands-08' && s.orientation === 'reversed',
    )!;
    chosen.text = 'Exact source. '.repeat(85);
    chosen.hash = await sourceHash(chosen);
    chosen.review.reviewedHash = chosen.hash;
    input.content.editionHash = await bundleHash(input.content);
    const plan = await buildPlan(input);
    const data = JSON.parse((await payload(plan)).input[2].content);
    expect(data.question).toBe(input.question);
    expect(data.selected[0].text).toBe(input.selected[0]!.text);
    expect(data.sources.map((s: { text: string }) => s.text)).toEqual(
      plan.sources.map((s) => s.text),
    );
  });
  it('rejects exact payload/token overflow without dropping required content', async () => {
    const input = await syntheticPlanInput();
    input.selected = [
      fragment('密'.repeat(1200), 0),
      fragment('密'.repeat(1200), 1),
      fragment('密'.repeat(600), 2),
    ];
    const plan = await buildPlan(input);
    await expect(projectWriterPayload(plan, READING_PROVIDER_POLICY)).rejects.toThrow(
      'INPUT_TOO_LARGE',
    );
  });
  it.each(['erased', 'offset', 'ordinal', 'aggregate'])(
    'rejects invalid selected %s context',
    async (failure) => {
      const input = await syntheticPlanInput();
      input.selected = [fragment('private')];
      if (failure === 'erased') input.selected[0]!.availability = 'erased';
      if (failure === 'offset') input.selected[0]!.end = 8;
      if (failure === 'ordinal') input.selected[0]!.ordinal = 1;
      if (failure === 'aggregate')
        input.selected = [
          fragment('a'.repeat(1200), 0),
          fragment('b'.repeat(1200), 1),
          fragment('c'.repeat(601), 2),
        ];
      await expect(buildPlan(input)).rejects.toThrow(
        failure === 'aggregate' ? 'INPUT_TOO_LARGE' : 'CONTEXT_CHANGED',
      );
    },
  );
  it('uses Unicode code-point offsets for retained fragments', async () => {
    const input = await syntheticPlanInput();
    input.selected = [fragment('A😀B')];
    const plan = await buildPlan(input);
    expect(JSON.parse((await payload(plan)).input[2].content).selected[0].text).toBe('A😀B');
  });
  it('rejects post-preparation source tampering at both composition boundaries', async () => {
    const plan = await buildPlan(await syntheticPlanInput());
    plan.sources[0]!.fallbackText = 'changed';
    await expect(composeTemplate(plan)).rejects.toThrow('CONTENT_UNAVAILABLE');
    await expect(projectWriterPayload(plan, READING_PROVIDER_POLICY)).rejects.toThrow(
      'CONTENT_UNAVAILABLE',
    );
  });
  it('does not accept extra plan fields as an egress side channel', async () => {
    const plan = await buildPlan(await syntheticPlanInput());
    Object.assign(plan, { ownerSecret: 'PRIVATE_OWNER_SENTINEL' });
    await expect(projectWriterPayload(plan, READING_PROVIDER_POLICY)).rejects.toThrow('BAD_INPUT');
  });
});
