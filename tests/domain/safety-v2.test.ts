import { expect, test } from 'vitest';
import { buildPlanV2 } from '../../src/domain/tarot/context-v2.ts';
import { prepareWriterV2, writerIdentitiesV2 } from '../../src/domain/tarot/writer-v2.ts';
import { validateCandidateV2 } from '../../src/domain/tarot/safety-v2.ts';
import { v2Input, relationship, rehashBundle } from '../fixtures/canon-v2.ts';
import { TarotFactId, type ModelCandidateV2 } from '../../src/contracts/index.ts';
import { READING_V2_EVALUATION_POLICY as policy } from '../../src/contracts/provider-policy.ts';
import { LOCAL_LIVE_READING_POLICY } from '../../src/contracts/provider-policy.ts';

async function fixture(
  question = 'I am not discouraged. My workload is manageable. What could I explore?',
  selectedPolicy = policy as typeof policy | typeof LOCAL_LIVE_READING_POLICY,
) {
  const input = await v2Input();
  input.question = question;
  Object.assign(input, await writerIdentitiesV2(selectedPolicy));
  const plan = await buildPlanV2(input),
    { receipt } = await prepareWriterV2(plan, selectedPolicy);
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

test('live screening permits a comparison method without changing the archived validator', async () => {
  const text =
    'Separate what you’ve observed about the newsletter from what you’re assuming about print, so the comparison can change as you learn.';
  const current = await fixture(undefined, LOCAL_LIVE_READING_POLICY);
  current.candidate.action.text = text;
  await expect(
    validateCandidateV2(current.plan, current.candidate, current.receipt),
  ).resolves.toEqual(current.candidate);
  const previous = await fixture();
  previous.candidate.action.text = text;
  await expect(
    validateCandidateV2(previous.plan, previous.candidate, previous.receipt),
  ).rejects.toThrow('BIOGRAPHY_UNSUPPORTED');
});

test.each([
  'You are assuming the project cannot work.',
  'Separate what you have observed from what you are feeling.',
  'Separate what you have observed from what you are assuming, because you are overwhelmed.',
])('a comparison method does not authorize personal assertions: %s', async (text) => {
  const { plan, candidate, receipt } = await fixture(undefined, LOCAL_LIVE_READING_POLICY);
  candidate.action.text = text;
  await expect(validateCandidateV2(plan, candidate, receipt)).rejects.toThrow(
    'BIOGRAPHY_UNSUPPORTED',
  );
});
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
  [
    'My writing group is welcoming, my desk setup works, and I am not discouraged.',
    'Since you are not discouraged, a small experiment may be useful.',
  ],
  [
    'I feel discouraged after my sketches did not match what I imagined, but a drawing session with a friend helped.',
    'The image you had in mind can offer direction without promising that the sketch will match it.',
  ],
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
  [
    'If my writing group is welcoming and I am not discouraged, I could try again.',
    'Since you are not discouraged, try an experiment.',
  ],
  ['My friend says I am ready and I am confident.', 'You are confident.'],
  [
    'My group is welcoming, and I am not discouraged about writing, only about work.',
    'You are not discouraged.',
  ],
  [
    'If my sketches did not match what I imagined, I would ask for help.',
    'The image you had in mind can guide another attempt.',
  ],
  [
    'A friend said, "My sketches did not match what I imagined."',
    'The image you had in mind can guide another attempt.',
  ],
  [
    'I did not imagine an image before drawing.',
    'The image you had in mind can guide another attempt.',
  ],
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
test.each([
  ['"', '"'],
  ['“', '”'],
  ["'", "'"],
  ['‘', '’'],
])('quoted statements retain scope across sentence boundaries: %s … %s', async (open, close) => {
  const question = `I am comfortable with my workload. My friend said, ${open}I am happy. I am discouraged. I am ready.${close} What could I explore?`;
  const { plan, receipt, candidate } = await fixture(question);
  candidate.units[0]!.interpretation = 'You are discouraged.';
  await expect(validateCandidateV2(plan, candidate, receipt)).rejects.toThrow(
    'BIOGRAPHY_UNSUPPORTED',
  );
  candidate.units[0]!.interpretation = 'You are comfortable with your workload.';
  await expect(validateCandidateV2(plan, candidate, receipt)).resolves.toEqual(candidate);
});
test('an unfinished quotation does not turn its interior sentences into current reader facts', async () => {
  const { plan, receipt, candidate } = await fixture(
    'My friend wrote, "I am happy.\nI am discouraged. I am ready.',
  );
  candidate.units[0]!.interpretation = 'You are discouraged.';
  await expect(validateCandidateV2(plan, candidate, receipt)).rejects.toThrow(
    'BIOGRAPHY_UNSUPPORTED',
  );
});
test('the executable validator refuses a different validator identity even when receipt and plan agree', async () => {
  const { plan, receipt, candidate } = await fixture();
  plan.validatorHash = 'f'.repeat(64);
  receipt.validatorHash = plan.validatorHash;
  await expect(validateCandidateV2(plan, candidate, receipt)).rejects.toThrow('CONTENT_CHANGED');
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
