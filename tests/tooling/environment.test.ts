import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  assertNoLocalSecrets,
  verificationEnvironment,
} from '../../scripts/verification-environment.ts';

test('synthetic subprocess environment excludes application credentials and build canaries', () => {
  const env = verificationEnvironment({
    PATH: '/synthetic/bin',
    OPENAI_API_KEY: 'SYNTHETIC_CANARY',
    CLOUDFLARE_API_TOKEN: 'SYNTHETIC_CANARY',
    VITE_PRIVATE_TEXT: 'SYNTHETIC_CANARY',
    OPENAI_PROJECT_ID: 'SYNTHETIC_CANARY',
    RUNTIME_MANIFEST: 'SYNTHETIC_CANARY',
    QUALIFICATION_TRUST: 'SYNTHETIC_CANARY',
    IDENTITY_SECRETS: 'SYNTHETIC_CANARY',
    NODE_OPTIONS: '--require=private',
    HTTPS_PROXY: 'synthetic-proxy',
    NODE_EXTRA_CA_CERTS: '/synthetic/ca',
  });
  expect(JSON.stringify(env)).not.toContain('SYNTHETIC_CANARY');
  expect(env.NODE_OPTIONS).toBeUndefined();
  expect(env.HTTPS_PROXY).toBe('synthetic-proxy');
  expect(env.NODE_EXTRA_CA_CERTS).toBe('/synthetic/ca');
});
test('local dotenv files stop verification without reading their contents', () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-env-'));
  try {
    assertNoLocalSecrets(root);
    writeFileSync(join(root, '.env.production'), 'VITE_PRIVATE_TEXT=SYNTHETIC_CANARY');
    expect(() => assertNoLocalSecrets(root)).toThrow('contents were not read');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
