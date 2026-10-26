import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { checkRelease } from '../../scripts/release.ts';
import { sourceDigest } from '../../scripts/verification-state.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test('even a successful current local receipt cannot enable deployment', () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-release-'));
  temporary.push(root);
  mkdirSync(join(root, 'artifacts'));
  writeFileSync(join(root, 'source.ts'), 'export const milestone = 1;');
  writeFileSync(
    join(root, 'artifacts/verify.json'),
    JSON.stringify({
      status: 'passed',
      sourceDigest: sourceDigest(root),
      scope: 'synthetic-local-only',
    }),
  );
  expect(checkRelease(root).deploymentAllowed).toBe(false);
  writeFileSync(join(root, 'source.ts'), 'export const milestone = 2;');
  expect(() => checkRelease(root)).toThrow('stale');
});
