import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseIdentitySecrets } from '../src/worker/identity/crypto.ts';
import { verificationEnvironment } from './verification-environment.ts';

/** Keep provider credentials in memory; persist only this app's own encryption keys. */
export function loadLocalLiveSettings(
  root: string,
  envFile?: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  let file = envFile;
  if (!file) {
    const candidates = [join(root, '.env.local'), join(root, '.env')];
    try {
      const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      candidates.push(join(dirname(resolve(root, common)), '.env'));
    } catch {
      /* A packaged copy need not be a git checkout. */
    }
    file = candidates.find((candidate) => existsSync(candidate));
  }
  const values = file ? parseEnv(readFileSync(resolve(file), 'utf8')) : {};
  const apiKey = environment.OPENAI_API_KEY ?? values.OPENAI_API_KEY;
  const projectId = environment.OPENAI_PROJECT_ID ?? values.OPENAI_PROJECT_ID;
  const persistence = join(root, '.wrangler', 'live-development');
  mkdirSync(persistence, { recursive: true, mode: 0o700 });
  const identityFile = join(persistence, 'identity.json');
  if (!existsSync(identityFile)) {
    writeFileSync(
      identityFile,
      JSON.stringify({
        environment: 'live-local',
        keyId: 'local-live-v1',
        wrapKey: randomBytes(32).toString('base64url'),
        recoveryKey: randomBytes(32).toString('base64url'),
        hmacKey: randomBytes(32).toString('base64url'),
      }),
      { flag: 'wx', mode: 0o600 },
    );
  }
  const identitySecrets = readFileSync(identityFile, 'utf8');
  if (parseIdentitySecrets(identitySecrets).environment !== 'live-local')
    throw new Error('Local app key configuration unavailable');
  return { apiKey: apiKey ?? '', projectId: projectId ?? '', identitySecrets, persistence };
}

export function localLiveRuntimeOptions(
  root: string,
  settings: ReturnType<typeof loadLocalLiveSettings>,
) {
  return {
    scriptPath: join(root, '.wrangler/live-build/local-live.js'),
    modules: true,
    compatibilityDate: '2026-10-23',
    compatibilityFlags: ['nodejs_compat'],
    host: '127.0.0.1',
    port: 8787,
    cf: false,
    logRequests: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(settings.persistence, 'v3'),
    d1Databases: { DB: 'DB' },
    r2Buckets: { RECOVERY: 'RECOVERY' },
    bindings: {
      IDENTITY_MODE: 'live-local',
      READING_MODE: 'live-local',
      IDENTITY_ORIGIN: 'http://localhost:8787',
      IDENTITY_SECRETS: settings.identitySecrets,
      OPENAI_API_KEY: settings.apiKey,
      OPENAI_PROJECT_ID: settings.projectId,
    },
    assets: {
      directory: join(root, 'dist/client'),
      binding: 'ASSETS',
      run_worker_first: true,
      routerConfig: { has_user_worker: true },
      assetConfig: { not_found_handling: 'single-page-application' as const },
    },
  };
}

export async function startLocalLive(root: string, envFile?: string) {
  const settings = loadLocalLiveSettings(root, envFile);
  const run = (script: string, args: string[]) => {
    const result = spawnSync(process.execPath, [join(root, script), ...args], {
      cwd: root,
      env: verificationEnvironment(process.env),
      stdio: 'pipe',
    });
    if (result.status !== 0)
      throw new Error('Local app build or migration failed. Run npm run verify for details.');
  };
  console.log('Building the local live app…');
  run('node_modules/vite/bin/vite.js', ['build']);
  run('node_modules/wrangler/bin/wrangler.js', [
    'deploy',
    '--dry-run',
    '--config',
    'wrangler.live.jsonc',
    '--env-file',
    'scripts/verification.env',
    '--outdir',
    '.wrangler/live-build',
  ]);
  run('node_modules/wrangler/bin/wrangler.js', [
    'd1',
    'migrations',
    'apply',
    'reflection-live-local',
    '--local',
    '--config',
    'wrangler.live.jsonc',
    '--env-file',
    'scripts/verification.env',
    '--persist-to',
    settings.persistence,
  ]);
  const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
  const runtime = new Miniflare(convertV4MiniflareOptions(localLiveRuntimeOptions(root, settings)));
  try {
    await runtime.ready;
    const worker = await runtime.getWorker();
    let maintaining = false;
    const tick = async () => {
      if (maintaining) return;
      maintaining = true;
      try {
        await worker.scheduled({ cron: '* * * * *' });
      } catch {
        console.warn('Local maintenance will retry.');
      } finally {
        maintaining = false;
      }
    };
    await tick();
    const interval = setInterval(() => void tick(), 60_000);
    console.log('Reflection: http://localhost:8787 — GPT-6.1 Terra, fast/xhigh.');
    if (!settings.apiKey || !/^proj_[\w-]+$/.test(settings.projectId))
      console.log(
        'Saved readings are available. Add OPENAI_API_KEY and OPENAI_PROJECT_ID to .env and restart to generate readings.',
      );
    console.log('The API key stays on the server. Stop with Ctrl+C.');
    try {
      await new Promise<void>((accept) => {
        process.once('SIGINT', accept);
        process.once('SIGTERM', accept);
      });
    } finally {
      clearInterval(interval);
    }
  } finally {
    await runtime.dispose();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--env-file')) {
    console.error('Usage: npm run dev:live -- [--env-file /path/to/.env]');
    process.exitCode = 1;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    await startLocalLive(root, args[1]).catch((error) => {
      // Only our known messages are safe to display; tool/credential errors stay private.
      console.error(
        error instanceof Error && /^(Set OPENAI_API_KEY|Local app build)/.test(error.message)
          ? error.message
          : 'Local live app could not start. Check the key file and whether port 8787 is free.',
      );
      process.exitCode = 1;
    });
  }
}
