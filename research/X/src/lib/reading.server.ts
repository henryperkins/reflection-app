import { resolveDailyTransitStory, type DailyTransitStoryPlan } from "./content/transit-story";
import type { DailyTransitCalculation } from "./astro/transit-episodes";
import {
  applyPrimaryStoryCalculation,
  primaryStoryOverlay,
  storyTimingLine,
} from "./astro/transit-presentation";
import type { Chart } from "./astro/chart";
import type { CycleInstance } from "./astro/cycles";
import {
  aspectFamily,
  DEFAULT_BUNDLE,
  findInterpretation,
  safetyPass,
  type ContentBundle,
} from "./content/default-bundle";
import { exactPhrase } from "./astro/cycles";
import { resolveInterpretationPlan, type DailyInterpretationPlan } from "./content/synthesis";
import { resolveDailyNatalLens, type DailyNatalLensPlan } from "./content/natal-lens";
import { composeNatalTemplate } from "./content/natal-template";
import type { NatalReliabilityManifest } from "./astro/natal-reliability";
import { resolveDailyWritingPlan, type DailyWritingPlan } from "./content/daily-writing";
import { resolveDailyReflection, type DailyReflectionPlan } from "./content/daily-reflection";
import {
  PRIMARY_COMPOSITION_VERSION,
  PRIMARY_REFLECTION_VERSION,
  primaryReflection,
  includePrimaryPhase,
  primaryTechnicalGeometry,
} from "./content/primary-composition";
import {
  composeDailyWritingTemplate,
  type DailyWritingTemplate,
} from "./content/daily-writing-template";

/**
 * Cycle arc position, in plain language: how many days to the exact pass and
 * how far through the ingress -> egress window today sits.
 */
function arcParagraph(c: CycleInstance, technical: boolean, primaryComposition = false): string {
  const phrase = exactPhrase(c.days_to_exact ?? null);
  const pct =
    c.arc_position === null || c.arc_position === undefined
      ? null
      : Math.round(c.arc_position * 100);
  const where =
    pct === null
      ? "The scanned range does not contain both edges of the calculated window."
      : pct <= 25
        ? "This reading falls near the start of the calculated window."
        : pct <= 60
          ? "This reading falls in the middle part of the calculated window."
          : "This reading falls in the later part of the calculated window.";
  return `${technical && primaryComposition ? `${primaryTechnicalGeometry(c)} ` : ""}Timing: ${phrase}. ${where}${technical ? `${pct !== null ? ` The calculated arc position is ${pct}%.` : ""}${primaryComposition ? "" : ` Current orb at the reading's calculation time: ${c.orb}\u00b0.`}` : ""}`;
}
import { assertUse, isPermitted, type AllowedUse } from "./registry";

export interface ReadingContext {
  /** Explicit civil day for the optional editorial quiet repertoire. */
  day?: string;
  granted: Set<string>;
  tone: string;
  depth: string;
  localBucket: "morning" | "afternoon" | "evening" | null;
  checkIn: { mood: number | null; energy: number | null } | null;
  /**
   * Tier 3 self-reported wellbeing bands (WEL-01 sleep, WEL-03 stress).
   * Present only when the person has consented to those sources; used for
   * framing and reflection prompts, never for the calculation.
   */
  wellness: { sleep: number | null; stress: number | null } | null;
}

export interface ProvenanceEntry {
  lane: "calculation" | "cycle" | "content" | "context" | "reflection";
  source_id: string;
  label: string;
  detail: Record<string, string | number | boolean | null>;
}

export interface AssembledReading {
  headline: string;
  body: string;
  prompt: string;
  confidence: "low" | "medium" | "high";
  primary_cycle_key: string | null;
  provenance: ProvenanceEntry[];
  release_version: string;
  flagged: string[];
  /** The same eligible contacts feed the template and the language layer. */
  eligibleCycles: CycleInstance[];
  interpretationPlan: DailyInterpretationPlan;
  writingPlan: DailyWritingPlan;
  writingTemplate: DailyWritingTemplate | null;
  reflectionPlan: DailyReflectionPlan | null;
  natalLensPlan: DailyNatalLensPlan;
  transitStoryPlan: DailyTransitStoryPlan;
  storyCalculation: DailyTransitCalculation | null;
  astroBody: string;
  /** Deterministic caveats and consented context are never sent to the gateway. */
  contextBody: string;
  contextParts: { sourceIds: string[]; text: string }[];
  astroPrompt: string;
  editorial: {
    interpretation: { key: string; mechanism: string };
    domain: { key: string; label: string; text: string } | null;
    phase: { key: string; text: string };
    timing: string;
  } | null;
}

