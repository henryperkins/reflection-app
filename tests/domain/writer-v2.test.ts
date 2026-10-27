import { expect, test } from 'vitest';
import { z } from 'zod';
import { ModelCandidateV2 } from '../../src/contracts/index.ts';
import { READING_V2_EVALUATION_POLICY as policy } from '../../src/contracts/provider-policy.ts';
import { sha256Json } from '../../src/domain/json.ts';
import { providerPolicyHash } from '../../src/domain/provider-policy.ts';
import { buildPlanV2 } from '../../src/domain/tarot/context-v2.ts';
import { prepareWriterV2, composeTemplateV2 } from '../../src/domain/tarot/writer-v2.ts';
import { v2Input, relationship, rehashBundle, reviewHash } from '../fixtures/canon-v2.ts';

async function inputForPolicy() {
  const input = await v2Input();
  input.promptHash = await sha256Json(policy.prompt);
  input.validatorHash = await sha256Json({
    version: policy.validatorVersion,
    outputSchema: z.toJSONSchema(ModelCandidateV2),
  });
  input.generationPolicyHash = await providerPolicyHash(policy);
  return input;
}
test('complete v2 projection includes names, exact reader text, meanings and role definitions without private metadata', async () => {
  const input = await inputForPolicy(),
    plan = await buildPlanV2(input);
  const { payload, receipt } = await prepareWriterV2(plan);
  const text = new TextDecoder().decode(payload),
    wire = JSON.parse(text),
    data = JSON.parse(wire.input[2].content);
  expect(Object.keys(data)).toEqual([
    'reader',
    'draw',
    'facts',
    'spread',
    'meanings',
    'relationships',
    'selected',
    'preferences',
  ]);
  expect(data.reader).toEqual({ id: 'reader:question', text: input.question });
  expect(data.draw).toEqual(plan.draw);
  expect(data.spread).toEqual(plan.spread);
  expect(data.meanings[0]).toMatchObject({
    sourceId: plan.sources[0]!.id,
    core: plan.sources[0]!.meaning.core,
    distinctions: plan.sources[0]!.meaning.distinctions,
  });
  expect(data.selected).toEqual([]);
  expect(text).not.toContain('PRIVATE_RIGHTS_SENTINEL');
  expect(text).not.toContain('reviewedHash');
  expect(text).not.toContain(plan.requestId);
  expect(receipt).toMatchObject({
    contextHash: plan.contextHash,
    promptHash: input.promptHash,
    validatorHash: input.validatorHash,
    policyHash: input.generationPolicyHash,
    omissions: [],
  });
  expect(receipt.schemaHash).toBe(await sha256Json(wire.text.format.schema));
  expect(receipt.payloadBytes + 256).toBe(receipt.estimatedInputTokens);
  expect(receipt.estimatedInputTokens).toBeLessThanOrEqual(16384);
  expect(wire).toMatchObject({
    model: 'gpt-6.1-terra',
    reasoning: { effort: 'xhigh' },
    service_tier: 'fast',
    max_output_tokens: 8192,
  });
});
test('v2 budget drops relationships before imagery and never truncates required input', async () => {
  const input = await inputForPolicy();
  input.content.relationships = [
    await relationship(input, 'note:one'),
    await relationship(input, 'note:two', 20),
  ];
  for (const s of input.content.sources) {
    Object.assign(s.meaning, {
      imagery: {
        text: 'A verified catalog detail.',
        reference: 'Synthetic catalog only',
        verified: true,
      },
    });
    s.hash = await reviewHash(s);
    s.review.reviewedHash = s.hash;
  }
  await rehashBundle(input.content);
  const plan = await buildPlanV2(input),
    full = await prepareWriterV2(plan);
  const limited = {
    ...policy,
    estimator: {
      ...policy.estimator,
      maxPayloadBytes: full.payload.length - 1,
      maxInputTokens: full.payload.length + 255,
    },
  } as typeof policy;
  const reduced = await prepareWriterV2(plan, limited);
  expect(reduced.receipt.omissions[0]).toEqual({ kind: 'relationship', id: 'note:two' });
  const requiredInput = structuredClone(input);
  requiredInput.content.relationships = [];
  for (const s of requiredInput.content.sources) {
    s.meaning.imagery = null;
    s.hash = await reviewHash(s);
    s.review.reviewedHash = s.hash;
  }
  await rehashBundle(requiredInput.content);
  const minimum = await prepareWriterV2(await buildPlanV2(requiredInput));
  const tight = {
    ...policy,
    estimator: {
      ...policy.estimator,
      maxPayloadBytes: minimum.payload.length,
      maxInputTokens: minimum.payload.length + 256,
    },
  } as typeof policy;
  const required = await prepareWriterV2(plan, tight);
  expect(required.receipt.omissions.map((o) => o.kind)).toEqual([
    'relationship',
    'relationship',
    'imagery',
    'imagery',
    'imagery',
  ]);
  expect(
    JSON.parse(JSON.parse(new TextDecoder().decode(required.payload)).input[2].content).reader.text,
  ).toBe(input.question);
  await expect(
    prepareWriterV2(plan, {
      ...tight,
      estimator: { ...tight.estimator, maxPayloadBytes: 100, maxInputTokens: 356 },
    } as unknown as typeof policy),
  ).rejects.toThrow('INPUT_TOO_LARGE: required v2 writer context');
});
test('v2 fallback follows the new shape without three required questions', async () => {
  const plan = await buildPlanV2(await inputForPolicy()),
    template = await composeTemplateV2(plan);
  expect(ModelCandidateV2.safeParse(template).success).toBe(true);
  expect(template.units).toHaveLength(3);
  expect(template.units[0]).not.toHaveProperty('reflectionQuestion');
  expect(template.reflectionQuestion).toBeNull();
  expect(template.synthesis.sourceIds).toEqual(plan.sources.map((s) => s.id));
  expect(template.action.text).toBe(plan.fallbackV2.action);
});
test('v2 policy hash binds the actual v2 schema and rejects mismatched prompt identities', async () => {
  expect(await providerPolicyHash(policy)).toBe(
    await sha256Json({ policy, outputSchema: z.toJSONSchema(ModelCandidateV2) }),
  );
  const input = await inputForPolicy();
  input.promptHash = 'c'.repeat(64);
  await expect(prepareWriterV2(await buildPlanV2(input))).rejects.toThrow('POLICY_MISMATCH');
});
