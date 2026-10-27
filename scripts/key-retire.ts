import { readFileSync, statSync, openSync, writeFileSync, closeSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '../src/domain/json.ts';
import { IdentityCrypto, parseIdentitySecrets } from '../src/worker/identity/crypto.ts';
import {
  normalizedKeyring,
  planKeyRetirement,
  planAccountDataKeyRetirement,
  parseRetirementPlan,
  applyKeyRetirement,
  applyAccountDataKeyRetirement,
  checkRetirementCandidate,
  type RetirementReceipt,
} from '../src/worker/recovery/key-retirement.ts';
import type { ApplicationRuntime } from '../src/worker/runtime/application.ts';
import type { OfflineContext } from '../src/worker/recovery/hosted-coordinator.ts';
import type { BackupInventory } from '../src/worker/recovery/backup-inventory.ts';
import type { KeyReferenceInventory } from '../src/worker/recovery/key-inventory.ts';

function readJson(path: string, limit = 64 * 1024 * 1024): unknown {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > limit) throw new Error('Invalid protected input');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function writeNew(path: string, value: unknown) {
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeFileSync(fd, canonicalJson(value) + '\n');
  } finally {
    closeSync(fd);
  }
}
function ring(path: string) {
  if (!statSync(path).isFile() || statSync(path).size > 32768)
    throw new Error('Invalid protected keyring');
  return normalizedKeyring(new IdentityCrypto(parseIdentitySecrets(readFileSync(path, 'utf8'))));
}
export async function runKeyRetirement(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help')
    return {
      scope: 'trusted-offline-operator',
      installsSecrets: false,
      destroysOfflineCopies: false,
      usage: [
        'npm run key:retire -- --plan --current /private/keys.json --inventory /private/inventory.json --remove old-key --output /private/plan.json',
        'npm run key:retire -- --plan-data --inventory /private/inventory.json --owner account-uuid --version 1 --output /private/plan.json',
        'npm run key:retire -- --apply --plan /private/plan.json --adapter /private/bindings.mjs --candidate /private/new-keys.json --receipt /private/new-receipt.json',
        'npm run key:retire -- --check-candidate --current /private/keys.json --candidate /private/new-keys.json --receipt /private/receipt.json',
      ],
      note: 'Explicit protected bindings revalidate references and epoch. Candidate preparation does not install secrets or destroy copies. Account-data retirement deletes only a proven unreferenced wrapped version and journals that mutation atomically. Ingress stays closed.',
    };
  const mode = argv[0],
    flags = new Map<string, string>();
  if (!['--plan', '--plan-data', '--apply', '--check-candidate'].includes(mode ?? ''))
    throw new Error('Explicit operator mode required');
  for (let i = 1; i < argv.length; i += 2) {
    const flag = argv[i],
      value = argv[i + 1];
    if (
      !flag ||
      ![
        '--current',
        '--inventory',
        '--remove',
        '--output',
        '--owner',
        '--version',
        '--plan',
        '--adapter',
        '--candidate',
        '--receipt',
      ].includes(flag) ||
      !value ||
      flags.has(flag)
    )
      throw new Error('Invalid operator arguments');
    if (!['--remove', '--owner', '--version'].includes(flag) && !isAbsolute(value))
      throw new Error('Use absolute protected paths');
    flags.set(flag, value);
  }
  const requireFlags = (names: string[]) => {
    if (flags.size !== names.length || names.some((name) => !flags.has(name)))
      throw new Error('Explicit protected inputs required');
  };
  if (mode === '--plan') {
    requireFlags(['--current', '--inventory', '--remove', '--output']);
    const plan = await planKeyRetirement(
      ring(flags.get('--current')!),
      readJson(flags.get('--inventory')!) as KeyReferenceInventory,
      flags.get('--remove')!.split(','),
    );
    writeNew(flags.get('--output')!, plan);
    return {
      scope: 'trusted-offline-operator',
      allowed: plan.allowed,
      reasons: plan.reasons,
      operationId: plan.operationId,
      installsSecrets: false,
      destroysOfflineCopies: false,
    };
  }
  if (mode === '--plan-data') {
    requireFlags(['--inventory', '--owner', '--version', '--output']);
    const plan = await planAccountDataKeyRetirement(
      readJson(flags.get('--inventory')!) as KeyReferenceInventory,
      flags.get('--owner')!,
      Number(flags.get('--version')),
    );
    writeNew(flags.get('--output')!, plan);
    return {
      scope: 'trusted-offline-operator',
      allowed: plan.allowed,
      reasons: plan.reasons,
      operationId: plan.operationId,
      installsSecrets: false,
      destroysOfflineCopies: false,
    };
  }
  if (mode === '--check-candidate') {
    requireFlags(['--current', '--candidate', '--receipt']);
    return {
      ...(await checkRetirementCandidate(
        ring(flags.get('--current')!),
        ring(flags.get('--candidate')!),
        readJson(flags.get('--receipt')!, 32768) as RetirementReceipt,
      )),
      installsSecrets: false,
      destroysOfflineCopies: false,
    };
  }
  const plan = parseRetirementPlan(readJson(flags.get('--plan') ?? '', 32768));
  requireFlags(
    plan.kind === 'environment'
      ? ['--plan', '--adapter', '--candidate', '--receipt']
      : ['--plan', '--adapter', '--receipt'],
  );
  if (!plan.allowed) throw new Error('Plan rejected');
  // Reserve output files before any mutation; existing files are never overwritten.
  const receiptPath = flags.get('--receipt')!,
    fd = openSync(receiptPath, 'wx', 0o600);
  writeFileSync(
    fd,
    canonicalJson({
      status: 'started',
      operationId: plan.operationId,
      requiresOffline: true,
      offlineVerified: false,
    }) + '\n',
  );
  closeSync(fd);
  let candidatePath: string | undefined;
  if (plan.kind === 'environment') {
    candidatePath = flags.get('--candidate')!;
    const candidateFd = openSync(candidatePath, 'wx', 0o600);
    closeSync(candidateFd);
  }
  try {
    const adapter = (await import(pathToFileURL(flags.get('--adapter')!).href)) as {
      withKeyRetirement?: (
        plan: ReturnType<typeof parseRetirementPlan>,
        execute: (bound: {
          runtime: ApplicationRuntime;
          context: OfflineContext;
          backups: BackupInventory;
        }) => Promise<unknown>,
      ) => Promise<unknown>;
    };
    if (typeof adapter.withKeyRetirement !== 'function')
      throw new Error('Protected binding adapter required');
    let invoked = false,
      executed:
        | Awaited<ReturnType<typeof applyKeyRetirement>>
        | Awaited<ReturnType<typeof applyAccountDataKeyRetirement>>
        | undefined;
    await adapter.withKeyRetirement(plan, async ({ runtime, context, backups }) => {
      if (invoked) throw new Error('One explicit retirement operation required');
      invoked = true;
      executed =
        plan.kind === 'environment'
          ? await applyKeyRetirement(runtime, context, backups, plan)
          : await applyAccountDataKeyRetirement(runtime, context, backups, plan);
      return executed;
    });
    if (!executed) throw new Error('Fenced retirement did not run');
    if ('candidate' in executed) {
      writeFileSync(candidatePath!, canonicalJson(executed.candidate) + '\n', { mode: 0o600 });
      writeFileSync(receiptPath, canonicalJson(executed.receipt) + '\n', { mode: 0o600 });
      return executed.receipt;
    }
    writeFileSync(receiptPath, canonicalJson(executed) + '\n', { mode: 0o600 });
    return executed;
  } catch {
    writeFileSync(
      receiptPath,
      canonicalJson({
        status: 'failed',
        operationId: plan.operationId,
        requiresOffline: true,
        offlineVerified: false,
        installsSecrets: false,
        destroysOfflineCopies: false,
      }) + '\n',
      { mode: 0o600 },
    );
    throw new Error('Retirement remains offline; protected progress retained');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runKeyRetirement(process.argv.slice(2))));
  } catch {
    console.error(
      'Key retirement could not complete. Private inputs were not displayed; retain the installed keys and keep the target offline.',
    );
    process.exitCode = 1;
  }
}
