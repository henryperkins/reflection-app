import { expect, test } from 'vitest';
import {
  READING_PROVIDER_POLICY,
  type ReadingProviderPolicy,
} from '../../src/contracts/provider-policy.ts';
import { providerPolicyHash } from '../../src/domain/provider-policy.ts';
import { buildPlan } from '../../src/domain/tarot/plan.ts';
import { projectWriterPayload } from '../../src/domain/tarot/render.ts';
import { syntheticPlanInput } from '../fixtures/canon.ts';

test('the policy produces a bounded, stateless Terra request with explicit Standard cache options', async () => {
  const bytes = await projectWriterPayload(
    await buildPlan(await syntheticPlanInput()),
    READING_PROVIDER_POLICY,
  );
  expect(JSON.parse(new TextDecoder().decode(bytes))).toMatchObject({
    model: 'gpt-6.1-terra',
    reasoning: { effort: 'none' },
    max_output_tokens: 1600,
    store: false,
    service_tier: 'default',
    prompt_cache_options: { mode: 'implicit', ttl: '30m' },
    text: { format: { type: 'json_schema', strict: true } },
  });
  expect(bytes.length).toBeLessThanOrEqual(28 * 1024);
  expect(bytes.length + 256).toBeLessThanOrEqual(8000);
});

test('policy identity is canonical across serialization and key insertion order', async () => {
  const reordered = Object.fromEntries(Object.entries(READING_PROVIDER_POLICY).reverse());
  const original = await providerPolicyHash(READING_PROVIDER_POLICY);
  expect(original).toMatch(/^[a-f0-9]{64}$/);
  expect(await providerPolicyHash(reordered as ReadingProviderPolicy)).toBe(original);
  expect(await providerPolicyHash(JSON.parse(JSON.stringify(READING_PROVIDER_POLICY)))).toBe(
    original,
  );
});

test.each<[string, unknown]>([
  ['model', 'gpt-5.6-terra'],
  ['endpoint', 'https://api.openai.com/v1/other'],
  ['request.store', true],
  ['request.reasoning.effort', 'low'],
  ['request.max_output_tokens', 1601],
  ['request.service_tier', 'flex'],
  ['request.prompt_cache_options.mode', 'explicit'],
  ['request.prompt_cache_options.ttl', '12h'],
  ['prompt.version', 'tarot-writer.v2'],
  ['prompt.system', 'Changed instructions'],
  ['prompt.developer', 'Changed constraints'],
  ['schemaVersion', 'tarot.interpretation.v2'],
  ['validatorVersion', 'bounded-english-reflection.v2'],
  ['estimator.version', 'different-estimator.v1'],
  ['estimator.framingTokens', 257],
  ['estimator.maxInputTokens', 8001],
  ['estimator.maxPayloadBytes', 28 * 1024 + 1],
  ['timeoutMs', 18001],
  ['reservationMicrousd', 40001],
  ['priceBasis.inputMicrousdPerMillion', 1000001],
  ['priceBasis.cachedInputMicrousdPerMillion', 50001],
  ['priceBasis.cacheWriteMicrousdPerMillion', 1250001],
  ['priceBasis.outputMicrousdPerMillion', 5000001],
])('a changed %s invalidates prior policy qualification', async (path, value) => {
  const changed = structuredClone(READING_PROVIDER_POLICY);
  const keys = path.split('.');
  let parent = changed as unknown as Record<string, unknown>;
  for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  parent[keys.at(-1)!] = value;
  expect(await providerPolicyHash(changed)).not.toBe(
    await providerPolicyHash(READING_PROVIDER_POLICY),
  );
});
