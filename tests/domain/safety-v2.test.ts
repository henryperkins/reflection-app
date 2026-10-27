import { expect, test } from 'vitest';
import { buildPlanV2 } from '../../src/domain/tarot/context-v2.ts';
import { prepareWriterV2, writerIdentitiesV2 } from '../../src/domain/tarot/writer-v2.ts';
import { validateCandidateV2 } from '../../src/domain/tarot/safety-v2.ts';
import { v2Input, relationship, rehashBundle } from '../fixtures/canon-v2.ts';
import { TarotFactId, type ModelCandidateV2 } from '../../src/contracts/index.ts';
import { READING_V2_EVALUATION_POLICY as policy } from '../../src/contracts/provider-policy.ts';

async function fixture(
  question = 'I am not discouraged. My workload is manageable. What could I explore?',
) {
  const input = await v2Input();
  input.question = question;
  Object.assign(input, await writerIdentitiesV2());
  const plan = await buildPlanV2(input),
    { receipt } = await prepareWriterV2(plan);
  const refs = {
    sourceIds: plan.sources.map((s) => s.id),
    contextRefs: ['reader:question'] as const,
  };
  const candidate: ModelCandidateV2 = {
    schemaVersion: 2,
    kind: 'tarot.interpretation.v2',
    units: plan.basis.cards.map((c, i) => ({
      position: c.position,
      factIds: [TarotFactId.parse(c.id)],
      sourceIds: [plan.sources[i]!.id],
      contextRefs: ['reader:question'],
      interpretation: [
        'You are not discouraged.',
        'Compare what each option asks of the work.',
        'A provisional preference can remain open to revision.',
      ][i]!,
    })),
    synthesis: {
      ...refs,
      contextRefs: [...refs.contextRefs],
      relationshipIds: [],
      text: 'Use what already supports the goal as a baseline for comparing the alternatives.',
    },
    action: {
      ...refs,
      contextRefs: [...refs.contextRefs],
      text: 'You could make a table of benefits and commitments, then identify the evidence that would change your preference.',
    },
    reflectionQuestion: null,
  };
  return { plan, receipt, candidate: JSON.parse(JSON.stringify(candidate)) as ModelCandidateV2 };
}
test.each([
  ['I am not discouraged.', 'You are not discouraged.'],
  ["I'm comfortable with my workload.", "You're comfortable with your workload."],
  [
    'I was uncertain about the format last month.',
    'You were uncertain about the format last month.',
  ],
  ['My friend is supportive.', 'Your friend is supportive.'],
  ['Compare formats. I am not discouraged.', 'You are not discouraged.'],
  ['I am not discouraged.', 'You said, “I am not discouraged.”'],
])('supported natural statement keeps current scope: %s', async (question, text) => {
  const { plan, receipt, candidate } = await fixture(question);
  candidate.units[0]!.interpretation = text;
  await expect(validateCandidateV2(plan, candidate, receipt)).resolves.toEqual(candidate);
});
test.each([
  ['I am not discouraged.', 'You are discouraged.'],
  ['If I were discouraged, I would rest.', 'You were discouraged.'],
  ['A friend said, "I am discouraged."', 'You are discouraged.'],
  ['I am not sure whether I am ready.', 'You are ready.'],
  ['I was discouraged last year.', 'You are discouraged.'],
  ['I am discouraged about writing, not work.', 'You are discouraged about work.'],
  ['I am not discouraged.', 'Your friend is supportive.'],
])('unsupported assertion does not borrow scope from %s', async (question, text) => {
  const { plan, receipt, candidate } = await fixture(question);
  candidate.units[0]!.interpretation = text;
  await expect(validateCandidateV2(plan, candidate, receipt)).rejects.toThrow(
    'BIOGRAPHY_UNSUPPORTED',
  );
});
test('conditional hypothesis remains conditional in its own clause, not the following assertion', async () => {
  const { plan, receipt, candidate } = await fixture();
  candidate.units[0]!.interpretation =
    'If you are considering an adjustment, compare it with the current approach.';
  await expect(validateCandidateV2(plan, candidate, receipt)).resolves.toEqual(candidate);
  candidate.units[0]!.interpretation += ' You are overwhelmed.';
  await expect(validateCandidateV2(plan, candidate, receipt)).rejects.toThrow(
    'BIOGRAPHY_UNSUPPORTED',
  );
});
test.each(['interpretation', 'synthesis', 'action', 'question'])(
  'all new prose fields screen predictions and unsupported facts: %s',
  async (field) => {
    const { plan, receipt, candidate } = await fixture();
    const text = 'You will receive the result tomorrow.';
    if (field === 'interpretation') candidate.units[1]!.interpretation = text;
    if (field === 'synthesis') candidate.synthesis.text = text;
    if (field === 'action') candidate.action.text = text;
    if (field === 'question')
      candidate.reflectionQuestion = {
        sourceIds: [plan.sources[0]!.id],
        contextRefs: ['reader:question'],
        text,
      };
    await expect(validateCandidateV2(plan, candidate, receipt)).rejects.toThrow('PREDICTION');
  },
);
test.each([
  'source',
  'context',
  'relationship',
  'unit',
  'synthesis-length',
  'action-length',
  'question-length',
])('v2 bindings and prose ceilings reject %s', async (kind) => {
  const { plan, receipt, candidate } = await fixture();
  if (kind === 'source') candidate.action.sourceIds = ['absent'];
  if (kind === 'context') candidate.synthesis.contextRefs = ['history:old'] as never;
  if (kind === 'relationship') candidate.synthesis.relationshipIds = ['absent'];
  if (kind === 'unit') candidate.units[0]!.sourceIds = [plan.sources[1]!.id];
  if (kind === 'synthesis-length') candidate.synthesis.text = 'x'.repeat(651);
  if (kind === 'action-length') candidate.action.text = 'x'.repeat(501);
  if (kind === 'question-length')
    candidate.reflectionQuestion = {
      sourceIds: [plan.sources[0]!.id],
      contextRefs: ['reader:question'],
      text: 'x'.repeat(201),
    };
  await expect(validateCandidateV2(plan, candidate, receipt)).rejects.toThrow('INVALID_CANDIDATE');
});
test('synthesis cannot cite a relationship omitted from the transmitted packet', async () => {
  const f = await fixture(),
    input = await v2Input();
  Object.assign(input, await writerIdentitiesV2());
  input.content.relationships = [await relationship(input, 'note:eligible')];
  await rehashBundle(input.content);
  const plan = await buildPlanV2(input),
    complete = await prepareWriterV2(plan);
  f.candidate.synthesis.relationshipIds = ['note:eligible'];
  await expect(validateCandidateV2(plan, f.candidate, complete.receipt)).resolves.toEqual(
    f.candidate,
  );
  const limited = {
    ...policy,
    estimator: {
      ...policy.estimator,
      maxPayloadBytes: complete.payload.length - 1,
      maxInputTokens: complete.payload.length + 255,
    },
  } as typeof policy;
  const omitted = await prepareWriterV2(plan, limited);
  expect(omitted.receipt.relationships).toEqual([]);
  await expect(validateCandidateV2(plan, f.candidate, omitted.receipt)).rejects.toThrow(
    'RELATIONSHIP_UNSUPPORTED',
  );
});
