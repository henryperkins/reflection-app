import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { projectRoot } from './schemas.ts';
import { sourceDigest } from './verification-state.ts';
import { assertNoLocalSecrets, verificationEnvironment } from './verification-environment.ts';
import { requireBrowserTests, requireExecutedTests } from './test-evidence.ts';

const deadlineMs = 540_000;
const stages = [
  ['format and lint', 'node_modules/@biomejs/biome/bin/biome', ['check', '.']],
  ['strict TypeScript', 'node_modules/typescript/bin/tsc', ['--noEmit']],
  ['generated schema drift', 'node', ['--import', 'tsx', 'scripts/schemas.ts', '--check']],
  ['contract and reference checks', 'node', ['--import', 'tsx', 'checks/check-contracts.ts']],
  ['private field coverage', 'python3', ['scripts/check-registry.py']],
  ['SQLite constraints', 'python3', ['checks/check-sql.py']],
  ['OpenAPI', 'node', ['--import', 'tsx', 'checks/check-openapi.ts']],
  [
    'domain and verification behavior',
    'node',
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.domain.config.ts',
      '--reporter=default',
      '--reporter=json',
      '--outputFile=artifacts/domain-tests.json',
    ],
  ],
  [
    'workerd D1 batches',
    'node',
    [
      'node_modules/vitest/vitest.mjs',
      'run',
      '--config',
      'vitest.db.config.ts',
      '--reporter=default',
      '--reporter=json',
      '--outputFile=artifacts/db-tests.json',
    ],
  ],
  ['client production build', 'node', ['node_modules/vite/bin/vite.js', 'build']],
  [
    'Worker dry-run build',
    'node',
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--dry-run',
      '--env-file',
      'scripts/verification.env',
      '--outdir',
      'dist/worker',
    ],
  ],
  ['identity recovery browser journey', 'node', ['node_modules/@playwright/test/cli.js', 'test']],
  ['specification package links', 'python3', ['checks/check-package.py']],
] as const;

function run(command: string, args: readonly string[], remainingMs: number): Promise<void> {
  return new Promise((accept, reject) => {
    const executable = command === 'node' ? process.execPath : command;
    const child = spawn(executable, [...args], {
      cwd: projectRoot,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      env: verificationEnvironment(process.env),
    });
    let timedOut = false;
    let interrupted: string | null = null;
    const stop = () => {
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Process already exited. */
        }
      } else child.kill('SIGKILL');
    };
    const onInterrupt = () => {
      interrupted = 'SIGINT';
      stop();
    };
    const onTerminate = () => {
      interrupted = 'SIGTERM';
      stop();
    };
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, remainingMs);
    const cleanup = () => {
      clearTimeout(timer);
      process.removeListener('SIGINT', onInterrupt);
      process.removeListener('SIGTERM', onTerminate);
    };
    child.on('error', (error) => {
      cleanup();
      reject(error);
    });
    child.on('close', (code) => {
      cleanup();
      if (interrupted) reject(new Error(`Verification interrupted by ${interrupted}`));
      else if (timedOut) reject(new Error('Verification exceeded the 540-second deadline'));
      else if (code !== 0) reject(new Error(`Verification command failed (exit ${code})`));
      else accept();
    });
  });
}

export async function verify(): Promise<void> {
  const started = performance.now();
  mkdirSync(resolve(projectRoot, 'artifacts'), { recursive: true });
  writeFileSync(
    resolve(projectRoot, 'artifacts/verify.json'),
    JSON.stringify({ status: 'running' }),
  );
  let source: string | null = null;
  const results: { name: string; durationMs: number; status: 'passed' | 'failed' }[] = [];
  let passed = false;
  try {
    assertNoLocalSecrets(projectRoot);
    source = sourceDigest(projectRoot);
    for (const [name, command, args] of stages) {
      const remaining = deadlineMs - (performance.now() - started);
      if (remaining <= 0) throw new Error('Verification deadline exhausted');
      console.log(`\n[verify] ${name}`);
      const stageStarted = performance.now();
      try {
        const report =
          name === 'workerd D1 batches'
            ? 'db-tests.json'
            : name === 'identity recovery browser journey'
              ? 'browser-tests.json'
              : name === 'domain and verification behavior'
                ? 'domain-tests.json'
                : null;
        if (report) rmSync(resolve(projectRoot, 'artifacts', report), { force: true });
        await run(command, args, remaining);
        if (report) {
          const evidence = (
            name === 'identity recovery browser journey'
              ? requireBrowserTests
              : requireExecutedTests
          )(JSON.parse(readFileSync(resolve(projectRoot, 'artifacts', report), 'utf8')));
          console.log(
            `[verify] confirmed ${evidence.passed} executed tests across ${evidence.files} files; zero skipped`,
          );
        }
        results.push({
          name,
          durationMs: Math.round(performance.now() - stageStarted),
          status: 'passed',
        });
      } catch (error) {
        results.push({
          name,
          durationMs: Math.round(performance.now() - stageStarted),
          status: 'failed',
        });
        throw error;
      }
    }
    if (sourceDigest(projectRoot) !== source) throw new Error('Source changed during verification');
    passed = true;
  } finally {
    const receipt = {
      version: 1,
      status: passed ? 'passed' : 'failed',
      sourceDigest: source,
      node: process.version,
      finishedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      deadlineMs,
      stages: results,
      scope: 'synthetic-local-only',
      applicationBrowserAcceptance: passed ? 'local-identity-recovery-only' : 'not-passed',
      hostedQualification: 'not-run',
    };
    mkdirSync(resolve(projectRoot, 'artifacts'), { recursive: true });
    writeFileSync(
      resolve(projectRoot, 'artifacts/verify.json'),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    console.log(
      `\n[verify] ${receipt.status} in ${(receipt.durationMs / 1000).toFixed(2)}s; artifacts/verify.json`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await verify();
}
