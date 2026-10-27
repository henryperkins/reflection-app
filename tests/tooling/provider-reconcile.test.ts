import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { providerReceipt } from '../fixtures/provider.ts';
import { READING_PROVIDER_POLICY as policy } from '../../src/contracts/provider-policy.ts';
import { providerPolicyHash } from '../../src/domain/provider-policy.ts';
import { sha256Bytes } from '../../src/domain/json.ts';
import { verificationEnvironment } from '../../scripts/verification-environment.ts';
const run = (args: string[]) =>
  spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve('scripts/provider-reconcile.ts'), ...args],
    { encoding: 'utf8', env: verificationEnvironment(process.env), timeout: 10000 },
  );
test('operator checks receipt import and evidence without opening storage or exposing response IDs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-bill-'));
  try {
    const evidence = join(root, 'bill.txt'),
      input = join(root, 'import.json'),
      bytes = new TextEncoder().encode('Operator bill evidence');
    writeFileSync(evidence, bytes);
    const file = {
      version: 'provider-cost-import.v1',
      reviewerId: 'operator-a',
      reviewedAt: '2026-10-26T00:00:00Z',
      policyHash: await providerPolicyHash(policy),
      evidenceHash: await sha256Bytes(bytes),
      receipts: [
        {
          dispatchId: 'test-dispatch',
          receiptId: 'bill-line-1',
          receipt: providerReceipt({
            responseId: 'PRIVATE_RESPONSE_ID_CANARY',
            returnedModel: policy.model,
            usage: {
              inputTokens: 1000,
              cachedInputTokens: 200,
              cacheWriteTokens: 300,
              outputTokens: 100,
              reasoningTokens: 0,
            },
          }),
        },
      ],
    };
    writeFileSync(input, JSON.stringify(file));
    expect(run(['--help']).status).toBe(0);
    const checked = run(['--check', '--input', input, '--evidence', evidence]);
    expect(checked.status, checked.stderr).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({
      receipts: 1,
      knownMicrousd: 1385,
      applied: false,
    });
    expect(checked.stdout + checked.stderr).not.toContain('PRIVATE_RESPONSE_ID_CANARY');
    writeFileSync(evidence, 'Changed after review');
    expect(run(['--check', '--input', input, '--evidence', evidence]).status).toBe(1);
    expect(run(['--remote', '--input', input, '--evidence', evidence]).status).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
