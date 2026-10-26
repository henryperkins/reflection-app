import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { IdentityCrypto, parseIdentitySecrets } from '../src/worker/identity/crypto.ts';
import {
  LocalKeyRotation,
  validateKeyringTransition,
} from '../src/worker/recovery/key-rotation.ts';
import { OfflineRestore } from '../src/worker/recovery/restore.ts';
import type { Env } from '../src/worker/index.ts';

function argumentsFor(argv: string[]) {
  const mode = argv[0];
  if (!['--check-config', '--check', '--rewrap'].includes(mode ?? '')) throw new Error();
  const values = new Map<string, string>();
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index],
      value = argv[index + 1];
    if (
      !flag ||
      !['--current', '--candidate', '--persist-to', '--receipt'].includes(flag) ||
      !value ||
      value.startsWith('--') ||
      values.has(flag)
    )
      throw new Error();
    values.set(flag, resolve(value));
  }
  if (!values.has('--current') || !values.has('--candidate')) throw new Error();
  if (mode !== '--check-config' && !values.has('--persist-to')) throw new Error();
  if (mode === '--rewrap' && !values.has('--receipt')) throw new Error();
  if (mode !== '--rewrap' && values.has('--receipt')) throw new Error();
  if (mode === '--check-config' && values.has('--persist-to')) throw new Error();
  return { mode, values };
}
function readKeys(path: string) {
  if (!statSync(path).isFile() || statSync(path).size > 32_000) throw new Error();
  return parseIdentitySecrets(readFileSync(path, 'utf8'));
}

/** Explicit local files and fixed local storage IDs only; no provider credentials or deployment. */
export async function runKeyRotation(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help')
    return {
      scope: 'synthetic-local-only',
      deploymentAllowed: false,
      usage: [
        'npm run key:rotate -- --check-config --current <current.json> --candidate <candidate.json>',
        'npm run key:rotate -- --check --current <current.json> --candidate <candidate.json> --persist-to <local-state-v3-directory>',
        'npm run key:rotate -- --rewrap --current <current.json> --candidate <candidate.json> --persist-to <local-state-v3-directory> --receipt <new-operation.json>',
      ],
      notes:
        'Stop the local app and maintenance runner before inventory/rewrap. Existing keys are retained; rewrap leaves the database offline. Inputs are supplied files; keys are never generated or printed.',
    };
  const { mode, values } = argumentsFor(argv),
    current = readKeys(values.get('--current')!),
    candidate = readKeys(values.get('--candidate')!),
    sourceCrypt = new IdentityCrypto(current),
    candidateCrypt = new IdentityCrypto(candidate);
  validateKeyringTransition(sourceCrypt, candidateCrypt);
  const summary = {
    scope: 'synthetic-local-only',
    activeKeyId: candidateCrypt.secrets.keyId,
    retainedKeyIds: candidateCrypt
      .retainedKeys()
      .map((key) => key.secrets.keyId)
      .sort(),
    deploymentAllowed: false,
    keyRetirementAllowed: false,
  };
  if (mode === '--check-config') return summary;

  const persistence = values.get('--persist-to')!;
  if (!statSync(persistence).isDirectory()) throw new Error();
  // A local operator process owns the store; the app and scheduled runner must be stopped.
  const lock = join(persistence, '.key-rotation.lock'),
    descriptor = openSync(lock, 'wx', 0o600);
  let receiptDescriptor: number | undefined;
  try {
    const { Miniflare, convertV4MiniflareOptions } = await import('miniflare');
    const runtime = new Miniflare(
      convertV4MiniflareOptions({
        script: '',
        modules: true,
        compatibilityDate: '2026-10-23',
        compatibilityFlags: ['nodejs_compat'],
        cf: false,
        logRequests: false,
        telemetry: { enabled: false },
        resourcePersistencePath: persistence,
        d1Databases: { DB: 'DB' },
        r2Buckets: { RECOVERY: 'reflection-identity-local-checkpoints' },
      }),
    );
    try {
      const storage = await runtime.getBindings<Pick<Env, 'DB' | 'RECOVERY'>>();
      const env: Env = {
        ...storage,
        IDENTITY_MODE: 'synthetic-local',
        READING_MODE: 'synthetic-local',
        IDENTITY_ORIGIN: 'http://localhost:8787',
        IDENTITY_SECRETS: JSON.stringify(current),
        RESTORE_MODE: 'offline',
      };
      const rotation = new LocalKeyRotation(env, candidate);
      if (mode === '--check') return await rotation.check();
      const receiptPath = values.get('--receipt')!;
      // Reserve a new protected audit artifact before changing the database.
      receiptDescriptor = openSync(receiptPath, 'wx', 0o600);
      const operation = {
        operationId: crypto.randomUUID(),
        startedAt: new Date().toISOString(),
        ...summary,
      };
      writeFileSync(
        receiptDescriptor,
        `${JSON.stringify({ ...operation, state: 'started' }, null, 2)}\n`,
      );
      closeSync(receiptDescriptor);
      receiptDescriptor = undefined;
      await new OfflineRestore(env).prepare();
      const result = await rotation.rewrap();
      writeFileSync(
        receiptPath,
        `${JSON.stringify(
          { ...operation, ...result, state: 'complete', completedAt: new Date().toISOString() },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      return result;
    } finally {
      await runtime.dispose();
    }
  } finally {
    if (receiptDescriptor !== undefined) closeSync(receiptDescriptor);
    closeSync(descriptor);
    unlinkSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runKeyRotation(process.argv.slice(2)), null, 2));
  } catch {
    // Keyring parse errors and dependency exceptions can contain submitted input. Never print them.
    console.error(
      'Key rotation refused: check the explicit local inputs, retained keys, and offline inventory. No key material was printed.',
    );
    process.exitCode = 1;
  }
}
