import { ProviderReceipt } from '../contracts/index.ts';
import type { WriterProviderPolicy } from '../contracts/provider-policy.ts';

/** Cache reads/writes are disjoint input subsets. Reasoning is already included in output. */
export function priceReceipt(
  value: ProviderReceipt,
  policy: WriterProviderPolicy,
): { actualMicrousd: number } | null {
  const parsed = ProviderReceipt.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.returnedModel !== policy.model ||
    parsed.data.serviceTier !== policy.request.service_tier ||
    policy.priceBasis.currency !== 'USD' ||
    policy.priceBasis.rounding !== 'ceil-total-microusd' ||
    policy.request.prompt_cache_options.ttl !== '30m'
  )
    return null;
  const p = policy.priceBasis,
    u = parsed.data.usage;
  const rates = [
    p.inputMicrousdPerMillion,
    p.cachedInputMicrousdPerMillion,
    p.cacheWriteMicrousdPerMillion,
    p.outputMicrousdPerMillion,
  ];
  if (rates.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  const weighted =
    BigInt(u.inputTokens - u.cachedInputTokens - u.cacheWriteTokens) * BigInt(rates[0]!) +
    BigInt(u.cachedInputTokens) * BigInt(rates[1]!) +
    BigInt(u.cacheWriteTokens) * BigInt(rates[2]!) +
    BigInt(u.outputTokens) * BigInt(rates[3]!);
  const rounded = (weighted + 999999n) / 1000000n;
  return rounded > BigInt(Number.MAX_SAFE_INTEGER) ? null : { actualMicrousd: Number(rounded) };
}
