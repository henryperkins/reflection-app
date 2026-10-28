import { HostedCoordinator, type OfflineControl } from '../recovery/hosted-coordinator.ts';
import { runMaintenance } from '../maintenance/driver.ts';
import { createWorker, type Env } from '../index.ts';
import { IdentityCrypto, parseIdentitySecrets, decode } from '../identity/crypto.ts';
import { IdentityService } from '../identity/service.ts';
import { RecordBase } from '../readings/base.ts';
import { ReadingGeneration, type GenerationDependencies } from '../readings/generation.ts';
import { LocalGeneration } from '../readings/local-generation.ts';
import { RuntimeResources, validateRuntimeManifest, type RuntimeManifest } from './config.ts';
import { canonicalJson } from '../../domain/json.ts';
import {
  READING_PROVIDER_POLICY,
  READING_V2_APPLICATION_POLICY,
} from '../../contracts/provider-policy.ts';
import { providerPolicyHash } from '../../domain/provider-policy.ts';
import { D1ContentRepository, type ContentRepository } from '../content/repository.ts';
import { authenticateProviderQualification } from '../provider/qualification.ts';
import { OpenAIWritingProvider } from '../provider/openai.ts';
import { z } from 'zod';

export interface RuntimeBindings extends Env {
  OFFLINE_COORDINATOR?: DurableObjectNamespace<OfflineControl>;
  RECOVERY_CONTROL_SECRET?: string;
  QUIESCENCE_TRUST?: string;
  BACKUP_INVENTORY?: R2Bucket;
  RUNTIME_MANIFEST?: string;
  RUNTIME_RESOURCE_IDENTITIES?: string;
  QUALIFICATION_ARTIFACTS?: R2Bucket;
  QUALIFICATION_TRUST?: string;
  OPENAI_API_KEY?: string;
  OPENAI_PROJECT_ID?: string;
}
export interface ApplicationRuntime {
  manifest: RuntimeManifest;
  environmentId: string;
  coordinator?: HostedCoordinator;
  identity: IdentityService;
  base: RecordBase;
  generation: ReadingGeneration;
  recoveryBucket: R2Bucket;
  health: {
    status: 'ok';
    mode: RuntimeManifest['mode'];
    generationReady: boolean;
    generation: RuntimeManifest['generation'];
    provider?: 'openai';
  };
}
const unavailableContent: ContentRepository = {
  async active() {
    throw new Error('CONTENT_UNAVAILABLE');
  },
  async byHash() {
    throw new Error('CONTENT_UNAVAILABLE');
  },
  async forGeneration() {
    throw new Error('CONTENT_UNAVAILABLE');
  },
};
const PublicKey = z.strictObject({
  alg: z.enum(['EdDSA', 'Ed25519']).optional(),
  kty: z.literal('OKP'),
  crv: z.literal('Ed25519'),
  x: z.string().regex(/^[\w-]{43}$/),
  ext: z.boolean().optional(),
  key_ops: z.array(z.literal('verify')).optional(),
});
const Trust = z.strictObject({
  providerPublicKey: PublicKey,
  providerReviewerId: z.string().min(1).max(200),
  contentPublicKey: PublicKey,
  contentReviewerId: z.string().min(1).max(200),
});
const Bytes = z
  .string()
  .regex(/^[\w-]+$/)
  .max(1_400_000);
const Artifacts = z.strictObject({
  signedQualification: z.unknown(),
  evaluationManifest: Bytes,
  evidence: z.strictObject({
    projectAccess: Bytes,
    retention: Bytes,
    editorial: Bytes,
    corpus: Bytes,
    tokenEstimator: Bytes,
    pricing: Bytes,
  }),
});

