import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { editorialSignals, runEditorialReview } from '../../scripts/provider-editorial-review.ts';

const positions = ['situation', 'tension', 'possibility'] as const;
const interpretations = [
  'A boundary may help distinguish a current priority from an optional task.',
  'Consider whether the effort involved fits the resources you want to offer.',
  'A small experiment could reveal which adjustment is worth keeping.',
];
const questions = [
  'What matters here?',
  'Which trade-off deserves attention?',
  'What could you learn?',
];
function item(texts = interpretations) {
  return {
    caseId: 'synthetic-editorial-test',
    prompt: 'How might I compare these alternatives?',
    sources: positions.map((position, i) => ({ position, text: `Distinct test source ${i}.` })),
    candidate: {
      units: positions.map((position, i) => ({
        position,
        interpretation: texts[i]!,
        reflectionQuestion: questions[i]!,
      })),
      closing: 'Choose what fits your priorities.',
    },
  };
}

test.each([';', '.', '—'])(
  'repeated opening is flagged even when different endings follow %s',
  (separator) => {
    const value = item(
      interpretations.map((text) => `A shared image offers a starting point${separator} ${text}`),
    );
    expect(editorialSignals(value)).toContain('REPEATED_OPENING');
  },
);
test('repeated clauses inside different sentences are flagged', () => {
  const value = item(
    interpretations.map((text) => `${text} Consider the boundary; it may deserve attention.`),
  );
  expect(editorialSignals(value)).toContain('REPEATED_CLAUSE');
});
test('shared topic vocabulary and distinct questions do not imply repetition', () => {
  const value = item([
    'A pause could help you name a priority before deciding.',
    'After that pause, consider a competing demand on your attention.',
    'You might pause again after an experiment to decide what to keep.',
  ]);
  expect(editorialSignals(value).filter((flag) => flag.startsWith('REPEATED_'))).toEqual([]);
});
test('missing source differentiation and fixture language remain visible in review', () => {
  const value = item([
    'A synthetic simulation offers a starting point.',
    ...interpretations.slice(1),
  ]);
  value.sources.forEach((source) => {
    source.text = 'The same source passage.';
  });
  expect(editorialSignals(value)).toEqual(
    expect.arrayContaining(['IDENTICAL_SOURCE_TEXT', 'FIXTURE_LANGUAGE']),
  );
});
test('duplicate questions and exact restatement are flagged without inventing semantic scores', () => {
  const value = item();
  value.candidate.units[0]!.reflectionQuestion = value.prompt;
  value.candidate.units[1]!.reflectionQuestion = value.prompt;
  expect(editorialSignals(value)).toEqual(
    expect.arrayContaining(['REPEATED_QUESTION', 'QUESTION_RESTATES_PROMPT']),
  );
});

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
test('offline report binds the original packet, never grants acceptance, and preserves prior evidence', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'editorial-review-'));
  directories.push(directory);
  const packetPath = join(directory, 'packet.json'),
    outPath = join(directory, 'editorial.json');
  const packet = JSON.stringify({
    version: 'reflection-human-review-packet.v1',
    runId: '00000000-0000-4000-8000-000000000001',
    manifestHash: 'a'.repeat(64),
    items: [item()],
  });
  writeFileSync(packetPath, packet, { mode: 0o600 });
  const result = await runEditorialReview(['--packet', packetPath, '--out', outPath]);
  expect(result).toMatchObject({ cases: 1, calls: 0, humanReviewRequired: true });
  const report = JSON.parse(readFileSync(outPath, 'utf8'));
  expect(report).toMatchObject({
    version: 'reading-editorial-screen.v1',
    packetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    qualificationEligible: false,
    humanReviewRequired: true,
    cases: [
      {
        caseId: 'synthetic-editorial-test',
        flags: [],
        semanticAssessment: 'requires-human-review',
      },
    ],
  });
  expect(report.requiredHumanChecks).toContain('source-fidelity');
  expect(report.requiredHumanChecks).toContain('section-progression');
  expect(report).not.toHaveProperty('qualityScore');
  expect(readFileSync(packetPath, 'utf8')).toBe(packet);
  await expect(runEditorialReview(['--packet', packetPath, '--out', outPath])).rejects.toThrow();
});
