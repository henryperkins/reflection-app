import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { canonicalJson } from '../src/domain/json.ts';
import {
  renderHostedConfig,
  validateRuntimeManifest,
  type RuntimeManifest,
} from '../src/worker/runtime/config.ts';
import { sourceDigest } from './verification-state.ts';
import { assertNoLocalSecrets, verificationEnvironment } from './verification-environment.ts';
import { verificationStageNames } from './verify.ts';
import { projectRoot } from './schemas.ts';

const hash = z.string().regex(/^[a-f0-9]{64}$/),
  sha = z.string().regex(/^[a-f0-9]{40}$/),
  account = z.string().regex(/^[a-f0-9]{32}$/);
const Target = z.strictObject({
  version: z.literal(1),
  accountId: account,
  isolatedAccounts: z
    .array(z.strictObject({ environmentId: z.string().min(1).max(64), accountId: account }))
    .min(1)
    .max(32),
  runtime: z.unknown(),
});
export type HostedTarget = Omit<z.infer<typeof Target>, 'runtime'> & { runtime: RuntimeManifest };
export function validateHostedTarget(input: unknown): HostedTarget {
  const value = Target.parse(input),
    runtime = validateRuntimeManifest(value.runtime);
  if (
    runtime.mode === 'synthetic-local' ||
    value.isolatedAccounts.some((peer) => peer.accountId === value.accountId) ||
    new Set(value.isolatedAccounts.map((peer) => peer.environmentId)).size !==
      value.isolatedAccounts.length ||
    runtime.isolatedFrom.some(
      (peer) => !value.isolatedAccounts.some((a) => a.environmentId === peer.environmentId),
    )
  )
    throw new Error('Distinct hosted accounts and exact peers required');
  return { ...value, runtime };
}
export function hostedConfiguration(input: unknown) {
  const target = validateHostedTarget(input),
    config = renderHostedConfig(target.runtime);
  return {
    ...config,
    account_id: target.accountId,
    main: './worker/application.js',
    assets: { ...config.assets, directory: './client' },
    d1_databases: config.d1_databases.map((database) => ({
      ...database,
      migrations_dir: './migrations',
    })),
  };
}
export function hostedConfigurationDigest(target: unknown) {
  return createHash('sha256')
    .update(canonicalJson(hostedConfiguration(target)))
    .digest('hex');
}
const Verification = z.object({
  version: z.literal(1),
  status: z.literal('passed'),
  sourceDigest: hash,
  node: z.string().regex(/^v26\./),
  finishedAt: z.iso.datetime(),
  durationMs: z.number().positive().max(540000),
  deadlineMs: z.literal(540000),
  stages: z
    .array(
      z.strictObject({
        name: z.string(),
        status: z.literal('passed'),
        durationMs: z.number().nonnegative(),
      }),
    )
    .length(14),
  scope: z.literal('synthetic-local-only'),
  hostedQualification: z.literal('not-run'),
});
export function checkHostedCandidate(input: {
  trustedBranch: string;
  commit: string;
  applicationDigest: string;
  environmentManifest: RuntimeManifest;
  target: unknown;
  verification: unknown;
  artifactDigest: string;
  expectedArtifactDigest: string;
  configurationDigest: string;
}) {
  const target = validateHostedTarget(input.target),
    verification = Verification.parse(input.verification);
  sha.parse(input.commit);
  hash.parse(input.applicationDigest);
  if (
    canonicalJson(target.runtime) !==
      canonicalJson(validateRuntimeManifest(input.environmentManifest)) ||
    verification.sourceDigest !== input.applicationDigest ||
    input.artifactDigest !== hash.parse(input.expectedArtifactDigest) ||
    !hash.safeParse(input.artifactDigest).success ||
    input.configurationDigest !== hostedConfigurationDigest(target) ||
    Date.parse(verification.finishedAt) > Date.now() + 60000 ||
    Date.now() - Date.parse(verification.finishedAt) > 86400000 ||
    canonicalJson(verification.stages.map((s) => s.name)) !== canonicalJson(verificationStageNames)
  )
    throw new Error('Hosted artifact, configuration or verification mismatch');
  if (target.runtime.mode === 'production' && input.trustedBranch !== 'main')
    throw new Error('Production staging requires main');
  return {
    commit: input.commit,
    configurationDigest: input.configurationDigest,
    syntheticQualificationAllowed: target.runtime.mode === 'hosted-synthetic',
    productionStagingAllowed: false as const,
    productionActivationAllowed: false as const,
    scope: 'local-gate-only' as const,
  };
}
export function verifyWorkersBuildContext(
  input: unknown,
  expected: { buildId: string; commit: string; branch: string; mode: RuntimeManifest['mode'] },
) {
  const value = z
    .object({
      build_uuid: z.uuid(),
      status: z.literal('running'),
      build_trigger_metadata: z.object({
        branch: z.string(),
        commit_hash: sha,
        build_command: z.literal('npm run hosted:build'),
        deploy_command: z.string(),
      }),
      trigger: z.object({ branch_includes: z.array(z.string()) }),
    })
    .parse(input);
  const metadata = value.build_trigger_metadata;
  if (
    value.build_uuid !== expected.buildId ||
    metadata.commit_hash !== expected.commit ||
    metadata.branch !== expected.branch ||
    metadata.deploy_command !== 'npm run hosted:stage-synthetic' ||
    (expected.mode === 'production' && metadata.branch !== 'main')
  )
    throw new Error('Authenticated build identity mismatch');
  // This command intentionally has no production deploy path.
  if (expected.mode === 'production')
    throw new Error('Production deployment requires a separate launch executor');
  return { buildId: value.build_uuid, commit: metadata.commit_hash, branch: metadata.branch };
}
export function hostedArtifactDigest(root: string) {
  const digest = createHash('sha256');
  let count = 0;
  function visit(path: string) {
    for (const name of readdirSync(resolve(root, path)).sort()) {
      if (path === '' && name === 'candidate.json') continue;
      const file = join(path, name),
        stat = lstatSync(resolve(root, file));
      if (stat.isSymbolicLink()) throw new Error('Artifact symlinks forbidden');
      if (stat.isDirectory()) visit(file);
      else if (stat.isFile()) {
        if (++count > 10000 || stat.size > 64 * 1024 * 1024)
          throw new Error('Hosted artifact bounds exceeded');
        digest
          .update(file)
          .update('\0')
          .update(readFileSync(resolve(root, file)))
          .update('\0');
      } else throw new Error('Unexpected artifact entry');
    }
  }
  visit('');
  return digest.digest('hex');
}
function command(args: string[], env = verificationEnvironment(process.env)) {
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Controlled build command failed');
}
function gitHead() {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: projectRoot, encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Git identity unavailable');
  return sha.parse(result.stdout.trim());
}
async function authenticatedBuild(target: HostedTarget) {
  if (
    process.env.WORKERS_CI !== '1' ||
    process.env.CLOUDFLARE_ACCOUNT_ID !== target.accountId ||
    !process.env.CLOUDFLARE_API_TOKEN
  )
    throw new Error('Protected Workers Builds context required');
  const buildId = z.uuid().parse(process.env.WORKERS_CI_BUILD_UUID),
    commit = gitHead(),
    branch = z.string().min(1).parse(process.env.WORKERS_CI_BRANCH);
  if (commit !== process.env.WORKERS_CI_COMMIT_SHA) throw new Error('Build checkout mismatch');
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/builds/builds/${buildId}`,
    {
      headers: { Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN },
      signal: AbortSignal.timeout(10000),
    },
  );
  if (!response.ok) throw new Error('Authenticated build metadata unavailable');
  const payload = (await response.json()) as { success?: boolean; result?: unknown };
  if (payload.success === false) throw new Error('Build metadata unavailable');
  return verifyWorkersBuildContext(payload.result ?? payload, {
    buildId,
    commit,
    branch,
    mode: target.runtime.mode,
  });
}
export async function prepareHostedArtifact(
  target: HostedTarget,
  context: { commit: string; branch: string; buildId: string },
  output: string,
) {
  assertNoLocalSecrets(projectRoot);
  const verification = Verification.parse(
      JSON.parse(readFileSync(resolve(projectRoot, 'artifacts/verify.json'), 'utf8')),
    ),
    source = sourceDigest(projectRoot);
  if (source !== verification.sourceDigest || gitHead() !== context.commit || existsSync(output))
    throw new Error('Current verified source and new artifact directory required');
  mkdirSync(output, { recursive: true });
  cpSync(resolve(projectRoot, 'dist/client'), resolve(output, 'client'), { recursive: true });
  cpSync(resolve(projectRoot, 'src/worker/db/migrations'), resolve(output, 'migrations'), {
    recursive: true,
  });
  const config = hostedConfiguration(target),
    buildConfig = {
      ...config,
      main: relative(output, resolve(projectRoot, 'src/worker/runtime/application.ts')),
    };
  writeFileSync(resolve(output, 'build.json'), JSON.stringify(buildConfig));
  command([
    'node_modules/wrangler/bin/wrangler.js',
    'deploy',
    '--dry-run',
    '--config',
    resolve(output, 'build.json'),
    '--env-file',
    resolve(projectRoot, 'scripts/verification.env'),
    '--outdir',
    resolve(output, 'worker'),
  ]);
  // Keep the final deploy input distinct from the temporary source-bundle input.
  const { unlinkSync } = await import('node:fs');
  unlinkSync(resolve(output, 'build.json'));
  writeFileSync(resolve(output, 'wrangler.json'), JSON.stringify(config, null, 2) + '\n');
  const artifactDigest = hostedArtifactDigest(output),
    configurationDigest = hostedConfigurationDigest(target),
    check = checkHostedCandidate({
      trustedBranch: context.branch,
      commit: context.commit,
      applicationDigest: source,
      environmentManifest: target.runtime,
      target,
      verification,
      artifactDigest,
      expectedArtifactDigest: artifactDigest,
      configurationDigest,
    });
  const candidate = {
    version: 1,
    context,
    target,
    verification,
    sourceDigest: source,
    artifactDigest,
    configurationDigest,
    check,
  };
  writeFileSync(resolve(output, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n');
  return candidate;
}
export async function runHostedRelease(argv: string[]) {
  if (argv.length === 1 && argv[0] === '--help')
    return { modes: ['--build', '--stage-synthetic'], productionActivationAllowed: false };
  if (argv.length !== 1 || !['--build', '--stage-synthetic'].includes(argv[0]!))
    throw new Error('Use a controlled build command');
  const target = validateHostedTarget(
      JSON.parse(process.env.REFLECTION_HOSTED_TARGET_JSON ?? 'null'),
    ),
    context = await authenticatedBuild(target),
    output = resolve(projectRoot, 'artifacts/hosted');
  if (argv[0] === '--build') {
    command(['node_modules/@playwright/test/cli.js', 'install', '--with-deps', 'chromium']);
    command(['--import', 'tsx', 'scripts/verify.ts']);
    return prepareHostedArtifact(target, context, output);
  }
  const candidate = JSON.parse(readFileSync(resolve(output, 'candidate.json'), 'utf8')) as Awaited<
    ReturnType<typeof prepareHostedArtifact>
  >;
  const artifactDigest = hostedArtifactDigest(output);
  const check = checkHostedCandidate({
    trustedBranch: context.branch,
    commit: context.commit,
    applicationDigest: sourceDigest(projectRoot),
    environmentManifest: target.runtime,
    target,
    verification: candidate.verification,
    artifactDigest,
    expectedArtifactDigest: candidate.artifactDigest,
    configurationDigest: candidate.configurationDigest,
  });
  if (
    !check.syntheticQualificationAllowed ||
    candidate.context.commit !== context.commit ||
    canonicalJson(candidate.target) !== canonicalJson(target) ||
    createHash('sha256')
      .update(canonicalJson(JSON.parse(readFileSync(resolve(output, 'wrangler.json'), 'utf8'))))
      .digest('hex') !== candidate.configurationDigest
  )
    throw new Error('Synthetic deployment not authorized');
  command(
    [
      'node_modules/wrangler/bin/wrangler.js',
      'deploy',
      '--no-bundle',
      '--config',
      resolve(output, 'wrangler.json'),
    ],
    process.env,
  );
  return { ...check, scope: 'hosted-synthetic-deploy', buildId: context.buildId };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await runHostedRelease(process.argv.slice(2))));
  } catch {
    console.error(
      'Hosted release stopped. Verification, target isolation and authenticated build context are required.',
    );
    process.exitCode = 1;
  }
}
