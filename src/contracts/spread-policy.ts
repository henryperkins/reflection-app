/** Standard-mode rates reviewed 2026-10-31: https://dev.meta.ai/docs/pricing-rate-limits.
 * Reserve against the full context limit (https://dev.meta.ai/docs/models), since
 * a small compressed image can still decode to many image tokens. Settle from usage.
 */
export const SPREAD_PROVIDER_POLICY = {
  version: 'meta-spread.v1',
  model: 'muse-spark-1.3',
  // Meta echoes request-derived tiers; Standard pricing is selected by this model name.
  // https://dev.meta.ai/docs/protocols/responses
  serviceTiers: ['auto', 'default'],
  timeoutMs: 20_000,
  maxOutputTokens: 4096,
  reservationMicrousd: 1_328_128,
  priceBasis: {
    version: 'meta-spark-standard.2026-10-31',
    inputMicrousdPerMillion: 1_250_000,
    cachedInputMicrousdPerMillion: 150_000,
    outputMicrousdPerMillion: 4_250_000,
  },
} as const;
