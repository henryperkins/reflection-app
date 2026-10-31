import { createWorker, type Env } from './index.ts';
import { localDevelopmentBundle } from './readings/local-content.ts';
import { type ContentRepository, type ContentRow, contentSnapshot } from './content/repository.ts';
import {
  LOCAL_LIVE_READING_POLICY as policy,
  READING_V2_EDITORIAL_EVALUATION_POLICY,
} from '../contracts/provider-policy.ts';
import { providerPolicyHash } from '../domain/provider-policy.ts';
import { canonicalJson } from '../domain/json.ts';
import { OpenAIResponsesTransport } from './provider/transport.ts';
import { MetaSpreadRecognizer } from './provider/meta-vision.ts';
import { onlineGuard } from './identity/checkpoint.ts';
import { DB_NOW } from './db/core.ts';
import type { RecordBase } from './readings/base.ts';
import type { GenerationDependencies } from './readings/generation.ts';

export interface LocalLiveEnv extends Env {
  OPENAI_API_KEY?: string;
  OPENAI_PROJECT_ID?: string;
  MODEL_API_KEY?: string;
}

type DevelopmentMode = 'live-local' | 'live-preview';
function localConfiguration(env: LocalLiveEnv, mode: DevelopmentMode) {
  const origin = new URL(env.IDENTITY_ORIGIN ?? 'https://unconfigured.invalid');
  if (
    env.READING_MODE !== mode ||
    env.IDENTITY_MODE !== mode ||
    (mode === 'live-local'
      ? origin.hostname !== 'localhost'
      : origin.protocol !== 'https:' || origin.hostname === 'localhost') ||
    origin.origin !== env.IDENTITY_ORIGIN ||
    !['http:', 'https:'].includes(origin.protocol)
  )
    throw new Error('Local live configuration unavailable');
}

/** Local development activation only: preserve draft metadata and existing stop switches. */
async function install(db: D1Database) {
  const bundle = localDevelopmentBundle();
  await db.batch([
    onlineGuard(db),
    db
      .prepare(`INSERT OR IGNORE INTO content_editions
      (hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at)
      VALUES (?,'staged',?,NULL,'agent_reviewed',NULL,'unknown',${DB_NOW})`)
      .bind(bundle.editionHash, canonicalJson(bundle)),
    db
      .prepare(`INSERT OR IGNORE INTO system_state
      (id,active_content_hash,generation_enabled,dispatch_mode,provider_policy_hash,updated_at)
      VALUES (1,?,1,'model',?,${DB_NOW})`)
      .bind(bundle.editionHash, await providerPolicyHash(policy)),
    // Upgrade the known development bootstrap without changing saved records or stop switches.
    db
      .prepare(`UPDATE system_state SET provider_policy_hash=?,revision=revision+1,updated_at=${DB_NOW}
      WHERE id=1 AND active_content_hash=? AND provider_policy_hash=?
      AND NOT EXISTS(SELECT 1 FROM generation_requests WHERE state NOT IN ('published','blocked','failed','expired','cancelled'))`)
      .bind(
        await providerPolicyHash(policy),
        bundle.editionHash,
        await providerPolicyHash(READING_V2_EDITORIAL_EVALUATION_POLICY),
      ),
  ]);
}

class DevelopmentContent implements ContentRepository {
  constructor(private readonly db: D1Database) {}
  async active() {
    return (await this.forGeneration()).bundle;
  }
  async byHash(hash: string) {
    return (await this.forGeneration(hash)).bundle;
  }
  async forGeneration(hash?: string) {
    const bundle = localDevelopmentBundle();
    const row = await this.db
      .prepare(
        'SELECT c.* FROM content_editions c JOIN system_state s ON s.active_content_hash=c.hash WHERE s.id=1',
      )
      .first<ContentRow>();
    if (
      !row ||
      (hash !== undefined && hash !== bundle.editionHash) ||
      row.hash !== bundle.editionHash ||
      row.state !== 'staged' ||
      row.reviewer_kind !== 'agent_reviewed' ||
      row.rights_status !== 'unknown' ||
      row.approval_json !== null ||
      row.bundle_json !== canonicalJson(bundle)
    )
      throw new Error('CONTENT_UNAVAILABLE');
    return contentSnapshot(this.db, row, bundle, true);
  }
}

function dependencies(
  base: RecordBase,
  env: LocalLiveEnv,
  fetcher: typeof fetch,
  mode: DevelopmentMode,
): GenerationDependencies {
  const ensureReady = async () => {
    localConfiguration(env, mode);
    if (!env.OPENAI_API_KEY?.trim() || !/^proj_[\w-]+$/.test(env.OPENAI_PROJECT_ID ?? ''))
      throw new Error('Provider unavailable');
  };
  return {
    policy,
    content: new DevelopmentContent(base.db),
    authorization: { kind: mode },
    ensureReady,
    ...(env.MODEL_API_KEY?.trim()
      ? {
          spreadRecognizer: new MetaSpreadRecognizer({
            apiKey: env.MODEL_API_KEY,
            fetch: fetcher,
          }),
        }
      : {}),
    writer: {
      async write(input) {
        await ensureReady();
        return new OpenAIResponsesTransport({
          policy,
          apiKey: env.OPENAI_API_KEY!,
          fetch: (url, init) => {
            const headers = new Headers(init?.headers);
            headers.set('OpenAI-Project', env.OPENAI_PROJECT_ID!);
            return fetcher(url, { ...init, headers });
          },
        }).write(input);
      },
    },
  };
}

/** Separate entry point: the default Worker and synthetic test command cannot enable egress. */
function createDevelopmentWorker(mode: DevelopmentMode, fetcher: typeof fetch) {
  return {
    async fetch(request: Request, env: LocalLiveEnv, ctx?: ExecutionContext) {
      try {
        localConfiguration(env, mode);
        if (new URL(request.url).origin !== env.IDENTITY_ORIGIN)
          return new Response('Local origin required', { status: 403 });
        await install(env.DB);
      } catch {
        return Response.json({ error: 'Local live app unavailable' }, { status: 503 });
      }
      // Hosted fast/xhigh can exceed the post-response waitUntil lifetime. Keep
      // Start's HTTP request open until completion; durable recovery still applies.
      return createWorker((base) => dependencies(base, env, fetcher, mode)).fetch(
        request,
        env,
        mode === 'live-preview' ? undefined : ctx,
      );
    },
    async scheduled(controller: ScheduledController, env: LocalLiveEnv, ctx: ExecutionContext) {
      localConfiguration(env, mode);
      await install(env.DB);
      return createWorker((base) => dependencies(base, env, fetcher, mode)).scheduled(
        controller,
        env,
        ctx,
      );
    },
  };
}
export function createLocalLiveWorker(fetcher: typeof fetch = fetch) {
  return createDevelopmentWorker('live-local', fetcher);
}
export function createHostedPreviewWorker(fetcher: typeof fetch = fetch) {
  return createDevelopmentWorker('live-preview', fetcher);
}
export default createLocalLiveWorker();
