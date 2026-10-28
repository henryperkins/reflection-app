import { canonicalJson } from '../src/domain/json.ts';
import { readFileSync, statSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { AccountRekey, RekeyReceipt } from '../src/worker/recovery/account-rekey.ts';

const common = {
  version: z.literal(1),
  environmentId: z.string().regex(/^[\w-]{1,64}$/),
  ownerId: z.uuid(),
  expectedVersion: z.number().int().positive(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  configurationDigest: z.string().regex(/^[a-f0-9]{64}$/),
};
export const AccountRekeyRequest = z.discriminatedUnion('action', [
  z.strictObject({ ...common, action: z.literal('begin') }),
  z.strictObject({ ...common, action: z.literal('resume'), operationId: z.uuid() }),
]);
export type AccountRekeyRequest = z.infer<typeof AccountRekeyRequest>;
const Receipt = z.strictObject({
  operationId: z.uuid(),
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
  fields: z.number().int().nonnegative(),
  registryHash: z.string().regex(/^[a-f0-9]{64}$/),
  inventoryHash: z.string().regex(/^[a-f0-9]{64}$/),
  stillOffline: z.literal(true),
});

/** Called inside a trusted binding-bearing executor; there is no public mutation route. */
export async function executeAccountRekey(
  service: AccountRekey,
  input: unknown,
): Promise<RekeyReceipt> {
  const request = AccountRekeyRequest.parse(input);
  if (
    service.base.identity.crypt.secrets.environment !== request.environmentId ||
    service.coordinator.environmentId !== request.environmentId
  )
    throw new Error('Wrong operator environment');
  const operationId =
    request.action === 'begin'
      ? (await service.begin(request.ownerId, request.expectedVersion)).operationId
      : request.operationId;
  await service.assertTarget(operationId, request.ownerId, request.expectedVersion);
  // Each step is <=20 fields. Stop before a lease can silently age out; progress remains durable.
  const deadline = Date.now() + 13 * 60_000;
  for (;;) {
    if (Date.now() >= deadline) throw new Error('Replacement remains offline; resume explicitly');
    if ((await service.step(operationId, 20)).phase === 'complete')
      return Receipt.parse(await service.validate(operationId));
  }
}
export async function runAccountRekey(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help')
    return {
      scope: 'trusted-offline-operator',
      deploymentAllowed: false,
      usage:
        'npm run key:rotate-account -- --request /private/request.json --adapter /private/bindings.mjs --receipt /private/new-receipt.json',
      note: 'The trusted adapter exports withAccountRekey(request, execute) inside an explicitly fenced local or hosted executor. P3/P4 bind source/configuration identities and restrict hosted targets. No production bindings are inferred. Requests contain private operational identity; keep them outside public evidence. Completion leaves ingress and generation off.',
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
  const request = AccountRekeyRequest.parse(JSON.parse(readFileSync(requestPath, 'utf8')));
  const audit = {
    scope: 'trusted-offline-operator',
    environmentId: request.environmentId,
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
      withAccountRekey?: (
        request: AccountRekeyRequest,
        execute: (service: AccountRekey) => Promise<RekeyReceipt>,
      ) => Promise<RekeyReceipt>;
    };
    if (typeof adapter.withAccountRekey !== 'function')
      throw new Error('Trusted binding adapter required');
    let invoked = false,
      executed: RekeyReceipt | undefined;
    const result = Receipt.parse(
      await adapter.withAccountRekey(request, async (service) => {
        if (invoked) throw new Error('Run one explicit operator request');
        invoked = true;
        executed = await executeAccountRekey(service, request);
        return executed;
      }),
    );
    if (!executed || canonicalJson(result) !== canonicalJson(executed))
      throw new Error('Fenced operation did not produce this receipt');
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
    throw new Error('Account replacement failed; retain keys and inspect protected progress');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runAccountRekey(process.argv.slice(2))));
  } catch {
    console.error(
      'Account replacement could not complete. Private inputs were not displayed; retain both key versions and keep the target offline.',
    );
    process.exitCode = 1;
  }
}
