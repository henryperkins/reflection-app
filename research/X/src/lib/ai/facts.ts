/**
 * Facts supplied to the language layer. Citation validation checks supplied IDs
 * and coverage; it cannot prove semantic support for arbitrary generated prose.
 * Daily facts contain only the selected astronomical plan and curated copy.
 */
import {
  transitStoryFacts,
  assertTransitStoryFacts,
  storyFactSchema,
  type StoryFact,
} from "./transit-story-facts";
import type { TransitChapter } from "../astro/transit-episodes";
import { primaryStoryOverlay } from "../astro/transit-presentation";
import { ENGINE_ID, ENGINE_VERSION } from "../astro/ephemeris";
import type { AssembledReading } from "../reading.server";
import { localDayString } from "../local-day";
import { aspectFamily, safetyPass } from "../content/default-bundle";
import { NATAL_LENS_PLAN_VERSION, type DailyNatalLensPlan } from "../content/natal-lens";
import { NATAL_RELIABILITY_VERSION, validateNatalReliability } from "../astro/natal-reliability";
import { NATAL_BODY_ROLE } from "../content/natal-lens-types";
import {
  natalLensWordingProblem,
  natalMechanismHasTechnicalClaim,
} from "../content/natal-lens-policy";

export interface FactAtom {
  id: string;
  statement: string;
  kind?: "calculation" | "interpretation" | "synthesis" | "temperament";
  natalEvidenceId?: "NL1";
  arc?: StoryFact;
  storyChapter?: TransitChapter;
  dependsOn?: string[];
  sourceKey?: string;
  releaseVersion?: string;
  /** Typed references support bounded daily contradiction checks, not a semantic proof. */
  cycle?: {
    transitBody: string;
    natalPoint: string;
    aspect: string;
    orb: number;
    exactDate: string | null;
  };
}

export interface ChartFactInput {
  engine: string;
  engineVersion: string;
  houseSystem: string;
  precision: string;
  uncertainty: {
    accuracy: string;
    minutes: number;
    ascendantSpreadDeg: number;
    housesReliable: boolean;
    angleClaimsSuppressed: boolean;
  };
}

export interface CycleFactInput {
  cycle_key: string;
  transit_body: string;
  natal_point: string;
  aspect: string;
  orb: number;
  phase: string;
  domain: string;
  importance: number;
  exact_at: string | null;
}

