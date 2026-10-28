import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { canonicalJson } from '../src/domain/json.ts';
import { RuntimeResources } from '../src/worker/runtime/config.ts';
import { checkHostedCandidate, validateHostedTarget } from './hosted-release.ts';

export const scenarioAssertions = {
  'batch-rollback': ['ROLLBACK_READING', 'ROLLBACK_EVIDENCE', 'ROLLBACK_QUOTA', 'ROLLBACK_EVENTS'],
  'request-races': [
    'ONE_PUBLICATION',
    'ONE_DISPATCH',
    'REVOKED_BLOCKED',
    'CANCELLED_BLOCKED',
    'DELETED_BLOCKED',
    'KEY_CHANGE_BLOCKED',
    'EXPIRED_BLOCKED',
    'QUOTA_COMPENSATED',
  ],
  'scheduler-crash': [
    'OVERLAP_SAFE',
    'MISSED_WAKE_RECOVERED',
    'BEFORE_DISPATCH_RECOVERED',
    'AUTHORIZED_NO_REDISPATCH',
    'RESPONSE_NO_REDISPATCH',
    'CANDIDATE_RECOVERED',
    'EXTERNAL_COUNTER_MATCH',
  ],
  'stale-restore': [
    'INGRESS_CLOSED',
    'EGRESS_CLOSED',
    'MARKER_ABSENT',
    'FACTOR_REJECTED',
    'CODE_REJECTED',
    'CONSENT_OFF',
    'NO_REDISPATCH',
    'SPEND_PRESERVED',
    'RECEIPT_VALID',
  ],
  'recovery-loss': [
    'ABSENT_OBJECT_CLOSED',
    'CORRUPT_OBJECT_CLOSED',
    'PARTIAL_LIST_CLOSED',
    'MISSING_KEY_CLOSED',
    'MISSING_INVENTORY_CLOSED',
    'REPEATED_RESTORE_SAFE',
    'RETENTION_PRESERVED',
  ],
  'key-lifecycle': [
    'WRAP_ROTATED',
    'DEK_REPLACED',
    'CHECKPOINT_ROLLED',
    'INTERRUPTED_RESUMED',
    'REFERENCED_RETIREMENT_REJECTED',
    'UNUSED_RETIRED',
    'EXACT_CONTENT',
    'KIT_IDENTITY',
    'RECEIPT_VALID',
  ],
} as const;
export const HostedScenario = z.enum(
  Object.keys(scenarioAssertions) as [
    keyof typeof scenarioAssertions,
    ...(keyof typeof scenarioAssertions)[],
  ],
);
export type HostedScenario = z.infer<typeof HostedScenario>;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const Authorization = z.strictObject({
  version: z.literal(1),
  accountId: z.string().regex(/^[a-f0-9]{32}$/),
  environmentId: z.string().min(1).max(64),
  applicationDigest: hash,
  configurationDigest: hash,
  artifactDigest: hash,
  expiresAt: z.iso.datetime(),
  allowedScenarios: z.array(HostedScenario).min(1).max(6),
  acceptedRpoMs: z.number().int().nonnegative().max(604800000),
  acceptedRtoMs: z.number().int().positive().max(604800000),
});
const Snapshot = z.strictObject({
  accountId: z.string(),
  environmentId: z.string(),
  resources: RuntimeResources,
  applicationDigest: hash,
  configurationDigest: hash,
  artifactDigest: hash,
  provider: z.literal('intercepted-counter'),
  productionCredentialsPresent: z.literal(false),
});
const Observation = z.strictObject({
  version: z.literal(1),
  scope: z.literal('hosted-synthetic'),
  scenario: HostedScenario,
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  assertions: z
    .array(
      z.strictObject({
        code: z
          .string()
          .regex(/^[A-Z_]+$/)
          .max(80),
        passed: z.literal(true),
        evidenceSha256: hash,
      }),
    )
    .min(1)
    .max(32),
  limitations: z
    .array(
      z.enum([
        'SYNTHETIC_PROVIDER_ONLY',
        'TIME_TRAVEL_WINDOW_ONLY',
        'EXPORTED_COPIES_UNTESTED',
        'PHYSICAL_SECRET_CUSTODY_UNTESTED',
      ]),
    )
    .min(1)
    .max(4),
  measuredRpoMs: z.number().int().nonnegative().nullable(),
  measuredRtoMs: z.number().int().nonnegative().nullable(),
  backupClasses: z
    .array(z.enum(['d1-time-travel', 'recovery-objects', 'secret-copy', 'exported-offline']))
    .max(4),
});
export interface HostedQualificationAdapter {
  /** Authenticated account/deployment inspection; never infer identity from a caller URL. */
  inspect(): Promise<unknown>;
  /** Runs the application's actual scenario and captures protected query/counter proofs. */
  run(scenario: HostedScenario): Promise<unknown>;
  /** Read the captured proof bytes from separately protected operator storage. */
  readEvidence(sha256: string): Promise<Uint8Array>;
}
export interface VerifiedHostedTarget {
  readonly environmentId: string;
}
type Grant = {
  authorization: z.infer<typeof Authorization>;
  snapshot: z.infer<typeof Snapshot>;
  adapter: HostedQualificationAdapter;
  createdAt: number;
};
const grants = new WeakMap<VerifiedHostedTarget, Grant>();
function current(grant: Grant) {
  if (Date.parse(grant.authorization.expiresAt) <= Date.now())
    throw new Error('Operator authorization expired');
}
/** Authorization is protected operator configuration, never an HTTP request or a qualification result. */
export async function authorizeHostedTarget(
  candidateInput: unknown,
  authorizationInput: unknown,
  adapter: HostedQualificationAdapter,
): Promise<VerifiedHostedTarget> {
  const candidate = z
    .object({
      target: z.unknown(),
      sourceDigest: hash,
      configurationDigest: hash,
      artifactDigest: hash,
      context: z.object({ commit: z.string(), branch: z.string() }),
      verification: z.unknown(),
    })
    .parse(candidateInput);
  const target = validateHostedTarget(candidate.target),
    authorization = Authorization.parse(authorizationInput);
  if (
    target.runtime.mode !== 'hosted-synthetic' ||
    new Set(authorization.allowedScenarios).size !== authorization.allowedScenarios.length ||
    Date.parse(authorization.expiresAt) > Date.now() + 86400000
  )
    throw new Error('Only explicitly authorized synthetic targets are supported');
  checkHostedCandidate({
    trustedBranch: candidate.context.branch,
    commit: candidate.context.commit,
    applicationDigest: candidate.sourceDigest,
    environmentManifest: target.runtime,
    target,
    verification: candidate.verification,
    artifactDigest: candidate.artifactDigest,
    expectedArtifactDigest: authorization.artifactDigest,
    configurationDigest: candidate.configurationDigest,
  });
  const expected = Snapshot.parse({
    accountId: target.accountId,
    environmentId: target.runtime.environmentId,
    resources: target.runtime.resources,
    applicationDigest: candidate.sourceDigest,
    configurationDigest: candidate.configurationDigest,
    artifactDigest: candidate.artifactDigest,
    provider: 'intercepted-counter',
    productionCredentialsPresent: false,
  });
  for (const field of [
    'accountId',
    'environmentId',
    'applicationDigest',
    'configurationDigest',
    'artifactDigest',
  ] as const)
    if (authorization[field] !== expected[field])
      throw new Error('Protected target allowlist mismatch');
  const grant = { authorization, snapshot: expected, adapter, createdAt: Date.now() };
  current(grant);
  if (canonicalJson(Snapshot.parse(await adapter.inspect())) !== canonicalJson(expected))
    throw new Error('Observed hosted identity mismatch');
  const verified = Object.freeze({ environmentId: expected.environmentId });
  grants.set(verified, grant);
  return verified;
}
export async function runHostedQualification(
  target: VerifiedHostedTarget,
  scenarioInput: HostedScenario,
) {
  const grant = grants.get(target),
    scenario = HostedScenario.parse(scenarioInput);
  if (!grant || !grant.authorization.allowedScenarios.includes(scenario))
    throw new Error('Explicit scenario authorization required');
  current(grant);
  if (
    canonicalJson(Snapshot.parse(await grant.adapter.inspect())) !== canonicalJson(grant.snapshot)
  )
    throw new Error('Hosted target drifted');
  const observed = Observation.parse(await grant.adapter.run(scenario)),
    codes = scenarioAssertions[scenario];
  if (
    observed.scenario !== scenario ||
    observed.assertions.length !== codes.length ||
    new Set(observed.assertions.map((a) => a.code)).size !== codes.length ||
    !codes.every((code) => observed.assertions.some((a) => a.code === code)) ||
    !observed.limitations.includes('SYNTHETIC_PROVIDER_ONLY') ||
    Date.parse(observed.startedAt) < grant.createdAt - 60000 ||
    Date.parse(observed.finishedAt) < Date.parse(observed.startedAt) ||
    Date.parse(observed.finishedAt) > Date.now() + 60000
  )
    throw new Error('Incomplete or stale hosted observations');
  if (
    ['stale-restore', 'key-lifecycle'].includes(scenario) &&
    (observed.measuredRpoMs === null ||
      observed.measuredRtoMs === null ||
      observed.measuredRpoMs > grant.authorization.acceptedRpoMs ||
      observed.measuredRtoMs > grant.authorization.acceptedRtoMs ||
      !['d1-time-travel', 'recovery-objects', 'secret-copy'].every((kind) =>
        observed.backupClasses.includes(kind as (typeof observed.backupClasses)[number]),
      ))
  )
    throw new Error('Recovery targets or supported backup classes not demonstrated');
  for (const digest of new Set(observed.assertions.map((a) => a.evidenceSha256))) {
    const bytes = await grant.adapter.readEvidence(digest);
    if (
      !(bytes instanceof Uint8Array) ||
      !bytes.length ||
      bytes.length > 4 * 1024 * 1024 ||
      createHash('sha256').update(bytes).digest('hex') !== digest
    )
      throw new Error('Protected observation bytes mismatch');
  }
  current(grant);
  if (
    canonicalJson(Snapshot.parse(await grant.adapter.inspect())) !== canonicalJson(grant.snapshot)
  )
    throw new Error('Hosted target drifted during drill');
  return {
    version: 1,
    status: 'passed' as const,
    scope: 'hosted-synthetic' as const,
    evidenceAuthority: 'trusted-operator-adapter' as const,
    environmentId: grant.snapshot.environmentId,
    applicationDigest: grant.snapshot.applicationDigest,
    configurationDigest: grant.snapshot.configurationDigest,
    artifactDigest: grant.snapshot.artifactDigest,
    scenario,
    startedAt: observed.startedAt,
    finishedAt: observed.finishedAt,
    assertions: codes.map((code) => observed.assertions.find((a) => a.code === code)!),
    limitations: observed.limitations,
    measuredRpoMs: observed.measuredRpoMs,
    measuredRtoMs: observed.measuredRtoMs,
    backupClasses: observed.backupClasses,
    productionActivationAllowed: false as const,
  };
}
export async function runHostedOperator(
  argv: string[],
  allowed: readonly HostedScenario[] = HostedScenario.options,
) {
  if (argv.length === 1 && argv[0] === '--plan')
    return {
      status: 'prepared-not-executed',
      scenarios: allowed,
      assertions: scenarioAssertions,
      productionActivationAllowed: false,
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
      throw new Error('Explicit protected operator paths required');
    flags.set(flag, value);
  }
  if (flags.size !== 3) throw new Error('Request, adapter and new receipt required');
  const requestFile = flags.get('--request')!,
    adapterFile = flags.get('--adapter')!,
    receiptFile = flags.get('--receipt')!;
  if (
    !statSync(requestFile).isFile() ||
    statSync(requestFile).size > 128 * 1024 ||
    !statSync(adapterFile).isFile()
  )
    throw new Error('Invalid protected operator input');
  const request = z
    .strictObject({ candidate: z.unknown(), authorization: z.unknown(), scenario: HostedScenario })
    .parse(JSON.parse(readFileSync(requestFile, 'utf8')));
  if (!allowed.includes(request.scenario)) throw new Error('Unsupported scenario for this command');
  writeFileSync(
    receiptFile,
    JSON.stringify({
      status: 'started',
      scope: 'operator-harness',
      productionActivationAllowed: false,
    }) + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  try {
    const { hostedQualificationAdapter } = (await import(pathToFileURL(adapterFile).href)) as {
      hostedQualificationAdapter: HostedQualificationAdapter;
    };
    const target = await authorizeHostedTarget(
        request.candidate,
        request.authorization,
        hostedQualificationAdapter,
      ),
      receipt = await runHostedQualification(target, request.scenario);
    writeFileSync(receiptFile, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
    return receipt;
  } catch {
    writeFileSync(
      receiptFile,
      JSON.stringify({
        status: 'failed',
        scope: 'operator-harness',
        offlineVerified: false,
        productionActivationAllowed: false,
      }) + '\n',
      { mode: 0o600 },
    );
    throw new Error('Hosted drill failed; inspect protected executor state');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runHostedOperator(process.argv.slice(2))));
  } catch {
    console.error(
      'Hosted qualification stopped. Protected target authorization and complete observations are required.',
    );
    process.exitCode = 1;
  }
}
