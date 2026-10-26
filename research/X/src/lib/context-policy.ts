import { isPermitted, SOURCE_MAP, type AllowedUse } from "./registry";

export const LIFE_DOMAINS = [
  "identity",
  "relationships",
  "work",
  "inner-life",
  "structure",
] as const;
export type LifeDomain = (typeof LIFE_DOMAINS)[number];
export function isLifeDomain(value: unknown): value is LifeDomain {
  return typeof value === "string" && (LIFE_DOMAINS as readonly string[]).includes(value);
}

/** Consent permits a use, not reuse of expired, unavailable or unknown data. */
export function contextUseAllowed(
  sourceId: string,
  use: AllowedUse,
  granted: Set<string>,
  observedAt: string | Date | null,
  now: Date,
): boolean {
  const source = SOURCE_MAP[sourceId];
  if (
    !source ||
    source.phase !== "launch" ||
    source.available === false ||
    !isPermitted(sourceId, use, granted) ||
    !Number.isFinite(now.getTime())
  )
    return false;
  if (observedAt === null) return source.retention_days === null;
  const instant = observedAt instanceof Date ? observedAt.getTime() : Date.parse(observedAt);
  if (!Number.isFinite(instant) || instant > now.getTime()) return false;
  return (
    source.retention_days === null || now.getTime() < instant + source.retention_days * 86_400_000
  );
}

export interface LocalReadingContext {
  version: "local-context-1";
  identity: string;
  markedMoments: boolean;
  preferredDomain: LifeDomain | null;
  previousResonance: { score: -1 | 0 | 1; day: string } | null;
  solar?: import("./astro/solar-context.server").SolarContext | null;
  guidance?: import("./daily-guidance").DailyGuidance;
}