/** The model receives exactly the plan used by the template, without local context. */
export function readingFacts(
  chart: ChartFactInput,
  plan: Pick<AssembledReading, "eligibleCycles" | "editorial" | "interpretationPlan"> &
    Partial<Pick<AssembledReading, "natalLensPlan" | "transitStoryPlan" | "storyCalculation">>,
  timeZone = "UTC",
): FactAtom[] {
  const facts: FactAtom[] = [];
  plan.eligibleCycles.forEach((c, i) => {
    const overlay = primaryStoryOverlay(plan.storyCalculation, c.cycle_key);
    const orb = overlay?.referenceOrb ?? c.orb;
    const exactDate = overlay
      ? overlay.qualifiedExactDay
      : c.exact_at
        ? localDayString(new Date(c.exact_at), timeZone)
        : null;
    const parts = [
      `transiting ${c.transit_body} ${c.aspect} natal ${c.natal_point}`,
      `Current orb at the reading's calculation time: ${orb.toFixed(2)} degrees`,
      `phase ${overlay?.phase ?? c.phase}`,
      `domain ${c.domain}`,
      exactDate
        ? `Calculated exact date: ${exactDate}`
        : overlay
          ? "No single exact calendar day is qualified for this contact"
          : "No exact date was found inside the scanned window",
    ];
    facts.push({
      id: `C${i + 1}`,
      kind: "calculation",
      statement: `${parts.join(". ")}.`,
      cycle: {
        transitBody: c.transit_body,
        natalPoint: c.natal_point,
        aspect: c.aspect,
        orb,
        exactDate,
      },
    });
  });

  for (const interpretation of plan.interpretationPlan.interpretations) {
    facts.push({
      id: `I${interpretation.index}`,
      statement: `Published interpretation ${interpretation.interpretationKey}: ${interpretation.mechanism}`,
      kind: "interpretation",
      dependsOn: [`C${interpretation.index}`],
      sourceKey: interpretation.interpretationKey,
      releaseVersion: plan.interpretationPlan.releaseVersion,
    });
  }
  const synthesis = plan.interpretationPlan.synthesis;
  if (synthesis) {
    facts.push({
      id: "S1",
      statement: `Published ${synthesis.relationship} synthesis ${synthesis.ruleKey} (parents: ${synthesis.dependsOn.join(", ")}): ${synthesis.mechanism}`,
      kind: "synthesis",
      dependsOn: [...synthesis.dependsOn],
      sourceKey: synthesis.ruleKey,
      releaseVersion: synthesis.releaseVersion,
    });
  }
  const lens = plan.natalLensPlan?.lens;
  if (lens)
    facts.push({
      id: "N1",
      kind: "temperament",
      statement: `Published natal lens, an interpretive possibility: ${lens.mechanism}`,
      dependsOn: [...lens.dependsOn],
      sourceKey: lens.ruleKey,
      releaseVersion: plan.natalLensPlan!.releaseVersion,
      natalEvidenceId: lens.evidenceId,
    });
  if (plan.transitStoryPlan) facts.push(...transitStoryFacts(plan.transitStoryPlan));
  if (plan.editorial) {
    if (plan.editorial.domain)
      facts.push({
        id: "D1",
        statement: `Published framing for ${plan.editorial.domain.label}: ${plan.editorial.domain.text}`,
      });
    if (plan.editorial.phase.text)
      facts.push({ id: "P1", statement: `Published phase wording: ${plan.editorial.phase.text}` });
    facts.push({ id: "T1", statement: plan.editorial.timing });
  }
  facts.push({
    id: "E1",
    statement: `Natal positions computed by ${chart.engine} ${chart.engineVersion} at ${chart.precision} precision${chart.uncertainty.housesReliable ? `, ${chart.houseSystem} houses` : ""}. ${plan.storyCalculation?.status === "qualified" && plan.storyCalculation.timingOverlay.referenceOrb !== undefined ? "Primary current transit geometry, orb and event timing use source-qualified Swiss Ephemeris. Other transit geometry and orbs use " : "Current transit geometry and orb use "}${ENGINE_ID}@${ENGINE_VERSION}.`,
  });
  facts.push({
    id: "U1",
    statement: `recorded birth-time accuracy is "${chart.uncertainty.accuracy}" (about plus or minus ${chart.uncertainty.minutes} minutes)`,
  });
  if (chart.uncertainty.angleClaimsSuppressed) {
    facts.push({
      id: "U2",
      statement:
        "All Ascendant and house-placement claims are suppressed. Their caveat will be appended separately; do not draft those claims or repeat the caveat.",
    });
  } else if (!chart.uncertainty.housesReliable) {
    facts.push({
      id: "U2",
      statement:
        "House-placement claims are suppressed and angle claims are weighted down. Their caveat will be appended separately; do not draft house claims or repeat the caveat.",
    });
  }
  if (plan.natalLensPlan) assertNatalLensFact(facts, plan.natalLensPlan);
  return facts;
}

export interface FeatureFactInput {
  feature_key: string;
  family: string;
  title: string;
  strength: number;
  payload: unknown;
}

