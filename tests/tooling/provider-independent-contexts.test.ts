import { expect, test } from 'vitest';
import { prepareEvaluation } from '../../scripts/provider-evaluate.ts';
import { validatePermit } from '../../scripts/provider-evaluation-state.ts';
import { validateCandidate } from '../../src/domain/tarot/safety.ts';

async function bundle() {
  const parent = await prepareEvaluation('human-review-fast-xhigh');
  return {
    version: 'reflection-source-diagnostic-bundle.v1',
    parentManifestHash: parent.manifestHash,
    supersedesProposalHash: 'a'.repeat(64),
    review: {
      kind: 'ai-editorial-recommendation',
      humanApproval: false,
      productionApproval: false,
    },
    sources: parent.requests
      .filter((r) => ['A07-2', 'A08-1'].includes(r.caseId))
      .flatMap((r) =>
        r.plan.basis.cards.map((c, i) => ({
          caseId: r.caseId,
          position: c.position,
          factId: c.id,
          cardId: c.cardId,
          orientation: c.orientation,
          sourceId: r.plan.sources[i]!.id,
          text: `SYNTHETIC LOCAL SIMULATION — never production editorial approval. A distinct optional idea for ${c.position}.`,
        })),
      ),
  };
}
test('fresh-context probe uses four new questions once with unchanged source/draw/schema bindings', async () => {
  const sources = await bundle();
  const original = await prepareEvaluation('source-diagnostic-fast-xhigh', sources);
  const prepared = await prepareEvaluation('independent-context-fast-xhigh', sources);
  expect(prepared.requests).toHaveLength(4);
  expect(prepared.manifest.maximumScheduledMicrousd).toBe(480000);
  expect(prepared.manifest.humanApprovedExamples).toBe(0);
  expect(prepared.manifest.promptComparison).toBeUndefined();
  expect(new Set(prepared.requests.map((r) => r.caseId)).size).toBe(4);
  for (const r of prepared.requests) {
    const parent = original.requests.find(
      (p) =>
        p.plan.basis.cards[0]!.cardId === r.plan.basis.cards[0]!.cardId &&
        p.id.includes('distinct-source'),
    )!;
    const actual = JSON.parse(new TextDecoder().decode(r.input.payload));
    const reference = JSON.parse(new TextDecoder().decode(parent.input.payload));
    const data = JSON.parse(actual.input[2].content),
      oldData = JSON.parse(reference.input[2].content);
    expect(data.question).not.toBe(oldData.question);
    expect(r.plan.question).toBe(data.question);
    expect(data.sources).toEqual(oldData.sources);
    expect(actual.text).toEqual(reference.text);
    actual.input[1].content = reference.input[1].content;
    data.question = oldData.question;
    actual.input[2].content = JSON.stringify(data);
    expect(actual).toEqual(reference);
    expect(prepared.manifest.schedule.find((s) => s.id === r.id)!.repeat).toBe(1);
  }
});
test('mechanical validation uses the new supplied facts instead of the old sparse question', async () => {
  const prepared = await prepareEvaluation('independent-context-fast-xhigh', await bundle());
  const request = prepared.requests.find((r) => r.caseId === 'I01')!;
  expect(request.plan.question).toContain('The workload is manageable.');
  const candidate = {
    schemaVersion: 1,
    kind: 'tarot.interpretation.v1',
    units: request.plan.basis.cards.map((card, i) => ({
      position: card.position,
      factIds: [card.id],
      sourceIds: [request.plan.sources[i]!.id],
      interpretation:
        i === 0
          ? 'You said, “The workload is manageable.”'
          : i === 1
            ? 'Compare the demands of each option.'
            : 'Use consistent criteria for the comparison.',
      reflectionQuestion: [
        'What would you keep?',
        'Which resources matter?',
        'What could inform the choice?',
      ][i],
    })),
    closing: 'Choose the comparison method that fits the project.',
  };
  if (request.plan.version !== 'tarot-plan.v1') throw new Error('Expected frozen v1 profile');
  const legacyPlan = request.plan;
  expect(() => validateCandidate(legacyPlan, candidate)).not.toThrow();
});

test('independent probe permit rejects extra spending and unrelated policy or purpose', async () => {
  const prepared = await prepareEvaluation('independent-context-fast-xhigh', await bundle());
  const now = Date.now();
  const permit = {
    version: 'reflection-evaluation-permit.v1',
    scope: 'evaluation',
    purpose: 'independent-context-fast-xhigh',
    runId: '10000000-0000-4000-8000-000000000001',
    authorizedBy: 'Synthetic test authorizer',
    authorizedAt: new Date(now - 1000).toISOString(),
    expiresAt: new Date(now + 60000).toISOString(),
    projectId: 'proj_synthetic',
    credentialHash: 'a'.repeat(64),
    encryptionKeyHash: 'b'.repeat(64),
    model: prepared.policy.model,
    policyHash: prepared.manifest.policyHash,
    contentHash: prepared.manifest.contentHash,
    corpusHash: prepared.manifest.corpusHash,
    manifestHash: prepared.manifestHash,
    maxCalls: 4,
    maxConcurrency: 2,
    maxCostMicrousd: 480000,
    outputDirectory: '/synthetic/external-output',
    sourceBundlePath: '/synthetic/sources.json',
  };
  expect(validatePermit(permit, prepared, now)).toEqual(permit);
  for (const patch of [
    { maxCalls: 5 },
    { maxCostMicrousd: 480001 },
    { purpose: 'source-diagnostic-fast-xhigh' },
    { purpose: 'prompt-comparison-fast-xhigh' },
    { policyHash: 'c'.repeat(64) },
    { sourceBundlePath: undefined },
  ])
    expect(() => validatePermit({ ...permit, ...patch }, prepared, now)).toThrow();
});
