import { expect, test } from 'vitest';
import { READING_V2_EVALUATION_POLICY as policy } from '../../src/contracts/provider-policy.ts';
import { buildPlanV2 } from '../../src/domain/tarot/context-v2.ts';
import {
  composeTemplateV2,
  prepareWriterV2,
  writerIdentitiesV2,
} from '../../src/domain/tarot/writer-v2.ts';
import { OpenAIResponsesTransport } from '../../src/worker/provider/transport.ts';
import { v2Input } from '../fixtures/canon-v2.ts';

test.each([2, 1])(
  'v2 transport parses only the requested schema, returned version %s',
  async (version) => {
    const setup = await v2Input();
    Object.assign(setup, await writerIdentitiesV2());
    const plan = await buildPlanV2(setup),
      { payload } = await prepareWriterV2(plan),
      candidate = await composeTemplateV2(plan);
    const returned =
      version === 2
        ? candidate
        : {
            schemaVersion: 1,
            kind: 'tarot.interpretation.v1',
            units: candidate.units.map(({ contextRefs: _refs, ...u }) => ({
              ...u,
              reflectionQuestion: 'What feels useful?',
            })),
            closing: 'Keep what fits.',
          };
    let calls = 0;
    const transport = new OpenAIResponsesTransport({
      apiKey: 'synthetic-test-key',
      policy,
      fetch: async (_url, init) => {
        calls++;
        expect(new Uint8Array(init!.body as Uint8Array)).toEqual(payload);
        return Response.json({
          id: 'synthetic-v2',
          model: policy.model,
          service_tier: 'fast',
          status: 'completed',
          error: null,
          usage: {
            input_tokens: 200,
            input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
            output_tokens: 100,
            output_tokens_details: { reasoning_tokens: 10 },
            total_tokens: 300,
          },
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: JSON.stringify(returned) }],
            },
          ],
        });
      },
    });
    const result = await transport.write({
      dispatchId: 'synthetic',
      model: policy.model,
      payload,
      timeoutMs: policy.timeoutMs,
      maxOutputTokens: policy.request.max_output_tokens,
      store: false,
      reasoning: 'xhigh',
      signal: new AbortController().signal,
    });
    expect(calls).toBe(1);
    expect(result.kind).toBe(version === 2 ? 'candidate' : 'invalid');
    expect(result.receipt?.usage.outputTokens).toBe(100);
  },
);
