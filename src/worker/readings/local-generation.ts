import type { z } from 'zod';
import { AnyContentBundle, type WritingProvider } from '../../contracts/index.ts';
import {
  READING_PROVIDER_POLICY,
  READING_V2_EVALUATION_POLICY,
  INITIAL_READING_V2_EVALUATION_POLICY,
  READING_V2_1_EVALUATION_POLICY,
} from '../../contracts/provider-policy.ts';
import { providerPolicyHash } from '../../domain/provider-policy.ts';
import { sha256Json } from '../../domain/json.ts';
import { SAFETY_VERSION } from '../../domain/tarot/safety.ts';
import { InterceptedWritingProvider } from '../provider/intercepted.ts';
import { assertion, onlineGuard } from '../identity/checkpoint.ts';
import { statement as q, DB_NOW } from '../db/core.ts';
import { type RecordBase, terminalStates } from './base.ts';
import { syntheticBundle, localDevelopmentBundle } from './local-content.ts';
import { preparedTemplate } from './writer-versions.ts';
import { ReadingGeneration } from './generation.ts';
import { contentSnapshot, type ContentRow, type ContentRepository } from '../content/repository.ts';

class LocalBootstrap {
  constructor(private readonly base: RecordBase) {}
  async policyHash() {
    return sha256Json({
      localOnly: true,
      writer: 'simulation.v5',
      providerPolicyHash: await providerPolicyHash(READING_V2_EVALUATION_POLICY),
    });
  }
  async refresh() {
    await this.upgradeLocalPolicy(localDevelopmentBundle(), await this.policyHash());
  }
  /** Upgrade only known localhost predecessors. Operator and financial switches are untouched. */
  private async upgradeLocalPolicy(bundle: z.infer<typeof AnyContentBundle>, next: string) {
    const installed = await q(
      this.base.db,
      'SELECT provider_policy_hash,active_content_hash FROM system_state WHERE id=1',
    ).first<{ provider_policy_hash: string; active_content_hash: string }>();
    const predecessors = await Promise.all([
      sha256Json({
        localOnly: true,
        writer: 'simulation.v5',
        providerPolicyHash: await providerPolicyHash(READING_V2_1_EVALUATION_POLICY),
      }),
      sha256Json({
        localOnly: true,
        writer: 'simulation.v5',
        providerPolicyHash: await providerPolicyHash(INITIAL_READING_V2_EVALUATION_POLICY),
      }),
      sha256Json({
        localOnly: true,
        writer: 'simulation.v4',
        providerPolicyHash: await providerPolicyHash(READING_PROVIDER_POLICY),
      }),
      sha256Json({ localOnly: true, writer: 'simulation.v1' }),
      sha256Json({ localOnly: true, writer: 'simulation.v2', validator: SAFETY_VERSION }),
      Promise.resolve('f2d365842b853e8998b3d466c768d4bf4c026c4563f2daa4763d9dfddcfa8df7'),
    ]);
    const content = bundle.editionHash;
    if (
      !installed ||
      !predecessors.includes(installed.provider_policy_hash) ||
      ![
        content,
        (await syntheticBundle()).editionHash,
        '5c8573a9c66dd25a781067244bc124cb8b558b8cf33ea3d7981c9088c0771d5d',
      ].includes(installed.active_content_hash)
    )
      return;
    const previous = installed.provider_policy_hash;
    const ids = `SELECT id FROM generation_requests WHERE policy_hash=? AND state NOT IN (${terminalStates})`;
    const identity = [previous];
    try {
      await this.base.db.batch([
        onlineGuard(this.base.db),
        assertion(
          this.base.db,
          'EXISTS(SELECT 1 FROM system_state WHERE id=1 AND provider_policy_hash=? AND active_content_hash=?)',
          previous,
          installed.active_content_hash,
        ),
        q(
          this.base.db,
          `INSERT OR IGNORE INTO content_editions(hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at) VALUES (?,'approved',?,?,'human_approved','SYNTHETIC LOCAL FIXTURE; NOT EDITORIAL APPROVAL','cleared',${DB_NOW},${DB_NOW})`,
          content,
          JSON.stringify(bundle),
          content,
        ),
        q(
          this.base.db,
          `INSERT INTO request_events(request_id,owner_id,sequence,state,code,error_code,created_at) SELECT id,owner_id,max(next_event,coalesce((SELECT max(sequence)+1 FROM request_events WHERE request_id=r.id),1)),'blocked','STOPPED','DEPENDENCY_UNAVAILABLE',${DB_NOW} FROM generation_requests r WHERE id IN (${ids})`,
          ...identity,
        ),
        q(
          this.base.db,
          `UPDATE generation_requests SET next_event=(SELECT max(sequence)+1 FROM request_events WHERE request_id=generation_requests.id) WHERE id IN (${ids})`,
          ...identity,
        ),
        q(
          this.base.db,
          `UPDATE quota_buckets SET held=held-(SELECT count(*) FROM quota_reservations qr WHERE qr.owner_id=quota_buckets.owner_id AND qr.state='held' AND (qr.day_period=quota_buckets.period OR qr.month_period=quota_buckets.period) AND qr.request_id IN (${ids})) WHERE held>0`,
          ...identity,
        ),
        q(
          this.base.db,
          `INSERT OR IGNORE INTO quota_events SELECT request_id,owner_id,'release',${DB_NOW} FROM quota_reservations WHERE state='held' AND request_id IN (${ids})`,
          ...identity,
        ),
        q(
          this.base.db,
          `UPDATE quota_reservations SET state='released' WHERE state='held' AND request_id IN (${ids})`,
          ...identity,
        ),
        q(
          this.base.db,
          `UPDATE cost_reservations SET state='unknown',settled_at=${DB_NOW} WHERE state='reserved' AND dispatch_id IN (SELECT id FROM provider_dispatches WHERE request_id IN (${ids}))`,
          ...identity,
        ),
        q(
          this.base.db,
          `UPDATE provider_dispatches SET state=CASE WHEN state='authorized' THEN 'unknown' ELSE state END,transmission_enc=NULL,candidate_enc=NULL,provider_response_id_enc=NULL WHERE request_id IN (${ids})`,
          ...identity,
        ),
        q(
          this.base.db,
          `UPDATE generation_attempts SET outcome='blocked',finished_at=${DB_NOW} WHERE finished_at IS NULL AND request_id IN (${ids})`,
          ...identity,
        ),
        q(
          this.base.db,
          `UPDATE accounts SET data_revision=data_revision+1 WHERE id IN (SELECT owner_id FROM generation_requests WHERE id IN (${ids}))`,
          ...identity,
        ),
        q(
          this.base.db,
          `UPDATE generation_requests SET state='blocked',error_code='DEPENDENCY_UNAVAILABLE',revision=revision+1,run_epoch=run_epoch+1,lease_token=NULL,lease_expires_at=NULL,finished_at=${DB_NOW} WHERE id IN (${ids})`,
          ...identity,
        ),
        q(
          this.base.db,
          "UPDATE content_editions SET state='superseded',policy_revision=policy_revision+1 WHERE hash=? AND hash!=? AND state='approved'",
          installed.active_content_hash,
          content,
        ),
        q(
          this.base.db,
          `UPDATE system_state SET provider_policy_hash=?,active_content_hash=?,revision=revision+1,updated_at=${DB_NOW} WHERE id=1 AND provider_policy_hash=?`,
          next,
          content,
          previous,
        ),
        assertion(this.base.db, 'changes()=1'),
      ]);
    } catch (error) {
      if (
        (await q(
          this.base.db,
          'SELECT provider_policy_hash FROM system_state WHERE id=1',
        ).first<string>('provider_policy_hash')) !== next
      )
        throw error;
    }
  }
  async install() {
    const content = localDevelopmentBundle(),
      policyHash = await this.policyHash();
    // The legacy localhost D1 barrier uses explicitly marked fixture rows. The bundle
    // itself retains agent_reviewed/unknown rights; approval_json remains null, so
    // the signed production repository cannot admit this development content.
    await this.base.db.batch([
      onlineGuard(this.base.db),
      q(
        this.base.db,
        `INSERT OR IGNORE INTO content_editions(hash,state,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at) VALUES (?,'approved',?,?,'human_approved','SYNTHETIC LOCAL FIXTURE; NOT EDITORIAL APPROVAL','cleared',${DB_NOW},${DB_NOW})`,
        content.editionHash,
        JSON.stringify(content),
        content.editionHash,
      ),
      q(
        this.base.db,
        `INSERT OR IGNORE INTO system_state(id,active_content_hash,generation_enabled,dispatch_mode,provider_policy_hash,updated_at) VALUES (1,?,1,'model',?,${DB_NOW})`,
        content.editionHash,
        policyHash,
      ),
    ]);
    await this.upgradeLocalPolicy(content, policyHash);
  }
}
class LocalContentRepository implements ContentRepository {
  constructor(
    private readonly base: RecordBase,
    private readonly bootstrap: LocalBootstrap,
  ) {}
  async active() {
    return (await this.forGeneration()).bundle;
  }
  async byHash(hash: string) {
    return (await this.forGeneration(hash)).bundle;
  }
  async forGeneration(hash?: string) {
    if (hash === undefined) await this.bootstrap.install();
    const row = await (hash === undefined
      ? q(
          this.base.db,
          'SELECT c.* FROM content_editions c JOIN system_state s ON s.active_content_hash=c.hash WHERE s.id=1',
        )
      : q(this.base.db, 'SELECT * FROM content_editions WHERE hash=?', hash)
    ).first<ContentRow>();
    if (!row || !['approved', 'superseded'].includes(row.state))
      throw new Error('CONTENT_UNAVAILABLE');
    const bundle = AnyContentBundle.parse(JSON.parse(row.bundle_json));
    if (bundle.editionHash !== row.hash) throw new Error('CONTENT_UNAVAILABLE');
    return contentSnapshot(this.base.db, row, bundle);
  }
}
/** Explicit localhost simulation. Owns all synthetic installation and local migration. */
export class LocalGeneration extends ReadingGeneration {
  constructor(base: RecordBase, supplied?: WritingProvider) {
    const bootstrap = new LocalBootstrap(base);
    super(base, {
      content: new LocalContentRepository(base, bootstrap),
      policy: READING_V2_EVALUATION_POLICY,
      authorization: { kind: 'synthetic-local', policyHash: () => bootstrap.policyHash() },
      ensureReady: () => bootstrap.refresh(),
      writer: async (plan) =>
        supplied ??
        new InterceptedWritingProvider({
          outcome: {
            kind: 'candidate',
            candidate: await preparedTemplate(plan),
            receipt: {
              responseId: null,
              returnedModel: READING_V2_EVALUATION_POLICY.model,
              serviceTier: READING_V2_EVALUATION_POLICY.request.service_tier,
              durationMs: 0,
              usage: {
                inputTokens: 0,
                cachedInputTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
              },
            },
          },
        }),
    });
  }
}
