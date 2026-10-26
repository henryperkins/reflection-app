import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, test } from 'vitest';
import { sourceDigest } from '../../scripts/verification-state.ts';

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'reflection-package-'));
  temporary.push(root);
  for (const dir of ['src', 'artifacts', '.wrangler', 'node_modules']) mkdirSync(join(root, dir));
  writeFileSync(join(root, 'src/app.ts'), 'export const app = true;');
  writeFileSync(join(root, 'package.json'), '{"name":"reflection-app"}');
  writeFileSync(join(root, 'package-lock.json'), '{}');
  writeFileSync(join(root, '.node-version'), '26.12.1\n');
  writeFileSync(join(root, '.npmrc'), 'engine-strict=true\n');
  writeFileSync(join(root, '.env'), 'SECRET=must-not-be-shipped');
  writeFileSync(join(root, '.wrangler/private.sqlite'), 'private database');
  writeFileSync(join(root, 'node_modules/private.key'), 'private key');
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

function run(root: string, output: string, mode: string) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/package.ts', mode, output, root],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

test('the ZIP is reproducible, includes verification evidence, and excludes local data and secrets', () => {
  const root = fixture();
  const output = mkdtempSync(join(tmpdir(), 'reflection-delivery-'));
  temporary.push(output);
  const first = join(output, 'one.zip');
  const second = join(output, 'two.zip');
  expect(run(root, first, '--local-snapshot').status).toBe(0);
  expect(run(root, second, '--local-snapshot').status).toBe(0);
  expect(readFileSync(first)).toEqual(readFileSync(second));
  const contents = spawnSync(
    'python3',
    [
      '-c',
      'import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); print("\\n".join(z.namelist())); print(z.read("reflection-app/artifacts/DELIVERY.json").decode())',
      first,
    ],
    { encoding: 'utf8' },
  ).stdout;
  expect(contents).toContain('reflection-app/src/app.ts');
  expect(contents).toContain('reflection-app/artifacts/verify.json');
  expect(contents).toContain('local-snapshot');
  expect(contents).not.toMatch(/\.env|node_modules|\.sqlite|private\.key/);
  expect(readFileSync(`${first}.sha256`, 'utf8')).toMatch(/^[a-f0-9]{64} {2}one.zip\n$/);
  const extracted = join(output, 'extracted');
  expect(
    spawnSync('python3', [
      '-c',
      'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',
      first,
      extracted,
    ]).status,
  ).toBe(0);
  expect(sourceDigest(join(extracted, 'reflection-app'))).toBe(sourceDigest(root));
});

test('completed-milestone packaging refuses pending qualification and stale verification', () => {
  const root = fixture();
  const output = join(tmpdir(), `reflection-refused-${crypto.randomUUID()}.zip`);
  expect(run(root, output, '--completed-milestone').status).not.toBe(0);
  writeFileSync(join(root, 'src/app.ts'), 'changed after verification');
  expect(run(root, output, '--local-snapshot').status).not.toBe(0);
});
