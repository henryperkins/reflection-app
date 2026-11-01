/** Shared admission rules; authored text is never trimmed or normalized. */
export const REVISIT_LIMITS = {
  textCodePoints: 2000,
  activePerEdition: 100,
  revisionsPerNote: 100,
  pageDefault: 20,
  pageMax: 50,
  idempotencyMs: 604800000,
} as const;

export function revisitTextLength(text: string): number {
  return Array.from(text).length;
}
