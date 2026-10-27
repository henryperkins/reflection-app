import { expect, test } from 'vitest';
import { syntheticPlanInput } from '../fixtures/canon.ts';
import { buildPlan, bundleHash } from '../../src/domain/tarot/plan.ts';
import { composeTemplate } from '../../src/domain/tarot/render.ts';
import { PreparedPlan } from '../../src/contracts/index.ts';
test('new plans snapshot the reviewed fallback closing and old plans retain their exact shape', async () => {
  const input = await syntheticPlanInput();
  input.content.productCopy.initialClosing = 'Pause to consider what feels useful.';
  input.content.editionHash = await bundleHash(input.content);
  const plan = await buildPlan(input);
  expect((await composeTemplate(plan)).closing).toBe(input.content.productCopy.initialClosing);
  const { fallbackClosing: _closing, ...old } = plan;
  expect(PreparedPlan.parse(old)).toEqual(old);
  expect((await composeTemplate(old)).closing).toBe(
    'Use these prompts to reflect on what feels relevant to you.',
  );
});
