import { expect, test } from 'vitest';
import { prepareEvaluation } from '../../scripts/provider-evaluation-corpus.ts';
import { reviewRequestContract } from '../../scripts/provider-review-contract.ts';

test('review contract retains each case-specific source enum instead of presenting the first schema as universal', async () => {
  const prepared = await prepareEvaluation('human-review-fast-xhigh');
  const requests = prepared.requests.filter((r) => ['A07-2', 'A08-1'].includes(r.caseId));
  const result = reviewRequestContract(requests);
  expect(result).not.toHaveProperty('responseSchema');
  expect(result.schemaScope).toBe('fixed-within-case');
  expect(Object.keys(result.responseSchemasByCase)).toEqual(['A07-2', 'A08-1']);
  for (const request of requests) {
    const wire = JSON.parse(new TextDecoder().decode(request.input.payload));
    expect(result.responseSchemasByCase[request.caseId]).toEqual(wire.text);
    expect(result.requestSchemaHashes[request.id]).toMatch(/^[a-f0-9]{64}$/);
  }
  expect(result.responseSchemasByCase['A07-2']).not.toEqual(result.responseSchemasByCase['A08-1']);
});

test('review contract refuses a schema change hidden between arms of the same case', async () => {
  const prepared = await prepareEvaluation('human-review-fast-xhigh');
  const request = prepared.requests.find((r) => r.caseId === 'A07-2')!;
  const wire = JSON.parse(new TextDecoder().decode(request.input.payload));
  wire.text.format.schema.description = 'Unexpected arm-only schema change';
  const second = {
    ...request,
    id: 'changed-arm',
    input: { ...request.input, payload: new TextEncoder().encode(JSON.stringify(wire)) },
  };
  expect(() => reviewRequestContract([request, second])).toThrow('Schema differs within case');
});