export function normalizeTone(value: string): "plain" | "warm" | "clinical" {
  return value === "warm" || value === "clinical" ? value : "plain";
}

export function normalizeDepth(value: string): "standard" | "technical" {
  return value === "technical" ? "technical" : "standard";
}

/** Defence at the reading boundary, including stale or externally supplied cycles. */
function eligibleReadingCycles(chart: Chart, cycles: CycleInstance[]): CycleInstance[] {
  return cycles
    .filter((cycle) => {
      if (!Number.isFinite(cycle.importance) || cycle.importance <= 0.02) return false;
      const angle =
        chart.points?.[cycle.natal_point]?.angleDependent ||
        /^(ascendant|descendant|midheaven|imum_coeli|asc|mc|ic)$/i.test(cycle.natal_point);
      if (angle && chart.uncertainty.angleClaimsSuppressed) return false;
      if (!chart.uncertainty.housesReliable && /^house[_ -]?\d+$/i.test(cycle.natal_point))
        return false;
      return true;
    })
    .sort((a, b) => {
      if (b.importance !== a.importance) {
        return b.importance - a.importance;
      }
      return a.cycle_key.localeCompare(b.cycle_key);
    })
    .slice(0, 3);
}

function record(
  out: ProvenanceEntry[],
  ctx: ReadingContext,
  lane: ProvenanceEntry["lane"],
  sourceId: string,
  use: AllowedUse,
  label: string,
  detail: Record<string, string | number | boolean | null> = {},
): boolean {
  if (!isPermitted(sourceId, use, ctx.granted)) return false;
  assertUse(sourceId, use);
  out.push({ lane, source_id: sourceId, label, detail });
  return true;
}

const TONE_OPENER: Record<string, string> = {
  plain: "",
  warm: "Taking this gently: ",
  clinical: "Observation: ",
};

// This composition consumes the complete published sources. Copy edits must
// invalidate it rather than silently replacing a new condition with old prose.
const WARM_MOON_TEMPLATE = {
  interpretation:
    "A small obligation can take up more room than its size suggests. Saturn's hard contact with the Moon frames the tension between something you feel responsible for and the amount of uninterrupted space you would prefer. The everyday scene might be a calendar left too full, or a quiet moment spent mentally keeping track of the next task.",
  domain:
    "An unclaimed hour can still be mentally full of unfinished tasks. A full calendar or an obligation that follows you into a quiet moment can offer a scene for tension around the amount of private space you prefer.",
  scene:
    "A small obligation can take up more room than its size suggests. You might picture a calendar left too full, or an unclaimed hour still mentally full of unfinished tasks—a quiet moment spent keeping track of the next thing.",
  meaning:
    "Saturn's hard contact with the Moon frames the tension between what you feel responsible for and how much uninterrupted space you would prefer.",
} as const;