async function qualified(
  env: RuntimeBindings,
  manifest: RuntimeManifest,
  base: RecordBase,
  fetcher: typeof fetch,
): Promise<GenerationDependencies> {
  if (
    !env.OPENAI_API_KEY?.trim() ||
    !/^proj_[\w-]+$/.test(env.OPENAI_PROJECT_ID ?? '') ||
    !env.QUALIFICATION_ARTIFACTS ||
    !env.QUALIFICATION_TRUST ||
    !manifest.qualificationEvidenceDigest
  )
    throw new Error('Provider unavailable');
  if (env.QUALIFICATION_TRUST.length > 4096) throw new Error('Provider unavailable');
  const trust = Trust.parse(JSON.parse(env.QUALIFICATION_TRUST));
  const object = await env.QUALIFICATION_ARTIFACTS.get(
    'qualification/' + manifest.qualificationEvidenceDigest + '.json',
  );
  if (!object || object.size > 10_000_000) throw new Error('Provider unavailable');
  const bytes = await object.arrayBuffer();
  if (bytes.byteLength > 10_000_000) throw new Error('Provider unavailable');
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('');
  if (digest !== manifest.qualificationEvidenceDigest) throw new Error('Provider unavailable');
  const artifacts = Artifacts.parse(JSON.parse(new TextDecoder().decode(bytes)));
  const policy = (
    await Promise.all(
      [READING_PROVIDER_POLICY, READING_V2_APPLICATION_POLICY].map(async (candidate) => ({
        candidate,
        hash: await providerPolicyHash(candidate),
      })),
    )
  ).find((entry) => entry.hash === manifest.policyHash)?.candidate;
  if (!policy) throw new Error('Provider unavailable');
  const providerPublicKey = await crypto.subtle.importKey(
    'raw',
    decode(trust.providerPublicKey.x),
    'Ed25519',
    false,
    ['verify'],
  );
  const contentPublicKey = await crypto.subtle.importKey(
    'raw',
    decode(trust.contentPublicKey.x),
    'Ed25519',
    false,
    ['verify'],
  );
  const qualification = await authenticateProviderQualification(artifacts.signedQualification, {
    publicKey: providerPublicKey,
    projectId: env.OPENAI_PROJECT_ID!,
    environmentId: manifest.environmentId,
    reviewerId: trust.providerReviewerId,
    policyHash: manifest.policyHash,
    contentHash: manifest.contentHash,
    evaluationManifest: decode(artifacts.evaluationManifest),
    evidence: {
      projectAccess: decode(artifacts.evidence.projectAccess),
      retention: decode(artifacts.evidence.retention),
      editorial: decode(artifacts.evidence.editorial),
      corpus: decode(artifacts.evidence.corpus),
      tokenEstimator: decode(artifacts.evidence.tokenEstimator),
      pricing: decode(artifacts.evidence.pricing),
    },
    now: Date.now(),
  });
  const writer = new OpenAIWritingProvider({
    enabled: manifest.ingress === 'on',
    apiKey: env.OPENAI_API_KEY,
    policy,
    qualification,
    expectedPolicyHash: manifest.policyHash,
    expectedContentHash: manifest.contentHash,
    projectId: env.OPENAI_PROJECT_ID!,
    environmentId: manifest.environmentId,
    fetch: (url, options) => {
      const headers = new Headers(options?.headers);
      headers.set('OpenAI-Project', env.OPENAI_PROJECT_ID!);
      return fetcher(url, { ...options, headers });
    },
  });
  const content = new D1ContentRepository(base.db, {
    publicKey: contentPublicKey,
    reviewerId: trust.contentReviewerId,
    environmentId: manifest.environmentId,
  });
  const ensureReady = async () => {
    await writer.ensureReady();
    const active = await content.active();
    const state = await base.db
      .prepare(
        'SELECT generation_enabled,dispatch_mode,provider_policy_hash FROM system_state WHERE id=1',
      )
      .first<{ generation_enabled: number; dispatch_mode: string; provider_policy_hash: string }>();
    if (
      active.editionHash !== manifest.contentHash ||
      !state?.generation_enabled ||
      state.dispatch_mode !== 'model' ||
      state.provider_policy_hash !== manifest.policyHash
    )
      throw new Error('Provider unavailable');
  };
  await ensureReady();
  return {
    content,
    policy,
    writer,
    authorization: { kind: 'application', qualification },
    ensureReady,
  };
}

