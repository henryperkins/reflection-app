import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { checkRelease } from '../../scripts/release.ts';
import { sourceDigest } from '../../scripts/verification-state.ts';
import { qualificationDigest, qualificationGates } from '../../scripts/qualification.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture(manifest?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'reflection-qualification-'));
  temporary.push(root);
  mkdirSync(join(root, 'artifacts'));
  mkdirSync(join(root, 'qualification'));
  writeFileSync(join(root, 'source.ts'), 'export const application = true;');
  if (manifest)
    writeFileSync(join(root, 'qualification/acceptance.json'), JSON.stringify(manifest));
  writeFileSync(
    join(root, 'artifacts/verify.json'),
    JSON.stringify({
      status: 'passed',
      sourceDigest: sourceDigest(root),
      scope: 'synthetic-local-only',
    }),
  );
  return root;
}

test('a green local gate lists every external acceptance requirement without closing Milestone 2', () => {
  const result = checkRelease(fixture());
  expect(result).toMatchObject({
    localVerification: 'passed',
    deploymentAllowed: false,
    milestone2Complete: false,
  });
  expect(result.outstanding).toContain('owner decisions');
  expect(result.outstanding).toContain('operational monitoring and runbooks');
});

test('approval flags without review identity and hashed evidence cannot close a gate', () => {
  const root = fixture({ version: 1, gates: [{ id: 'provider', status: 'verified' }] });
  expect(() => checkRelease(root)).toThrow();
});

test('unrecognized or duplicate gates are rejected rather than silently ignored', () => {
  for (const gates of [
    [{ id: 'invented', status: 'pending', reason: 'waiting' }],
    [
      { id: 'provider', status: 'pending', reason: 'waiting' },
      { id: 'provider', status: 'pending', reason: 'waiting' },
    ],
  ])
    expect(() => checkRelease(fixture({ version: 1, gates }))).toThrow();
});

function reviewedFixture() {
  const root = fixture();
  mkdirSync(join(root, 'qualification/evidence'));
  const evidence = 'Synthetic tool test only: never a real qualification.';
  writeFileSync(join(root, 'qualification/evidence/test.md'), evidence);
  const manifest = {
    version: 1,
    gates: Object.entries(qualificationGates).map(([id, [, scope]]) => ({
      id,
      status: 'verified',
      scope,
      reviewedBy: 'Synthetic reviewer',
      reviewedAt: '2026-01-01T00:00:00Z',
      applicationDigest: qualificationDigest(root),
      evidence: {
        path: 'qualification/evidence/test.md',
        sha256: createHash('sha256').update(evidence).digest('hex'),
      },
    })),
  };
  const refresh = () => {
    writeFileSync(join(root, 'qualification/acceptance.json'), JSON.stringify(manifest));
    writeFileSync(
      join(root, 'artifacts/verify.json'),
      JSON.stringify({
        status: 'passed',
        sourceDigest: sourceDigest(root),
        scope: 'synthetic-local-only',
      }),
    );
  };
  refresh();
  return { root, manifest, refresh };
}

test('complete evidence closes only acceptance and never enables deployment', () => {
  const { root } = reviewedFixture();
  expect(checkRelease(root)).toMatchObject({
    milestone2Complete: true,
    deploymentAllowed: false,
    outstanding: [],
  });
});

test('an edited evidence file and a newly verified implementation invalidate old qualifications', () => {
  const fixture = reviewedFixture();
  writeFileSync(join(fixture.root, 'qualification/evidence/test.md'), 'Altered evidence');
  fixture.refresh();
  expect(() => checkRelease(fixture.root)).toThrow('hash mismatch');
  const next = reviewedFixture();
  writeFileSync(join(next.root, 'source.ts'), 'New implementation');
  next.refresh();
  expect(() => checkRelease(next.root)).toThrow('Stale qualification');
});

test('local test evidence cannot stand in for hosted evidence and traversal cannot escape the evidence directory', () => {
  const fixture = reviewedFixture();
  fixture.manifest.gates[0]!.scope = 'automated-review';
  fixture.refresh();
  expect(() => checkRelease(fixture.root)).toThrow('Wrong evidence scope');
  const next = reviewedFixture();
  next.manifest.gates[0]!.evidence.path = 'qualification/evidence/../../source.ts.md';
  next.refresh();
  expect(() => checkRelease(next.root)).toThrow('Unsafe evidence path');
});

test('owner scope uses automated content and accessibility evidence without human sign-off', () => {
  expect(qualificationGates.content[1]).toBe('automated-review');
  expect(qualificationGates.accessibility[1]).toBe('automated-review');
  const { root, manifest, refresh } = reviewedFixture();
  for (const gate of manifest.gates) {
    if (gate.id === 'content' || gate.id === 'accessibility') {
      gate.scope = 'automated-review' as typeof gate.scope;
      gate.reviewedBy = 'reflection automated qualification';
    }
  }
  refresh();
  expect(checkRelease(root).milestone2Complete).toBe(true);
});
