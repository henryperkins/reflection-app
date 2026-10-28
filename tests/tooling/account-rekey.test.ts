import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { verificationEnvironment } from '../../scripts/verification-environment.ts';
function run(args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/key-rotate-account.ts', ...args],
    { env: verificationEnvironment(process.env), encoding: 'utf8' },
  );
}
test('account rekey entrypoint documents explicit offline bindings without touching a deployment', () => {
  const result = run(['--help']);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    scope: 'trusted-offline-operator',
    deploymentAllowed: false,
  });
});
test('invalid private requests never load an adapter, create a receipt, or print submitted data', () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-rekey-cli-'));
  try {
    const request = join(root, 'request.json'),
      adapter = join(root, 'adapter.mjs'),
      receipt = join(root, 'receipt.json'),
      marker = join(root, 'loaded');
    writeFileSync(request, JSON.stringify({ private: 'PRIVATE_REKEY_CANARY' }));
    writeFileSync(
      adapter,
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'loaded');`,
    );
    const result = run(['--request', request, '--adapter', adapter, '--receipt', receipt]);
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('PRIVATE_REKEY_CANARY');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(receipt)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an adapter cannot claim success without running the fenced operation', () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-rekey-cli-'));
  try {
    const request = join(root, 'request.json'),
      adapter = join(root, 'adapter.mjs'),
      receipt = join(root, 'receipt.json');
    writeFileSync(
      request,
      JSON.stringify({
        version: 1,
        action: 'begin',
        environmentId: 'synthetic-test',
        ownerId: '11111111-1111-4111-8111-111111111111',
        expectedVersion: 1,
        sourceDigest: 'a'.repeat(64),
        configurationDigest: 'b'.repeat(64),
      }),
    );
    writeFileSync(
      adapter,
      `export async function withAccountRekey(){return {operationId:'22222222-2222-4222-8222-222222222222',fromVersion:1,toVersion:2,fields:0,registryHash:'a'.repeat(64),inventoryHash:'b'.repeat(64),stillOffline:true};}`,
    );
    expect(run(['--request', request, '--adapter', adapter, '--receipt', receipt]).status).not.toBe(
      0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