/** One bootstrap per invocation; no request-controlled configuration or process-local authority. */
export async function createRuntime(
  env: RuntimeBindings,
  fetcher: typeof fetch = fetch,
): Promise<ApplicationRuntime> {
  let manifest: RuntimeManifest, identity: IdentityService;
  try {
    if (
      !env.RUNTIME_MANIFEST ||
      env.RUNTIME_MANIFEST.length > 32_000 ||
      !env.RUNTIME_RESOURCE_IDENTITIES ||
      !env.IDENTITY_SECRETS ||
      !env.RECOVERY ||
      !env.DB
    )
      throw new Error();
    manifest = validateRuntimeManifest(JSON.parse(env.RUNTIME_MANIFEST));
    const resources = RuntimeResources.parse(JSON.parse(env.RUNTIME_RESOURCE_IDENTITIES));
    if (
      canonicalJson(resources) !== canonicalJson(manifest.resources) ||
      (env.IDENTITY_ORIGIN && env.IDENTITY_ORIGIN !== manifest.origin) ||
      (env.IDENTITY_MODE && env.IDENTITY_MODE !== manifest.mode) ||
      env.READING_MODE
    )
      throw new Error();
    const secrets = parseIdentitySecrets(env.IDENTITY_SECRETS);
    if (secrets.environment !== manifest.environmentId) throw new Error();
    if (manifest.mode !== 'synthetic-local') {
      const keys =
        'v' in secrets
          ? [
              ...secrets.keys,
              {
                hmacKey: secrets.identityHmacKey,
                wrapKey: secrets.identityHmacKey,
                recoveryKey: secrets.identityHmacKey,
              },
            ]
          : [secrets];
      for (const key of keys)
        for (const value of [key.wrapKey, key.recoveryKey, key.hmacKey])
          if (new Set(decode(value)).size < 2) throw new Error();
    }
    identity = new IdentityService(
      env.DB,
      env.RECOVERY,
      new IdentityCrypto(secrets),
      manifest.origin,
    );
  } catch {
    throw new Error('Runtime configuration unavailable');
  }
  let coordinator: HostedCoordinator | undefined;
  if (manifest.mode !== 'synthetic-local') {
    if (!env.OFFLINE_COORDINATOR || !env.RECOVERY_CONTROL_SECRET)
      throw new Error('Runtime configuration unavailable');
    coordinator = new HostedCoordinator(
      env.OFFLINE_COORDINATOR,
      env.RECOVERY_CONTROL_SECRET,
      manifest.environmentId,
    );
  }
  const base = new RecordBase(env.DB, identity);
  let generation: ReadingGeneration,
    generationReady = false;
  if (manifest.generation === 'intercepted' && manifest.ingress === 'on') {
    generation = new LocalGeneration(base);
    const state = await env.DB.prepare(
      'SELECT generation_enabled,dispatch_mode,restore_in_progress FROM system_state WHERE id=1',
    ).first<{ generation_enabled: number; dispatch_mode: string; restore_in_progress: number }>();
    generationReady =
      !state ||
      (state.generation_enabled === 1 &&
        state.restore_in_progress === 0 &&
        ['model', 'outage_template'].includes(state.dispatch_mode));
  } else {
    const disabled: GenerationDependencies = {
      policy: READING_V2_APPLICATION_POLICY,
      content: unavailableContent,
      writer: {
        async write() {
          return { kind: 'rejected', status: 503, receipt: null };
        },
      },
      authorization: { kind: 'disabled' },
      async ensureReady() {
        throw new Error('Provider unavailable');
      },
    };
    let dependencies: GenerationDependencies = disabled;
    if (manifest.generation === 'qualified' && manifest.ingress === 'on') {
      try {
        dependencies = await qualified(env, manifest, base, fetcher);
        generationReady = true;
      } catch {
        /* Provider/configuration failures do not disable owned records. */
      }
    }
    generation = new ReadingGeneration(base, dependencies);
  }
  return {
    manifest,
    environmentId: manifest.environmentId,
    ...(coordinator ? { coordinator } : {}),
    identity,
    base,
    generation,
    recoveryBucket: env.RECOVERY!,
    health: {
      status: 'ok',
      mode: manifest.mode,
      generation: manifest.generation,
      generationReady,
      ...(manifest.mode === 'production' && generationReady ? { provider: 'openai' as const } : {}),
    },
  };
}

export function createRuntimeWorker(fetcher: typeof fetch = fetch) {
  return {
    async fetch(request: Request, env: RuntimeBindings, ctx?: ExecutionContext) {
      try {
        const runtime = await createRuntime(env, fetcher);
        if (new URL(request.url).origin !== runtime.manifest.origin)
          return new Response('Origin required', { status: 403 });
        if (new URL(request.url).pathname.startsWith('/api/') && runtime.manifest.ingress === 'off')
          return Response.json({ error: 'Application admission is disabled' }, { status: 503 });
        if (new URL(request.url).pathname === '/health' && runtime.coordinator) {
          try {
            await runtime.coordinator.withWriter(async () => {});
          } catch {
            runtime.health.generationReady = false;
          }
        }
        const handle = async () => createWorker(undefined, runtime).fetch(request, env, ctx);
        return await (new URL(request.url).pathname.startsWith('/api/') && runtime.coordinator
          ? runtime.coordinator.withWriter(handle)
          : handle());
      } catch {
        return Response.json(
          { error: 'Application unavailable' },
          { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
        );
      }
    },
    async scheduled(
      _controller: ScheduledController,
      env: RuntimeBindings,
      _ctx: ExecutionContext,
    ) {
      try {
        const runtime = await createRuntime(env, fetcher);
        const work = () =>
          runMaintenance(runtime, {
            deadlineMs: Date.now() + runtime.generation.providerTimeoutMs + 30000,
            concurrency: 4,
          });
        const summary = await (runtime.coordinator ? runtime.coordinator.withWriter(work) : work());
        console.info(JSON.stringify(summary));
        return summary;
      } catch {
        console.error(JSON.stringify({ event: 'maintenance_failed' }));
        throw new Error('Scheduled maintenance failed');
      }
    },
  };
}
export default createRuntimeWorker();

export { OfflineControl } from '../recovery/hosted-coordinator.ts';
