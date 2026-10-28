import { canonicalJson } from '../src/domain/json.ts';
import { readFileSync, statSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  validateAndResumeRecovery,
  type RecoveryResumeReceipt,
} from '../src/worker/recovery/recovery-validation.ts';
import type { ApplicationRuntime } from '../src/worker/runtime/application.ts';
import type { OfflineContext } from '../src/worker/recovery/hosted-coordinator.ts';
import type { BackupInventory } from '../src/worker/recovery/backup-inventory.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const RecoveryResumeRequest = z.strictObject({
  version: z.literal(1),
  environmentId: z.string().regex(/^[\w-]{1,64}$/),
  operationId: z.uuid(),
  epoch: z.number().int().positive(),
  purpose: z.enum(['restore', 'cleanup', 'rekey', 'retirement']),
  sourceDigest: hash,
  configurationDigest: hash,
});
export type RecoveryResumeRequest = z.infer<typeof RecoveryResumeRequest>;
const Receipt = z.strictObject({
  version: z.literal(1),
  environmentId: z.string().regex(/^[\w-]{1,64}$/),
  operationId: z.uuid(),
  epoch: z.number().int().positive(),
  purpose: z.enum(['restore', 'cleanup', 'rekey', 'retirement']),
  evidenceHash: hash,
  validatedAt: z.iso.datetime(),
  generation: z.literal('off'),
  resumed: z.literal(true),
});

/**
 * Called inside a trusted binding-bearing executor; there is no public
 * resumption route. The adapter supplies the runtime, the exact offline
 * context, the independently signed backup inventory, the artifact bucket
 * and the validator private key, none of which are application bindings.
 */
export async function executeRecoveryResume(
  bound: {
    runtime: ApplicationRuntime;
    context: OfflineContext;
    backups: BackupInventory;
    bucket: R2Bucket;
    signingKey: CryptoKey;
  },
  input: unknown,
): Promise<RecoveryResumeReceipt> {
  const request = RecoveryResumeRequest.parse(input);
  if (
    bound.runtime.environmentId !== request.environmentId ||
    bound.context.environmentId !== request.environmentId ||
    bound.context.operationId !== request.operationId ||
    bound.context.epoch !== request.epoch ||
    bound.context.purpose !== request.purpose
  )
    throw new Error('Wrong recovery environment or operation');
  return Receipt.parse(
    await validateAndResumeRecovery({
      ...bound,
      sourceDigest: request.sourceDigest,
      configurationDigest: request.configurationDigest,
    }),
  );
}

export async function runRecoveryResume(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help')
    return {
      scope: 'trusted-offline-operator',
      deploymentAllowed: false,
      usage:
        'npm run recovery:resume -- --request /private/request.json --adapter /private/bindings.mjs --receipt /private/new-receipt.json',
      note: 'The trusted adapter exports withRecoveryResume(request, execute) inside an explicitly fenced executor. It binds the exact OfflineContext, a ProtectedBackupInventory, the BACKUP_INVENTORY bucket and the independent validator Ed25519 private key; that key is never an application binding. The command inventories key references, signs fresh RecoveryValidation evidence, completes and resumes the operation. Generation stays off; any failure leaves the environment offline.',
    };
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i],
      value = argv[i + 1];
    if (
      !flag ||
      !['--request', '--adapter', '--receipt'].includes(flag) ||
      !value ||
      !isAbsolute(value) ||
      flags.has(flag)
    )
      throw new Error('Explicit absolute operator paths required');
    flags.set(flag, value);
  }
  if (flags.size !== 3) throw new Error('Explicit operator request, bindings and receipt required');
  const requestPath = flags.get('--request')!,
    adapterPath = flags.get('--adapter')!,
    receiptPath = flags.get('--receipt')!;
  if (
    !statSync(requestPath).isFile() ||
    statSync(requestPath).size > 16384 ||
    !statSync(adapterPath).isFile()
  )
    throw new Error('Invalid operator files');
  const request = RecoveryResumeRequest.parse(JSON.parse(readFileSync(requestPath, 'utf8')));
  const audit = {
    scope: 'trusted-offline-operator',
    environmentId: request.environmentId,
    operationId: request.operationId,
    epoch: request.epoch,
    purpose: request.purpose,
    sourceDigest: request.sourceDigest,
    configurationDigest: request.configurationDigest,
    startedAt: new Date().toISOString(),
    deploymentAllowed: false,
  };
  const fd = openSync(receiptPath, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ ...audit, status: 'started' }) + '\n');
    closeSync(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  try {
    const adapter = (await import(pathToFileURL(adapterPath).href)) as {
      withRecoveryResume?: (
        request: RecoveryResumeRequest,
        execute: (bound: {
          runtime: ApplicationRuntime;
          context: OfflineContext;
          backups: BackupInventory;
          bucket: R2Bucket;
          signingKey: CryptoKey;
        }) => Promise<RecoveryResumeReceipt>,
      ) => Promise<RecoveryResumeReceipt>;
    };
    if (typeof adapter.withRecoveryResume !== 'function')
      throw new Error('Trusted binding adapter required');
    let invoked = false,
      executed: RecoveryResumeReceipt | undefined;
    const result = Receipt.parse(
      await adapter.withRecoveryResume(request, async (bound) => {
        if (invoked) throw new Error('Run one explicit operator request');
        invoked = true;
        executed = await executeRecoveryResume(bound, request);
        return executed;
      }),
    );
    if (!executed || canonicalJson(result) !== canonicalJson(executed))
      throw new Error('Validated resumption did not produce this receipt');
    const receipt = {
      ...audit,
      status: 'complete',
      ...result,
      completedAt: new Date().toISOString(),
    };
    writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    return receipt;
  } catch {
    writeFileSync(
      receiptPath,
      JSON.stringify({
        ...audit,
        status: 'failed',
        requiresOffline: true,
        offlineVerified: false,
      }) + '\n',
      { mode: 0o600 },
    );
    throw new Error('Recovery resumption failed; keep the environment offline and inspect it');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runRecoveryResume(process.argv.slice(2))));
  } catch {
    console.error(
      'Recovery resumption could not complete. Private inputs were not displayed; keep the target offline.',
    );
    process.exitCode = 1;
  }
}
