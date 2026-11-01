import { expect, test } from 'vitest';
import type { ProviderReceipt, SpreadRecognition } from '../../src/contracts/index.ts';
import { MetaSpreadRecognizer } from '../../src/worker/provider/meta-vision.ts';

const cards: SpreadRecognition['cards'] = [
  { position: 'situation', cardId: 'major-00', orientation: 'upright' },
  { position: 'tension', cardId: 'cups-05', orientation: 'reversed' },
  { position: 'possibility', cardId: 'wands-10', orientation: 'upright' },
];
const input = {
  spreadPhoto: 'data:image/png;base64,AAAA',
  deck: cards.map((card) => ({ id: card.cardId, name: card.cardId })),
};

test.each([null, { input_tokens: 10 }, { input_tokens: -1, output_tokens: 10 }])(
  'unverifiable usage keeps recognition usable without inventing a receipt: %j',
  async (usage) => {
    const receipts: ProviderReceipt[] = [];
    const recognizer = new MetaSpreadRecognizer({
      apiKey: 'synthetic-test-key',
      fetch: async () =>
        Response.json({
          status: 'completed',
          model: 'muse-spark-1.3',
          usage,
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: JSON.stringify({ cards }) }],
            },
          ],
        }),
    });
    expect(
      await recognizer.recognize({
        ...input,
        onReceipt: async (receipt) => {
          receipts.push(receipt);
        },
      }),
    ).toEqual({ cards });
    expect(receipts).toEqual([]);
  },
);

test('a Meta refusal still reports its billable usage and documented automatic tier', async () => {
  const receipts: ProviderReceipt[] = [];
  const recognizer = new MetaSpreadRecognizer({
    apiKey: 'synthetic-test-key',
    fetch: async () =>
      Response.json({
        id: 'resp_refusal',
        status: 'completed',
        model: 'muse-spark-1.3',
        service_tier: 'auto',
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 200 },
          output_tokens: 100,
          output_tokens_details: { reasoning_tokens: 10 },
        },
        output: [
          { type: 'message', content: [{ type: 'refusal', refusal: 'No matching spread.' }] },
        ],
      }),
  });
  await expect(
    recognizer.recognize({
      ...input,
      onReceipt: async (receipt) => {
        receipts.push(receipt);
      },
    }),
  ).rejects.toThrow('PROVIDER_REFUSAL');
  expect(receipts).toEqual([
    expect.objectContaining({
      responseId: 'resp_refusal',
      serviceTier: 'auto',
      usage: {
        inputTokens: 1000,
        cachedInputTokens: 200,
        cacheWriteTokens: 0,
        outputTokens: 100,
        reasoningTokens: 10,
      },
    }),
  ]);
});

test('a caller signal does not disable the recognition timeout', async () => {
  const recognizer = new MetaSpreadRecognizer({
    apiKey: 'synthetic-test-key',
    timeoutMs: 5,
    fetch: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener('abort', () => reject(new Error('Synthetic timeout')), {
          once: true,
        });
      }),
  });
  await expect(
    recognizer.recognize({ ...input, signal: new AbortController().signal }),
  ).rejects.toThrow('PROVIDER_UNAVAILABLE');
});
