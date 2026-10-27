import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from 'vitest';
import { verificationEnvironment } from '../../scripts/verification-environment.ts';
function run(args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/key-retire.ts', ...args], {
    encoding: 'utf8',
    env: verificationEnvironment(process.env),
  });
}
test('retirement help separates protected candidate preparation from secret installation', () => {
  const result = run(['--help']);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    scope: 'trusted-offline-operator',
    installsSecrets: false,
    destroysOfflineCopies: false,
  });
});
test('malformed key input cannot create a plan or appear in command output', () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-retire-cli-'));
  try {
    const keys = join(root, 'keys.json'),
      inventory = join(root, 'inventory.json'),
      plan = join(root, 'plan.json');
    writeFileSync(keys, 'PRIVATE_RETIREMENT_KEY_CANARY');
    writeFileSync(inventory, '{}');
    const result = run([
      '--plan',
      '--current',
      keys,
      '--inventory',
      inventory,
      '--remove',
      'old-key',
      '--output',
      plan,
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('PRIVATE_RETIREMENT_KEY_CANARY');
    expect(existsSync(plan)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
