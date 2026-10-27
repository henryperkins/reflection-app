import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { expect, test } from 'vitest';
import { verificationEnvironment } from '../../scripts/verification-environment.ts';
const run = (args: string[]) =>
  spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve('scripts/content-activate.ts'), ...args],
    { encoding: 'utf8', env: verificationEnvironment(process.env), timeout: 10000 },
  );
test('help requires no credentials and draft check cannot grant approval', () => {
  expect(run(['--help']).status).toBe(0);
  const result = run(['--check', '--bundle', 'content/launch-canon-draft.json']);
  expect(result.status).toBe(1);
  expect(result.stdout + result.stderr).toContain('not approved');
  expect(run(['--remote']).status).toBe(1);
});
test('review packet exposes exact readable draft, hash changes and all 156 sources without granting approval', () => {
  const temp = mkdtempSync(join(tmpdir(), 'reflection-content-'));
  try {
    const output = join(temp, 'review.md'),
      before = readFileSync('content/launch-canon-draft.json', 'utf8');
    const result = run([
      '--review-packet',
      '--bundle',
      'content/launch-canon-draft.json',
      '--previous',
      'content/launch-canon-draft.json',
      '--out',
      output,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const packet = readFileSync(output, 'utf8');
    expect(packet).toContain('UNAPPROVED');
    expect(packet).toContain('156');
    expect(packet).toContain('No content differences');
    expect(packet).toContain('providerRetention');
    for (const source of JSON.parse(before).sources) expect(packet).toContain(source.hash);
    expect(readFileSync('content/launch-canon-draft.json', 'utf8')).toBe(before);
    writeFileSync(output, 'preserve existing operator artifact');
    expect(
      run(['--review-packet', '--bundle', 'content/launch-canon-draft.json', '--out', output])
        .status,
    ).toBe(1);
    expect(readFileSync(output, 'utf8')).toBe('preserve existing operator artifact');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
