import { afterEach, expect, test, vi } from 'vitest';
import { prepareEvaluation, runEvaluationCli } from '../../scripts/provider-evaluate.ts';
import { composeTemplateV2 } from '../../src/domain/tarot/writer-v2.ts';
import { validateCandidateV2 } from '../../src/domain/tarot/safety-v2.ts';

afterEach(() => vi.restoreAllMocks());

test('the editorial candidate changes only writing instructions and the preferred length floor', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
  const baseline = await prepareEvaluation('reading-v2-development-fast-xhigh');
  expect(baseline.manifestHash).toBe(
    '5e34ff3260f18e2078aa54233bc6fc3015f77ac97165c0802c15fdfbbc2a3945',
  );
  const candidate = await prepareEvaluation('reading-v2-editorial-fast-xhigh');
  const dryRun = await runEvaluationCli(
    ['--dry-run', '--profile', 'reading-v2-editorial-fast-xhigh'],
    {},
  );
  expect(dryRun).toMatchObject({ calls: 0, manifestHash: candidate.manifestHash });
  expect(candidate.manifestHash).not.toBe(baseline.manifestHash);
  expect(candidate.manifest.policyHash).not.toBe(baseline.manifest.policyHash);
  expect(candidate.manifest.contentHash).toBe(baseline.manifest.contentHash);
  expect(candidate.manifest.corpusHash).toBe(baseline.manifest.corpusHash);
  expect(candidate.requests).toHaveLength(4);
  for (const request of candidate.requests) {
    const previous = baseline.requests.find((r) => r.caseId === request.caseId)!;
    const old = JSON.parse(new TextDecoder().decode(previous.input.payload));
    const current = JSON.parse(new TextDecoder().decode(request.input.payload));
    const oldData = JSON.parse(old.input[2].content);
    const data = JSON.parse(current.input[2].content);
    expect(current.input[1].content).not.toBe(old.input[1].content);
    expect(data.preferences.targetWords.minimum).toBeUndefined();
    expect(data.preferences.targetWords.maximum).toBe(320);
    delete oldData.preferences.targetWords.minimum;
    expect(data).toEqual(oldData);
    current.input[1].content = old.input[1].content;
    current.input[2].content = old.input[2].content;
    expect(current).toEqual(old);
    expect(request.plan.validatorHash).toBe(previous.plan.validatorHash);
    expect(request.contextReceipt?.schemaHash).toBe(previous.contextReceipt?.schemaHash);
    expect(request.plan.promptHash).not.toBe(previous.plan.promptHash);
    expect(request.estimatedInputTokens).toBeLessThanOrEqual(16384);
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('the candidate still requires a nonempty action and allows a structurally complete shorter reading', async () => {
  const prepared = await prepareEvaluation('reading-v2-editorial-fast-xhigh');
  const request = prepared.requests.find((r) => r.caseId === 'I02')!;
  if (request.plan.version !== 'tarot-plan.v2') throw new Error('Wrong plan');
  const candidate = await composeTemplateV2(request.plan);
  const body = [
    ...candidate.units.map((u) => u.interpretation),
    candidate.synthesis.text,
    candidate.action.text,
  ].join(' ');
  expect(body.trim().split(/\s+/u).length).toBeLessThan(220);
  await expect(
    validateCandidateV2(request.plan, candidate, request.contextReceipt!),
  ).resolves.toEqual(candidate);
  const { action: _action, ...withoutAction } = candidate;
  await expect(
    validateCandidateV2(request.plan, withoutAction, request.contextReceipt!),
  ).rejects.toThrow('SCHEMA');
  await expect(
    validateCandidateV2(
      request.plan,
      { ...candidate, action: { ...candidate.action, text: '' } },
      request.contextReceipt!,
    ),
  ).rejects.toThrow('SCHEMA');
});
