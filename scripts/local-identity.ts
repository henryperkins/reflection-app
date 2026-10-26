import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { startLocalMaintenance } from './local-maintenance.ts';
const config = 'wrangler.identity.jsonc';
const testing = process.argv.includes('--test');
const persistence = testing
  ? mkdtempSync(join(tmpdir(), 'reflection-identity-'))
  : '.wrangler/identity-development';
process.on('exit', () => {
  if (testing) rmSync(persistence, { recursive: true, force: true });
});
async function run(script: string, args: string[]) {
  await new Promise<void>((accept, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: 'inherit' });
    const stop = () => child.kill('SIGTERM');
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
    child.once('error', reject);
    child.once('close', (code) => {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      code === 0 ? accept() : reject(new Error('Local identity process failed'));
    });
  });
}
await run('node_modules/vite/bin/vite.js', ['build']);
const cli = resolve('node_modules/wrangler/bin/wrangler.js');
await run(cli, [
  'd1',
  'migrations',
  'apply',
  'reflection-identity-local',
  '--local',
  '--config',
  config,
  '--env-file',
  'scripts/verification.env',
  '--persist-to',
  persistence,
]);
const stopMaintenance = startLocalMaintenance();
try {
  await run(cli, [
    'dev',
    '--test-scheduled',
    '--local',
    '--config',
    config,
    '--env-file',
    'scripts/verification.env',
    '--persist-to',
    persistence,
    '--ip',
    '127.0.0.1',
    '--port',
    '8787',
  ]);
} finally {
  stopMaintenance();
}
