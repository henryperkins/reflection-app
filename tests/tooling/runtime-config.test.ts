import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { runtimeManifest } from '../fixtures/runtime.ts';
import { verificationEnvironment } from '../../scripts/verification-environment.ts';

test('the config renderer writes a closed production candidate and refuses an existing output', () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-runtime-config-'));
  try {
    const input = join(root, 'manifest.json'),
      output = join(root, 'wrangler.json');
    writeFileSync(input, JSON.stringify(runtimeManifest('production')));
    const args = [
      '--import',
      'tsx',
      'scripts/render-hosted-config.ts',
      '--manifest',
      input,
      '--output',
      output,
    ];
    const run = () =>
      spawnSync(process.execPath, args, {
        encoding: 'utf8',
        env: verificationEnvironment(process.env),
      });
    expect(run().status).toBe(0);
    const original = readFileSync(output, 'utf8');
    const config = JSON.parse(original);
    expect(resolve(root, config.main)).toBe(resolve('src/worker/runtime/application.ts'));
    expect(resolve(root, config.assets.directory)).toBe(resolve('dist/client'));
    expect(resolve(root, config.d1_databases[0].migrations_dir)).toBe(
      resolve('src/worker/db/migrations'),
    );
    expect(JSON.parse(JSON.parse(original).vars.RUNTIME_MANIFEST)).toMatchObject({
      ingress: 'off',
      generation: 'off',
    });
    expect(run().status).not.toBe(0);
    expect(readFileSync(output, 'utf8')).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed renderer input never appears in a CLI error', () => {
  const root = mkdtempSync(join(tmpdir(), 'reflection-runtime-config-'));
  try {
    const input = join(root, 'private.json');
    writeFileSync(input, 'PRIVATE_RUNTIME_MARKER');
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/render-hosted-config.ts',
        '--manifest',
        input,
        '--output',
        join(root, 'output.json'),
      ],
      {
        encoding: 'utf8',
        env: verificationEnvironment(process.env),
      },
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).not.toContain('PRIVATE_RUNTIME_MARKER');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