export function assembleReading(
  chart: Chart,
  cycles: CycleInstance[],
  ctx: ReadingContext,
  bundle: ContentBundle = DEFAULT_BUNDLE,
  reliability: NatalReliabilityManifest | null = null,
  storyCalculation: DailyTransitCalculation | null = null,
): AssembledReading {
  const provenance: ProvenanceEntry[] = [];
  const primaryComposition = bundle.schemaVersion === 4 || bundle.schemaVersion === 6;

  record(provenance, ctx, "calculation", "AST-05", "calculation", "Planetary ephemeris", {
    engine: chart.engine,
    version: chart.engineVersion,
  });
  record(provenance, ctx, "calculation", "AST-07", "calculation", "Angles and houses", {
    system: chart.houseSystem,
  });
  record(provenance, ctx, "calculation", "AST-20", "framing", "Birth-time uncertainty", {
    accuracy: chart.uncertainty.accuracy,
    ascendantSpreadDeg: chart.uncertainty.ascendantSpreadDeg,
  });

  let ranked = eligibleReadingCycles(chart, cycles);
  const interpretationPlan = resolveInterpretationPlan(bundle, ranked);
  let primary = ranked[0] ?? null;
  const natalLensPlan = resolveDailyNatalLens(
    bundle,
    primary,
    interpretationPlan.interpretations.find((i) => i.index === 1) ?? null,
    reliability,
  );
  const transitStoryPlan = resolveDailyTransitStory(
    bundle,
    primary,
    interpretationPlan.interpretations.find((i) => i.index === 1) ?? null,
    storyCalculation,
  );
  // The limited editorial writer covers contact parents only. Keep the ordinary
  // writer when selected natal or transit context also requires N1 or A1/P2.
  const writingPlan = resolveDailyWritingPlan(
    bundle,
    interpretationPlan,
    natalLensPlan.status === "selected" || transitStoryPlan.status === "selected" ? undefined : ctx,
  );
  const selectedCalculation =
    transitStoryPlan.status === "selected"
      ? storyCalculation
      : transitStoryPlan.status === "omitted"
        ? { status: "omitted" as const, reason: transitStoryPlan.reason }
        : null;
  const overlay = primary ? primaryStoryOverlay(selectedCalculation, primary.cycle_key) : null;
  ranked = applyPrimaryStoryCalculation(ranked, selectedCalculation);
  primary = ranked[0] ?? null;
  const supporting = ranked.slice(1, 3);

  const paragraphs: string[] = [];
  const contextParagraphs: string[] = [];
  const contextParts: { sourceIds: string[]; text: string }[] = [];
  const addContext = (sourceIds: string[], text: string) => {
    contextParagraphs.push(text);
    contextParts.push({ sourceIds, text: safetyPass(text).text });
  };
  const tone = isPermitted("USR-01", "framing", ctx.granted) ? normalizeTone(ctx.tone) : "plain";
  const technical =
    isPermitted("USR-02", "framing", ctx.granted) && normalizeDepth(ctx.depth) === "technical";
  let editorial: AssembledReading["editorial"] = null;
  let headline = "A quiet day in the pattern";
  let prompt = primaryComposition
    ? primaryReflection(null, "").question
    : "Nothing is close enough to name today. What would you notice if nothing were pointing at it?";
  let confidence: AssembledReading["confidence"] = "low";

  if (primary) {
    const interp = findInterpretation(
      bundle,
      primary.aspect,
      primary.transit_body,
      primary.natal_point,
    );
    const dom = bundle.domains?.[primary.domain];
    const domainText = dom ? (aspectFamily(primary.aspect) === "soft" ? dom.soft : dom.hard) : null;
    const warmMoon =
      tone === "warm" &&
      !natalLensPlan.lens &&
      !interpretationPlan.synthesis &&
      transitStoryPlan.status !== "selected" &&
      interp.mechanism === WARM_MOON_TEMPLATE.interpretation &&
      domainText === WARM_MOON_TEMPLATE.domain;
    headline = primary.label;
    const reflection = primaryComposition
      ? primaryReflection(interp.question, primary.domain)
      : null;
    prompt = reflection?.question ?? interp.question;
    if (reflection)
      record(provenance, ctx, "reflection", "AST-05", "provenance", "Primary reflection question", {
        compositionVersion: PRIMARY_COMPOSITION_VERSION,
        reflectionVersion: PRIMARY_REFLECTION_VERSION,
        source: reflection.source,
        interpretationKey: interp.key,
        domain: primary.domain,
      });
    paragraphs.push(
      warmMoon
        ? WARM_MOON_TEMPLATE.scene
        : `${primaryComposition ? "" : TONE_OPENER[tone]}${interp.mechanism}${natalLensPlan.lens ? ` ${natalLensPlan.lens.mechanism}` : ""}${transitStoryPlan.status === "selected" ? ` ${transitStoryPlan.chronologySentence} ${transitStoryPlan.copy.mechanism}` : ""}`,
    );

    if (interpretationPlan.synthesis) {
      paragraphs.push(interpretationPlan.synthesis.mechanism);
      record(
        provenance,
        ctx,
        "content",
        "AST-05",
        "provenance",
        `Synthesis ${interpretationPlan.synthesis.ruleKey}`,
        {
          rule: interpretationPlan.synthesis.ruleKey,
          relationship: interpretationPlan.synthesis.relationship,
          bundle: bundle.version,
        },
      );
      const c2Interp = interpretationPlan.interpretations.find((item) => item.index === 2);
      if (c2Interp) {
        record(
          provenance,
          ctx,
          "content",
          "AST-05",
          "provenance",
          `Interpretation ${c2Interp.interpretationKey}`,
          {
            bundle: bundle.version,
          },
        );
      }
    }

    // Domain-specific framing: the same aspect reads differently depending on
    // which part of the chart it lands on, so the prose changes with domain.
    if (dom && domainText) {
      paragraphs.push(warmMoon ? WARM_MOON_TEMPLATE.meaning : domainText);
      if (!primaryComposition) prompt = `${prompt} ${dom.prompt}`;
      record(
        provenance,
        ctx,
        "content",
        "AST-05",
        "provenance",
        `Domain framing ${primary.domain}`,
        {
          domain: primary.domain,
          label: dom.label,
          family: aspectFamily(primary.aspect),
        },
      );
    }

    const presentationPhase = overlay?.phase ?? primary.phase;
    const phaseText =
      overlay && (overlay.phase === "between" || overlay.phase === "uncertain")
        ? storyTimingLine(overlay)
        : (bundle.phases[presentationPhase] ?? "");
    // Where in the arc we are, in days rather than jargon.
    const timing = overlay
      ? storyTimingLine(overlay)
      : arcParagraph(primary, technical, primaryComposition);
    // Between contacts the phase and timing share one factual sentence.
    // Keep both editorial references, but render that sentence only once.
    if (phaseText !== timing && (!primaryComposition || includePrimaryPhase(phaseText)))
      paragraphs.push(phaseText);
    paragraphs.push(timing);
    editorial = {
      interpretation: { key: interp.key, mechanism: interp.mechanism },
      domain:
        dom && domainText ? { key: primary.domain, label: dom.label, text: domainText } : null,
      phase: { key: presentationPhase, text: phaseText },
      timing,
    };

    record(provenance, ctx, "cycle", "AST-08", "timing", primary.label, {
      orb: primary.orb,
      phase: primary.phase,
      ingress_at: primary.ingress_at,
      exact_at: primary.exact_at,
      days_to_exact: primary.days_to_exact ?? null,
      arc_position: primary.arc_position ?? null,
      domain: primary.domain,
      egress_at: primary.egress_at,
      importance: primary.importance,
    });
    record(provenance, ctx, "content", "AST-05", "provenance", `Interpretation ${interp.key}`, {
      bundle: bundle.version,
    });

    confidence = primary.importance > 0.35 ? "high" : primary.importance > 0.12 ? "medium" : "low";
  } else {
    paragraphs.push(
      "No cycle is strong enough to name in this reading today. This is a quiet day in the pattern, with no chart signal singled out.",
    );
  }

  if (supporting.length) {
    paragraphs.push(
      `Also in range: ${supporting
        .map((s) =>
          technical
            ? `${s.label} (orb ${s.orb}\u00b0, ${s.phase}, ${exactPhrase(s.days_to_exact ?? null)}, ${bundle.domains?.[s.domain]?.label ?? s.domain})`
            : `${s.label} (${exactPhrase(s.days_to_exact ?? null)})`,
        )
        .join("; ")}.`,
    );
    for (const s of supporting) {
      record(provenance, ctx, "cycle", "AST-08", "timing", s.label, {
        orb: s.orb,
        phase: s.phase,
      });
    }
  }

  if (chart.uncertainty.angleClaimsSuppressed) {
    addContext(
      ["AST-20"],
      "Your birth time is recorded as uncertain, so anything that depends on the Ascendant or house placements has been left out of this reading rather than guessed at.",
    );
  } else if (!chart.uncertainty.housesReliable) {
    addContext(
      ["AST-20"],
      `Your birth time carries about \u00b1${chart.uncertainty.minutes} minutes of uncertainty, which is roughly ${chart.uncertainty.ascendantSpreadDeg}\u00b0 of Ascendant spread. Angle-based claims below are weighted down accordingly.`,
    );
  }

  if (ctx.localBucket && isPermitted("AMB-02", "framing", ctx.granted)) {
    addContext(
      ["AMB-02"],
      `Your local time of day is ${ctx.localBucket}. This is framing for when you read, and does not change the calculation.`,
    );
    record(provenance, ctx, "context", "AMB-02", "framing", "Local time of day", {
      bucket: ctx.localBucket,
    });
  }

  if (ctx.checkIn && isPermitted("USR-04", "framing", ctx.granted)) {
    const { mood, energy } = ctx.checkIn;
    addContext(
      ["USR-04"],
      `You logged mood ${mood ?? "\u2013"}/5 and energy ${energy ?? "\u2013"}/5 today. That is placed next to the reading, not folded into it \u2014 the calculation does not change based on how you feel.`,
    );
    record(provenance, ctx, "reflection", "USR-04", "framing", "Your daily check-in", {
      mood,
      energy,
    });
  }

  const astroPrompt = safetyPass(prompt).text;
  // Tier 3 — sensitive wellness. Framing and prompt only, per WEL-01/WEL-03
  // allowed_uses. Never diagnostic, never fed into the calculation or ranking.
  if (ctx.wellness) {
    const { sleep, stress } = ctx.wellness;
    const bands: string[] = [];
    const sleepOk = sleep !== null && isPermitted("WEL-01", "framing", ctx.granted);
    const stressOk = stress !== null && isPermitted("WEL-03", "framing", ctx.granted);

    if (sleepOk) {
      bands.push(`sleep ${sleep}/5`);
      record(provenance, ctx, "reflection", "WEL-01", "framing", "Sleep quality (self-reported)", {
        band: sleep,
      });
    }
    if (stressOk) {
      bands.push(`stress ${stress}/5`);
      record(provenance, ctx, "reflection", "WEL-03", "framing", "Stress load (self-reported)", {
        band: stress,
      });
    }

    if (bands.length) {
      addContext(
        [...(sleepOk ? ["WEL-01"] : []), ...(stressOk ? ["WEL-03"] : [])],
        `You reported ${bands.join(" and ")} today. This is context you chose to record for reflection; it leaves the chart calculation unchanged and is deleted after 180 days.`,
      );
    }

    // Reflection prompt is allowed to adapt to a band (WEL reflection_prompt).
    if (
      bundle.schemaVersion !== 5 &&
      !primaryComposition &&
      stressOk &&
      stress >= 4 &&
      isPermitted("WEL-03", "reflection_prompt", ctx.granted)
    ) {
      prompt = `${prompt} And with pressure running high today, which part of that is actually yours to carry right now?`;
      record(
        provenance,
        ctx,
        "reflection",
        "WEL-03",
        "reflection_prompt",
        "Prompt adapted to stress band",
        { band: stress },
      );
    } else if (
      bundle.schemaVersion !== 5 &&
      !primaryComposition &&
      sleepOk &&
      sleep <= 2 &&
      isPermitted("WEL-01", "reflection_prompt", ctx.granted)
    ) {
      prompt = `${prompt} On thin sleep, notice how much of what you read today is the sky and how much is tiredness.`;
      record(
        provenance,
        ctx,
        "reflection",
        "WEL-01",
        "reflection_prompt",
        "Prompt adapted to sleep band",
        { band: sleep },
      );
    }
  }

  if (isPermitted("USR-01", "framing", ctx.granted)) {
    record(provenance, ctx, "reflection", "USR-01", "framing", "Tone preference", {
      tone,
    });
  }

  const writingTemplate =
    bundle.schemaVersion === 5 || writingPlan.editorial
      ? composeDailyWritingTemplate(writingPlan, natalLensPlan, transitStoryPlan)
      : null;
  const reflectionPlan =
    bundle.schemaVersion === 5 || writingPlan.editorial
      ? resolveDailyReflection(
          writingPlan,
          primary
            ? findInterpretation(bundle, primary.aspect, primary.transit_body, primary.natal_point)
                .question
            : null,
          ctx,
        )
      : null;
  if (reflectionPlan) prompt = reflectionPlan.question;
  if (writingPlan.editorial) headline = writingPlan.editorial.entry.headline;
  if (reflectionPlan?.localSource)
    record(
      provenance,
      ctx,
      "reflection",
      reflectionPlan.localSource,
      "reflection_prompt",
      "Source-aligned reflection variant",
      {},
    );
  const astroParagraphs = writingTemplate
    ? writingTemplate.paragraphs.map((item) => item.text)
    : natalLensPlan.lens && primary && editorial
      ? composeNatalTemplate({
          interpretation: editorial.interpretation.mechanism,
          lens: natalLensPlan.lens.mechanism,
          synthesis: interpretationPlan.synthesis?.mechanism ?? null,
          secondary:
            interpretationPlan.interpretations.find((item) => item.index === 2)?.mechanism ?? null,
          primary,
          story: transitStoryPlan,
          technical,
        })
      : paragraphs;
  const astro = safetyPass(astroParagraphs.filter(Boolean).join("\n\n"));
  const context = safetyPass(contextParagraphs.filter(Boolean).join("\n\n"));
  const safePrompt = safetyPass(prompt);

  return {
    headline,
    body: [astro.text, context.text].filter(Boolean).join("\n\n"),
    prompt: safePrompt.text,
    confidence,
    primary_cycle_key: primary?.cycle_key ?? null,
    provenance,
    release_version: bundle.version,
    flagged: [...astro.flagged, ...context.flagged, ...safePrompt.flagged],
    eligibleCycles: ranked,
    interpretationPlan,
    writingPlan,
    writingTemplate,
    reflectionPlan,
    natalLensPlan,
    transitStoryPlan,
    storyCalculation: selectedCalculation,
    astroBody: astro.text,
    contextBody: context.text,
    contextParts,
    astroPrompt: reflectionPlan
      ? resolveDailyReflection(
          writingPlan,
          primary
            ? findInterpretation(bundle, primary.aspect, primary.transit_body, primary.natal_point)
                .question
            : null,
          { ...ctx, granted: new Set(), wellness: null },
        ).question
      : astroPrompt,
    editorial,
  };
}

