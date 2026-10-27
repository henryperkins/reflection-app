import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { digest, protectedPath } from './provider-evaluation-state.ts';
import { projectRoot } from './schemas.ts';

const Position = z.enum(['situation', 'tension', 'possibility']);
const ReviewItem = z.object({
  caseId: z.string().min(1).max(120),
  prompt: z.string().max(500),
  sources: z.array(z.object({ position: Position, text: z.string().max(12000) })).length(3),
  candidate: z
    .object({
      units: z
        .array(
          z.object({
            position: Position,
            interpretation: z.string().max(12000),
            reflectionQuestion: z.string().max(2000),
          }),
        )
        .length(3),
      closing: z.string().max(2000).optional(),
    })
    .nullable(),
});
type ReviewItem = z.infer<typeof ReviewItem>;
export type EditorialSignal =
  | 'IDENTICAL_SOURCE_TEXT'
  | 'FIXTURE_LANGUAGE'
  | 'REPEATED_OPENING'
  | 'REPEATED_CLAUSE'
  | 'REPEATED_QUESTION'
  | 'QUESTION_RESTATES_PROMPT';

/** Review hints only. These cannot judge entailment, usefulness, or semantic progression. */
export function editorialSignals(item: ReviewItem): EditorialSignal[] {
  const normalize = (text: string) =>
    text
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const duplicated = (values: string[]) => new Set(values).size < values.length;
  const flags: EditorialSignal[] = [];
  if (duplicated(item.sources.map((source) => normalize(source.text))))
    flags.push('IDENTICAL_SOURCE_TEXT');
  if (!item.candidate) return flags;
  const units = item.candidate.units;
  const body = [
    ...units.flatMap((unit) => [unit.interpretation, unit.reflectionQuestion]),
    item.candidate.closing ?? '',
  ].join(' ');
  if (/\b(?:synthetic|simulated|simulation)\b/i.test(body)) flags.push('FIXTURE_LANGUAGE');
  const openings = units
    .map((unit) => normalize(unit.interpretation).split(' ').slice(0, 6))
    .filter((words) => words.length === 6)
    .map((words) => words.join(' '));
  if (duplicated(openings)) flags.push('REPEATED_OPENING');
  const clauses = new Map<string, Set<number>>();
  for (const [index, unit] of units.entries()) {
    for (const part of unit.interpretation.split(/[.!?;\n—]+/u)) {
      const clause = normalize(part);
      if (clause.length < 20 || clause.split(' ').length < 3) continue;
      const seen = clauses.get(clause) ?? new Set<number>();
      seen.add(index);
      clauses.set(clause, seen);
    }
  }
  if ([...clauses.values()].some((seen) => seen.size > 1)) flags.push('REPEATED_CLAUSE');
  const questions = units.map((unit) => normalize(unit.reflectionQuestion));
  if (duplicated(questions)) flags.push('REPEATED_QUESTION');
  if (questions.includes(normalize(item.prompt))) flags.push('QUESTION_RESTATES_PROMPT');
  return flags;
}

export async function runEditorialReview(argv: string[]) {
  if (argv.length !== 4 || argv[0] !== '--packet' || argv[2] !== '--out')
    throw new Error('Use --packet /private/packet.json --out /private/new-report.json');
  const input = protectedPath(resolve(argv[1]!)),
    output = protectedPath(resolve(argv[3]!));
  const within = relative(projectRoot, input);
  if ((!within.startsWith(`..${sep}`) && within !== '..') || dirname(input) !== dirname(output))
    throw new Error('Review report must stay beside its external packet');
  const stat = lstatSync(input);
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024 || (stat.mode & 0o077) !== 0)
    throw new Error('Protected bounded packet required');
  const bytes = readFileSync(input);
  const packet = z
    .object({
      version: z.literal('reflection-human-review-packet.v1'),
      runId: z.uuid(),
      manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
      items: z.array(ReviewItem).min(1).max(720),
    })
    .parse(JSON.parse(bytes.toString('utf8')));
  if (new Set(packet.items.map((item) => item.caseId)).size !== packet.items.length)
    throw new Error('Duplicate review cases');
  const report = {
    version: 'reading-editorial-screen.v1',
    runId: packet.runId,
    manifestHash: packet.manifestHash,
    packetHash: digest(bytes),
    humanReviewRequired: true,
    qualificationEligible: false,
    requiredHumanChecks: [
      'source-fidelity',
      'source-versus-context-attribution',
      'section-progression',
      'question-distinctness',
      'advances-beyond-prompt',
      'context-adaptation',
      'card-and-orientation-support',
      'autonomy',
    ],
    cases: packet.items.map((item) => ({
      caseId: item.caseId,
      flags: editorialSignals(item),
      semanticAssessment: 'requires-human-review',
    })),
  };
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return {
    cases: report.cases.length,
    calls: 0,
    humanReviewRequired: true,
    qualificationEligible: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runEditorialReview(process.argv.slice(2))));
  } catch {
    console.error(
      'Editorial report not written: check protected external paths, packet and output name.',
    );
    process.exitCode = 1;
  }
}