/** Put the effective bundle's human meaning before the calculation reference sheet. */
export function dailyFactBlock(facts: FactAtom[]): string {
  const synthesis = facts.filter((fact) => fact.id === "S1");
  const primary = facts.filter((fact) => fact.id === "I1");
  const natal = facts.filter((fact) => fact.id === "N1");
  const supporting = facts.filter((fact) => /^I[23]$/.test(fact.id));
  const optional = facts.filter((fact) => /^(D1|P1|T1)$/.test(fact.id));
  const reference = facts.filter((fact) => !/^(N1|S1|I[123]|D1|P1|T1)$/.test(fact.id));
  return [
    ...(synthesis.length
      ? ["Published relationship of the strongest two contacts:", factBlock(synthesis)]
      : []),
    "Curated meaning of the strongest cycle (C1):",
    factBlock(primary),
    ...(natal.length
      ? ["Conditional interpretive lens for the primary meaning:", factBlock(natal)]
      : []),
    ...(supporting.length
      ? ["Separately published supporting meanings:", factBlock(supporting)]
      : []),
    "Optional framing for that same cycle; cite only what you use:",
    factBlock(optional),
    "Calculated references and limits; use these to check any technical claims:",
    factBlock(reference),
  ].join("\n");
}

/**
 * Editorial writers receive source identity and contact geometry, not the
 * legacy prose attached to those sources. Full facts remain in the audit and
 * validation input. Orb, timing, phase and unrelated framing are not body copy
 * in this warm/standard policy.
 */
export function dailyEditorialReferences(facts: FactAtom[], requiredFacts: string[]) {
  return {
    references: requiredFacts.map((id) => {
      const fact = facts.find((item) => item.id === id);
      if (!fact || !/^(?:C[1-3]|I[1-3]|S1)$/.test(id)) throw new InvalidDailyFactGraph();
      if (fact.cycle) {
        const { transitBody, natalPoint, aspect } = fact.cycle;
        return {
          id,
          kind: fact.kind,
          cycleKey: `${transitBody}_${aspect}_${natalPoint}`,
          cycle: { transitBody, natalPoint, aspect },
        };
      }
      return {
        id,
        kind: fact.kind,
        sourceKey: fact.sourceKey,
        releaseVersion: fact.releaseVersion,
        dependsOn: [...(fact.dependsOn ?? [])],
      };
    }),
  };
}

export class InvalidDailyFactGraph extends Error {
  constructor() {
    super("Invalid daily fact graph");
    this.name = "InvalidDailyFactGraph";
  }
}

export function assertNatalLensFact(facts: FactAtom[], plan: DailyNatalLensPlan): void {
  assertDailyFactGraph(facts);
  const natal = facts.filter((f) => f.id === "N1" || f.kind === "temperament");
  const lens = plan.lens;
  if (
    plan.version !== NATAL_LENS_PLAN_VERSION ||
    (plan.status === "selected") !== !!lens ||
    (!lens && natal.length)
  )
    throw new InvalidDailyFactGraph();
  if (!lens) return;
  const fact = natal[0],
    cycle = facts.find((f) => f.id === "C1")?.cycle;
  if (
    natal.length !== 1 ||
    !fact ||
    plan.reliabilityVersion !== NATAL_RELIABILITY_VERSION ||
    fact.statement !== `Published natal lens, an interpretive possibility: ${lens.mechanism}` ||
    fact.sourceKey !== lens.ruleKey ||
    fact.releaseVersion !== plan.releaseVersion ||
    fact.natalEvidenceId !== lens.evidenceId ||
    lens.dependsOn.join(",") !== "C1,I1" ||
    lens.evidenceId !== "NL1" ||
    !cycle ||
    lens.anchorCycleKey !== `${cycle.transitBody}_${cycle.aspect}_${cycle.natalPoint}` ||
    !lens.evidence.length ||
    natalLensWordingProblem(lens.mechanism) ||
    natalMechanismHasTechnicalClaim(lens.mechanism)
  )
    throw new InvalidDailyFactGraph();
  validateNatalReliability(
    {
      version: NATAL_RELIABILITY_VERSION,
      chartFingerprint: "selected-private-proof",
      status: "screened",
      reason: null,
      ...lens.screen,
      evidence: lens.evidence,
    },
    "selected-private-proof",
    lens.screen.accuracy,
  );
  const sign = lens.evidence[0],
    extra = lens.evidence[1];
  if (
    sign?.kind !== "sign" ||
    NATAL_BODY_ROLE[sign.body] !== lens.role ||
    lens.evidence.length > 2 ||
    (sign.body !== "moon" && sign.body !== cycle.natalPoint) ||
    extra?.kind === "sign" ||
    (extra?.kind === "house" && extra.body !== sign.body) ||
    (extra?.kind === "aspect" &&
      (![extra.a, extra.b].includes(sign.body) || Math.max(...extra.orbs) > 3)) ||
    safetyPass(lens.mechanism).flagged.length
  )
    throw new InvalidDailyFactGraph();
}

