import { expect, test } from 'vitest';
import { priceReceipt } from '../../src/domain/provider-cost.ts';
import { READING_PROVIDER_POLICY } from '../../src/contracts/provider-policy.ts';
import { providerReceipt } from '../fixtures/provider.ts';

test.each([
  [1000, 200, 300, 100, 0, 1385],
  [8000, 0, 8000, 1600, 0, 18000],
  [1, 1, 0, 0, 0, 1],
  [1, 0, 1, 0, 0, 2],
  [0, 0, 0, 100, 80, 500],
  [0, 0, 0, 0, 0, 0],
])(
  'prices disjoint input/cache/output categories and rounds the total once (%j)',
  (input, cached, writes, output, reasoning, expected) => {
    const receipt = providerReceipt({
      returnedModel: 'gpt-6.1-terra',
      usage: {
        inputTokens: input!,
        cachedInputTokens: cached!,
        cacheWriteTokens: writes!,
        outputTokens: output!,
        reasoningTokens: reasoning!,
      },
    });
    expect(priceReceipt(receipt, READING_PROVIDER_POLICY)).toEqual({ actualMicrousd: expected });
  },
);

test.each(['model', 'tier', 'cache', 'reasoning', 'negative', 'unsafe'])(
  'unqualified or inconsistent %s usage is unknown rather than zero',
  (kind) => {
    const receipt = providerReceipt({ returnedModel: 'gpt-6.1-terra' });
    if (kind === 'model') receipt.returnedModel = 'unqualified-model';
    if (kind === 'tier') receipt.serviceTier = 'flex';
    if (kind === 'cache') {
      receipt.usage.cachedInputTokens = 20;
      receipt.usage.cacheWriteTokens = 1;
    }
    if (kind === 'reasoning') receipt.usage.reasoningTokens = 31;
    if (kind === 'negative') receipt.usage.inputTokens = -1;
    if (kind === 'unsafe') receipt.usage.outputTokens = Number.MAX_SAFE_INTEGER;
    expect(priceReceipt(receipt, READING_PROVIDER_POLICY)).toBeNull();
  },
);