/** Validate new editorial dependencies while keeping plain historical atoms usable. */
export function assertDailyFactGraph(facts: FactAtom[]): void {
  const invalid = (): never => {
    throw new InvalidDailyFactGraph();
  };
  if (
    !Array.isArray(facts) ||
    facts.length > 30 ||
    facts.some((fact) => !fact || typeof fact !== "object")
  )
    invalid();
  const byId = new Map(facts.map((fact) => [fact.id, fact]));
  if (byId.size !== facts.length) invalid();
  const editorialVersions = new Set<string>();
  for (const fact of facts) {
    if (
      typeof fact.id !== "string" ||
      !/^[A-Z]{1,2}\d{1,3}$/.test(fact.id) ||
      typeof fact.statement !== "string"
    )
      invalid();
    if (
      fact.kind !== undefined &&
      !["calculation", "interpretation", "synthesis", "temperament"].includes(fact.kind)
    )
      invalid();
    if (
      fact.sourceKey !== undefined &&
      (typeof fact.sourceKey !== "string" ||
        fact.sourceKey.length < 1 ||
        fact.sourceKey.length > 100)
    )
      invalid();
    if (
      fact.releaseVersion !== undefined &&
      (typeof fact.releaseVersion !== "string" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(fact.releaseVersion))
    )
      invalid();
    if (
      fact.dependsOn !== undefined &&
      (!Array.isArray(fact.dependsOn) ||
        new Set(fact.dependsOn).size !== fact.dependsOn.length ||
        fact.dependsOn.some((id) => !byId.has(id) || id === fact.id))
    )
      invalid();
    const enriched =
      fact.kind !== undefined ||
      fact.sourceKey !== undefined ||
      fact.releaseVersion !== undefined ||
      fact.dependsOn !== undefined;
    if (/^I[123]$/.test(fact.id) && enriched) {
      const parent = `C${fact.id.slice(1)}`;
      const cycle = byId.get(parent)?.cycle;
      if (
        fact.kind !== "interpretation" ||
        fact.dependsOn?.length !== 1 ||
        fact.dependsOn[0] !== parent ||
        !cycle ||
        !fact.sourceKey ||
        !fact.releaseVersion ||
        fact.cycle
      )
        invalid();
      const [aspect, body, point, extra] = fact.sourceKey!.split(":");
      if (
        extra !== undefined ||
        !point ||
        (aspect !== cycle!.aspect && aspect !== aspectFamily(cycle!.aspect)) ||
        (body !== "*" && body !== cycle!.transitBody) ||
        (point !== "*" && point !== cycle!.natalPoint)
      )
        invalid();
      editorialVersions.add(fact.releaseVersion!);
    }
    if (fact.id === "S1") {
      const parents = ["C1", "I1", "C2", "I2"];
      if (
        fact.kind !== "synthesis" ||
        fact.cycle ||
        !fact.sourceKey ||
        !fact.releaseVersion ||
        fact.dependsOn?.length !== 4 ||
        !parents.every((id, index) => fact.dependsOn![index] === id && byId.has(id))
      )
        invalid();
      for (const id of ["I1", "I2"]) {
        const parent = byId.get(id)!;
        if (
          parent.kind !== "interpretation" ||
          !parent.sourceKey ||
          parent.sourceKey.includes("*") ||
          parent.sourceKey.split(":")[0] !== byId.get(`C${id.slice(1)}`)?.cycle?.aspect ||
          parent.releaseVersion !== fact.releaseVersion
        )
          invalid();
      }
      editorialVersions.add(fact.releaseVersion!);
    } else if (fact.kind === "synthesis") invalid();
    if (
      /^N\d+$/.test(fact.id) ||
      fact.kind === "temperament" ||
      fact.natalEvidenceId !== undefined
    ) {
      if (
        fact.id !== "N1" ||
        fact.kind !== "temperament" ||
        fact.cycle ||
        !fact.sourceKey ||
        !fact.releaseVersion ||
        fact.natalEvidenceId !== "NL1" ||
        fact.dependsOn?.join(",") !== "C1,I1" ||
        byId.get("I1")?.kind !== "interpretation" ||
        byId.get("I1")?.releaseVersion !== fact.releaseVersion ||
        !byId.get("C1")?.cycle ||
        !fact.statement.startsWith("Published natal lens, an interpretive possibility: ") ||
        fact.statement.length > 760 ||
        natalLensWordingProblem(fact.statement) ||
        safetyPass(fact.statement).flagged.length ||
        natalMechanismHasTechnicalClaim(
          fact.statement.slice("Published natal lens, an interpretive possibility: ".length),
        )
      )
        invalid();
      editorialVersions.add(fact.releaseVersion!);
    }
  }
  if (editorialVersions.size > 1) invalid();
  try {
    assertTransitStoryFacts(facts);
  } catch {
    invalid();
  }
  const visited = new Set<string>(),
    pending = new Set<string>();
  const visit = (id: string): void => {
    if (pending.has(id)) invalid();
    if (visited.has(id)) return;
    pending.add(id);
    for (const parent of byId.get(id)!.dependsOn ?? []) visit(parent);
    pending.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

/** Safe persistence/hydration projection. Historical statements never acquire guessed metadata. */
export function readSavedFactAtoms(value: unknown): FactAtom[] {
  if (!Array.isArray(value)) return [];
  const facts: FactAtom[] = value.slice(0, 30).flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const f = raw as Record<string, unknown>;
    if (
      typeof f["id"] !== "string" ||
      !/^[A-Z]{1,2}\d{1,3}$/.test(f["id"]) ||
      typeof f["statement"] !== "string"
    )
      return [];
    const fact: FactAtom = { id: f["id"], statement: f["statement"] };
    if (["calculation", "interpretation", "synthesis", "temperament"].includes(String(f["kind"])))
      fact.kind = f["kind"] as NonNullable<FactAtom["kind"]>;
    if (f["arc"] !== undefined) {
      const parsed = storyFactSchema.safeParse(f["arc"]);
      if (parsed.success) fact.arc = parsed.data;
    }
    if (["single", "opening", "return", "closing", "between"].includes(String(f["storyChapter"])))
      fact.storyChapter = f["storyChapter"] as TransitChapter;
    if (f["natalEvidenceId"] === "NL1") fact.natalEvidenceId = "NL1";
    if (
      Array.isArray(f["dependsOn"]) &&
      f["dependsOn"].length <= 4 &&
      f["dependsOn"].every((id) => typeof id === "string" && /^[A-Z]{1,2}\d{1,3}$/.test(id))
    )
      fact.dependsOn = [...f["dependsOn"]] as string[];
    if (
      typeof f["sourceKey"] === "string" &&
      f["sourceKey"].length >= 1 &&
      f["sourceKey"].length <= 100
    )
      fact.sourceKey = f["sourceKey"];
    if (
      typeof f["releaseVersion"] === "string" &&
      /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(f["releaseVersion"])
    )
      fact.releaseVersion = f["releaseVersion"];
    if (/^C[123]$/.test(f["id"]) && f["cycle"] && typeof f["cycle"] === "object") {
      const c = f["cycle"] as Record<string, unknown>;
      if (
        [c["transitBody"], c["natalPoint"], c["aspect"]].every(
          (v) => typeof v === "string" && /^[a-z_]{1,40}$/.test(v),
        ) &&
        typeof c["orb"] === "number" &&
        Number.isFinite(c["orb"]) &&
        c["orb"] >= 0 &&
        c["orb"] <= 180 &&
        (c["exactDate"] === null ||
          (typeof c["exactDate"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(c["exactDate"])))
      ) {
        fact.cycle = {
          transitBody: c["transitBody"] as string,
          natalPoint: c["natalPoint"] as string,
          aspect: c["aspect"] as string,
          orb: c["orb"],
          exactDate: c["exactDate"] as string | null,
        };
      }
    }
    return [fact];
  });
  try {
    assertDailyFactGraph(facts);
    return facts;
  } catch {
    // An incomplete historical/corrupt graph may still be read as archived text;
    // no editorial dependency links or identity are asserted for it.
    return facts.map(({ id, statement, cycle }) => ({
      id,
      statement,
      ...(cycle ? { cycle } : {}),
    }));
  }
}

/** Facts for one natal chapter: the structure's own payload, flattened. */
export function featureFacts(
  feature: FeatureFactInput,
  chart: ChartFactInput,
  related: Pick<FeatureFactInput, "family" | "title" | "strength">[] = [],
): FactAtom[] {
  const facts: FactAtom[] = [
    {
      id: "N1",
      statement: `detected natal structure "${feature.title}" of family ${feature.family} (key ${feature.feature_key}), ${emphasisOf(feature.strength)}`,
    },
  ];

  const payload = feature.payload;
  if (payload && typeof payload === "object") {
    let i = 0;
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      i += 1;
      if (i > 12) break;
      const rendered =
        value === null || value === undefined
          ? "not present"
          : typeof value === "object"
            ? JSON.stringify(value).slice(0, 300)
            : String(value);
      facts.push({ id: `N${i + 1}`, statement: `${key}: ${rendered}` });
    }
  }

  related.slice(0, 3).forEach((r, i) => {
    facts.push({
      id: `R${i + 1}`,
      statement: `another detected structure in the same chart: "${r.title}" (family ${r.family}), ${emphasisOf(r.strength)}`,
    });
  });

  facts.push({
    id: "E1",
    statement: `Natal positions computed by ${chart.engine} ${chart.engineVersion} at ${chart.precision} precision, ${chart.houseSystem} houses`,
  });
  if (chart.uncertainty.angleClaimsSuppressed) {
    facts.push({
      id: "U2",
      statement:
        "birth time is too uncertain to use, so nothing may be said about the Ascendant or about house placement",
    });
  }

  return facts;
}

export function factBlock(facts: FactAtom[]): string {
  return facts.map((f) => `${f["id"]}: ${f["statement"]}`).join("\n");
}

export function factIds(facts: FactAtom[]): Set<string> {
  return new Set(facts.map((f) => f["id"]));
}

/** App ranking score -> plain words. The score is an internal ordering, not a measurement, so it never reaches prose as a number. */
function emphasisOf(strength: number): string {
  const s = Number(strength);
  if (s >= 0.8)
    return "ranked among the most prominent structures in this chart (an app ranking, not a measurement; never quote it as a number)";
  if (s >= 0.5)
    return "ranked as moderately prominent in this chart (an app ranking, not a measurement; never quote it as a number)";
  return "ranked as a quieter structure in this chart (an app ranking, not a measurement; never quote it as a number)";
}

