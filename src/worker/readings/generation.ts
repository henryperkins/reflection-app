import { costReservationStatement, reconcileProviderCost } from '../provider/costs.ts';
import { providerReceiptStatements } from '../provider/receipts.ts';
import {
  READING_PROVIDER_POLICY,
  READING_V2_EVALUATION_POLICY,
  INITIAL_READING_V2_EVALUATION_POLICY,
  type WriterProviderPolicy,
} from '../../contracts/provider-policy.ts';
import { providerPolicyHash } from '../../domain/provider-policy.ts';
import type { z } from 'zod';
import {
  AnyAcceptedReading,
  apiSchemas,
  AnyModelCandidate,
  StartRequest,
  AnyPreparedPlan,
  AnyContentBundle,
  TarotBasis,
  ProviderReceipt,
  type WriterOutcome,
  type WritingProvider,
  type ErrorCode,
} from '../../contracts/index.ts';
import { inputAdmission, boundedCandidateJson, SAFETY_VERSION } from '../../domain/tarot/safety.ts';
import { drawTarot } from '../../domain/tarot/draw.ts';
import { sha256Json } from '../../domain/json.ts';
import { InterceptedWritingProvider } from '../provider/intercepted.ts';
import { currentGuard } from '../db/statements.ts';
import { renderFacts } from '../../domain/tarot/facts.ts';
import { assertion, onlineGuard } from '../identity/checkpoint.ts';
import type { Session } from '../identity/types.ts';
import { statement as q, DB_NOW, DAY, MONTH } from '../db/core.ts';
import { iso, type RecordBase, RecordError, terminalStates } from './base.ts';
import { syntheticBundle, localDevelopmentBundle } from './local-content.ts';
import {
  buildLocalPlan,
  validateLocalPlan,
  prepareLocalWriter,
  localTemplate,
  checkLocalCandidate,
  planPolicy,
  type VersionedPlan,
} from './writer-versions.ts';
import { RequestState, requestEvent } from './request-state.ts';

/** Only instantiated behind the explicit localhost simulation switch. No fetch transport. */
export class LocalGeneration extends RequestState {
  constructor(
    base: RecordBase,
    private readonly writer?: WritingProvider,
  ) {
    super(base);
  }
  private guard(session: Session, permission: number, content: string) {
    return assertion(
      this.base.db,
      `EXISTS(SELECT 1 FROM accounts a JOIN permission_revisions p ON p.owner_id=a.id AND p.revision=a.permission_revision JOIN system_state sys ON sys.id=1 JOIN content_editions c ON c.hash=sys.active_content_hash WHERE a.id=? AND a.permission_revision=? AND p.model_allowed=1 AND a.recovery_ack_at IS NOT NULL AND a.key_version=1 AND sys.generation_enabled=1 AND sys.dispatch_mode IN('model','outage_template') AND c.hash=? AND c.state='approved')`,
      session.subjectId,
      permission,
      content,
    );
  }
  private async localPolicyHash() {
    return sha256Json({
      localOnly: true,
      writer: 'simulation.v5',
      providerPolicyHash: await providerPolicyHash(READING_V2_EVALUATION_POLICY),
    });
  }
  private async refreshLocalPolicy() {
    await this.upgradeLocalPolicy(localDevelopmentBundle(), await this.localPolicyHash());
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
  private async reply(session: Session, requestId: string, joined: boolean) {
    const status = await this.status(session, requestId);
    return apiSchemas.StartResponse.parse({
      requestId,
      sessionId: status.sessionId,
      joined,
      status,
    });
  }
  async start(
    session: Session,
    input: z.infer<typeof StartRequest>,
    key: string,
    defer?: (work: Promise<void>) => void,
  ) {
    const denied = inputAdmission(input.question, input.languageConfirmed);
    if (denied) throw new RecordError(422, denied);
    if (input.parentEditionId !== null || input.selection.length)
      throw new RecordError(422, 'BAD_INPUT');
    const mutation = await this.base.mutation(session, key, 'reading.start', input);
    const resolve = async () => {
      const row = await q(
        this.base.db,
        'SELECT id,payload_hmac FROM generation_requests WHERE owner_id=? AND (client_intent_id=? OR id=?)',
        session.subjectId,
        input.clientIntentId,
        mutation.existing ?? '',
      ).first<{ id: string; payload_hmac: string }>();
      if (!row) return null;
      if (row.payload_hmac !== mutation.payloadHash)
        throw new RecordError(409, 'IDEMPOTENCY_MISMATCH');
      const alias = await this.base.mutation(session, key, 'reading.start', input);
      if (!alias.existing) {
        try {
          await this.base.atomic(session, [alias.insert(row.id)]);
        } catch (error) {
          const raced = await this.base.mutation(session, key, 'reading.start', input);
          if (raced.existing !== row.id) throw error;
        }
      }
      return this.reply(session, row.id, true);
    };
    const prior = await resolve();
    if (prior) return prior;
    const account = await this.base.account(session);
    if (!account.model_allowed) throw new RecordError(403, 'CONSENT_REQUIRED');
    if (!account.recovery_ack_at) throw new RecordError(403, 'FORBIDDEN');
    if (account.permission_revision !== input.permissionRevision)
      throw new RecordError(409, 'CONFLICT', account.permission_revision);
    const content = localDevelopmentBundle(),
      policyHash = await this.localPolicyHash();
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
    const requestId = crypto.randomUUID(),
      sessionId = crypto.randomUUID(),
      basisId = crypto.randomUUID();
    const basis = await drawTarot({
      deck: content.deck.map((c) => c.id),
      deckEdition: content.deckEdition,
      basisId,
      drawnAt: iso(Date.now()),
      reversals: input.reversals,
    });
    const plan = await buildLocalPlan({
      requestId,
      basis,
      content,
      question: input.question,
      language: 'en',
      operation: 'initial',
      parentEditionId: null,
      selected: [],
      permissionRevision: input.permissionRevision,
      keyVersion: 1,
      promptHash: policyHash,
      validatorHash: policyHash,
      generationPolicyHash: policyHash,
    });
    try {
      await prepareLocalWriter(plan);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('INPUT_TOO_LARGE'))
        throw new RecordError(422, 'INPUT_TOO_LARGE');
      throw error;
    }
    const seal = (table: string, column: string, id: string, value: unknown) =>
      this.base.crypt.seal(session.subjectId, table, column, id, value);
    const question = await seal('reading_sessions', 'question_enc', sessionId, {
      v: 1,
      text: input.question,
    });
    const basisEnc = await seal('basis_snapshots', 'body_enc', basisId, basis);
    const inputEnc = await seal('generation_requests', 'input_enc', requestId, input);
    const planEnc = await seal('generation_requests', 'plan_enc', requestId, plan);
    const planHash = await this.base.crypt.hash(session.subjectId, 'plan', plan);
    try {
      await this.base.atomic(session, [
        this.guard(session, input.permissionRevision, content.editionHash),
        assertion(
          this.base.db,
          `(SELECT count(*) FROM generation_requests WHERE owner_id=? AND state NOT IN (${terminalStates}))<2`,
          session.subjectId,
        ),
        q(
          this.base.db,
          `INSERT OR IGNORE INTO quota_buckets(owner_id,period,allowance) VALUES (?,${DAY},3),(?,${MONTH},30)`,
          session.subjectId,
          session.subjectId,
        ),
        q(
          this.base.db,
          `UPDATE quota_buckets SET held=held+1 WHERE owner_id=? AND period IN (${DAY},${MONTH}) AND held+consumed<allowance`,
          session.subjectId,
        ),
        assertion(this.base.db, 'changes()=2'),
        q(
          this.base.db,
          `INSERT INTO reading_sessions(id,owner_id,question_enc,created_at,retention_expires_at) VALUES (?,?,?,${DB_NOW},${DB_NOW}+86400000)`,
          sessionId,
          session.subjectId,
          question,
        ),
        q(
          this.base.db,
          `INSERT INTO basis_snapshots(id,owner_id,session_id,kind,schema_version,body_enc,key_version,created_at) VALUES (?,?,?,'tarot.v1',1,?,1,${DB_NOW})`,
          basisId,
          session.subjectId,
          sessionId,
          basisEnc,
        ),
        q(
          this.base.db,
          `INSERT INTO generation_requests(id,owner_id,session_id,client_intent_id,basis_id,operation,payload_hmac,state,next_run_at,permission_revision,key_version,content_hash,content_policy_revision,policy_hash,input_enc,plan_enc,plan_hmac,created_at,expires_at) VALUES (?,?,?,?,?,'initial',?,'prepared',${DB_NOW},?,1,?,1,?,?,?,?,${DB_NOW},${DB_NOW}+180000)`,
          requestId,
          session.subjectId,
          sessionId,
          input.clientIntentId,
          basisId,
          mutation.payloadHash,
          input.permissionRevision,
          content.editionHash,
          policyHash,
          inputEnc,
          planEnc,
          planHash,
        ),
        q(
          this.base.db,
          `INSERT INTO quota_reservations VALUES (?,?,${DAY},${MONTH},'held',${DB_NOW}+180000)`,
          requestId,
          session.subjectId,
        ),
        q(
          this.base.db,
          `INSERT INTO quota_events VALUES (?,?,'reserve',${DB_NOW})`,
          requestId,
          session.subjectId,
        ),
        mutation.insert(requestId),
        ...requestEvent(this.base.db, session.subjectId, requestId, 'QUEUED'),
      ]);
    } catch (error) {
      const joined = await resolve();
      if (joined) return joined;
      const view = await this.base.identity.sessions.view(session);
      if (!view.permission.modelAllowed) throw new RecordError(403, 'CONSENT_REQUIRED');
      const active = await q(
        this.base.db,
        `SELECT count(*) AS n FROM generation_requests WHERE owner_id=? AND state NOT IN (${terminalStates})`,
        session.subjectId,
      ).first<number>('n');
      if (active !== null && active >= 2) throw new RecordError(429, 'RATE_LIMITED');
      if (view.remainingDay === 0 || view.remainingMonth === 0)
        throw new RecordError(429, 'QUOTA_EXCEEDED');
      throw error;
    }
    if (defer) {
      const admitted = await this.reply(session, requestId, false);
      defer(this.drive(requestId));
      return admitted;
    }
    await this.drive(requestId);
    return this.reply(session, requestId, false);
  }

  /** Durable D1 work is authoritative; waitUntil only reduces latency. */
  async maintenance() {
    await this.base.db.batch([onlineGuard(this.base.db)]);
    await this.refreshLocalPolicy();
    await this.reconcileStopped();
    const due = await q(
      this.base.db,
      `SELECT id FROM generation_requests WHERE state NOT IN (${terminalStates}) AND (expires_at<=${DB_NOW} OR (next_run_at<=${DB_NOW} AND (lease_expires_at IS NULL OR lease_expires_at<=${DB_NOW}))) ORDER BY next_run_at,id LIMIT 20`,
    ).all<{ id: string }>();
    const started = Date.now();
    for (let i = 0; i < due.results.length && Date.now() - started < 30000; i += 4)
      await Promise.allSettled(due.results.slice(i, i + 4).map((row) => this.drive(row.id)));
    await this.base.db.batch([onlineGuard(this.base.db)]);
  }

  private async reconcileStopped() {
    const rows = await q(
      this.base.db,
      `SELECT d.request_id FROM provider_dispatches d JOIN generation_requests r ON r.id=d.request_id WHERE r.state IN (${terminalStates}) AND (d.state='authorized' OR (r.state!='published' AND (d.transmission_enc IS NOT NULL OR d.candidate_enc IS NOT NULL OR d.provider_response_id_enc IS NOT NULL))) ORDER BY d.authorized_at LIMIT 20`,
    ).all<{ request_id: string }>();
    for (const row of rows.results)
      await this.base.db.batch([
        onlineGuard(this.base.db),
        q(
          this.base.db,
          `UPDATE provider_dispatches SET state=CASE WHEN state='authorized' THEN 'unknown' ELSE state END,transmission_enc=NULL,candidate_enc=NULL,provider_response_id_enc=NULL WHERE request_id=? AND EXISTS(SELECT 1 FROM generation_requests WHERE id=? AND state IN (${terminalStates}))`,
          row.request_id,
          row.request_id,
        ),
        q(
          this.base.db,
          `UPDATE cost_reservations SET state='unknown',settled_at=${DB_NOW} WHERE state='reserved' AND dispatch_id IN (SELECT id FROM provider_dispatches WHERE request_id=?)`,
          row.request_id,
        ),
      ]);
  }
  private row(id: string) {
    return q(
      this.base.db,
      `SELECT *,expires_at<=${DB_NOW} AS expired FROM generation_requests WHERE id=?`,
      id,
    ).first<RequestRow>();
  }
  private dispatchRow(id: string) {
    return q(
      this.base.db,
      'SELECT * FROM provider_dispatches WHERE request_id=?',
      id,
    ).first<DispatchRow>();
  }
  private guardCurrent(
    h: Lease,
    state: string,
    stage: 'dispatch' | 'publish' | 'recover' = 'recover',
  ) {
    return currentGuard(
      this.base.db,
      {
        request_id: h.id,
        owner_id: h.owner_id,
        key_version: h.key_version,
        run_epoch: h.run_epoch,
        lease_token: h.lease_token,
        expected_state: state,
        plan_hmac: h.plan_hmac,
        context_count: h.context_count,
      },
      stage,
    );
  }
  private fence(h: Lease) {
    return assertion(
      this.base.db,
      `EXISTS(SELECT 1 FROM generation_requests WHERE id=? AND owner_id=? AND run_epoch=? AND lease_token=? AND lease_expires_at>${DB_NOW} AND expires_at>${DB_NOW} AND state NOT IN (${terminalStates}))`,
      h.id,
      h.owner_id,
      h.run_epoch,
      h.lease_token,
    );
  }
  private accountWrite(owner: string) {
    return [
      q(
        this.base.db,
        `UPDATE accounts SET data_revision=data_revision+1,updated_at=${DB_NOW} WHERE id=? AND storage_bytes<=20971520`,
        owner,
      ),
      assertion(this.base.db, 'changes()=1'),
    ];
  }
  private async claim(row: RequestRow): Promise<Lease | null> {
    const token = crypto.randomUUID(),
      attempt = crypto.randomUUID();
    try {
      await this.base.db.batch([
        onlineGuard(this.base.db),
        q(
          this.base.db,
          `UPDATE generation_requests SET run_epoch=run_epoch+1,revision=revision+1,lease_token=?,lease_expires_at=${DB_NOW}+75000 WHERE id=? AND run_epoch=? AND run_epoch<3 AND state NOT IN (${terminalStates}) AND (lease_expires_at IS NULL OR lease_expires_at<=${DB_NOW}) AND expires_at>${DB_NOW} AND next_run_at<=${DB_NOW}`,
          token,
          row.id,
          row.run_epoch,
        ),
        assertion(this.base.db, 'changes()=1'),
        q(
          this.base.db,
          `UPDATE generation_attempts SET outcome='crashed',finished_at=${DB_NOW} WHERE request_id=? AND finished_at IS NULL`,
          row.id,
        ),
        q(
          this.base.db,
          `INSERT INTO generation_attempts(id,owner_id,request_id,run_epoch,lease_token,started_at) VALUES (?,?,?,?,?,${DB_NOW})`,
          attempt,
          row.owner_id,
          row.id,
          row.run_epoch + 1,
          token,
        ),
      ]);
      return { ...row, run_epoch: row.run_epoch + 1, lease_token: token, attempt_id: attempt };
    } catch {
      // A claim with an unknown acknowledgement is left for its next lease. Never infer authority.
      return null;
    }
  }
  private async eligibility(id: string): Promise<ErrorCode | null> {
    const row = await q(
      this.base.db,
      `SELECT CASE
      WHEN r.expires_at<=${DB_NOW} THEN 'EXPIRED'
      WHEN a.status!='active' OR a.write_fence IS NOT NULL THEN 'ACCOUNT_FROZEN'
      WHEN a.key_version!=r.key_version OR k.owner_id IS NULL THEN 'KEY_UNAVAILABLE'
      WHEN a.permission_revision!=r.permission_revision OR p.model_allowed!=1 THEN 'CONSENT_REQUIRED'
      WHEN s.status NOT IN ('open','saved') OR (s.status='open' AND s.retention_expires_at<=${DB_NOW}) THEN 'CONTENT_UNAVAILABLE'
      WHEN c.state NOT IN ('approved','superseded') OR c.rights_status!='cleared' OR c.policy_revision!=r.content_policy_revision THEN 'CONTENT_UNAVAILABLE'
      WHEN sys.generation_enabled!=1 OR sys.dispatch_mode='off' OR sys.provider_policy_hash!=r.policy_hash THEN 'DEPENDENCY_UNAVAILABLE'
      ELSE NULL END AS failure
      FROM generation_requests r JOIN accounts a ON a.id=r.owner_id JOIN reading_sessions s ON s.id=r.session_id AND s.owner_id=r.owner_id
      LEFT JOIN account_keys k ON k.owner_id=a.id AND k.version=a.key_version
      JOIN permission_revisions p ON p.owner_id=a.id AND p.revision=a.permission_revision
      JOIN content_editions c ON c.hash=r.content_hash JOIN system_state sys ON sys.id=1 WHERE r.id=?`,
      id,
    ).first<{ failure: ErrorCode | null }>();
    return row?.failure ?? null;
  }
  private async stop(row: RequestRow, code: ErrorCode, h?: Lease) {
    const state = code === 'EXPIRED' ? 'expired' : code === 'INTERNAL' ? 'failed' : 'blocked';
    try {
      await this.base.db.batch([
        onlineGuard(this.base.db),
        assertion(
          this.base.db,
          `EXISTS(SELECT 1 FROM generation_requests WHERE id=? AND state NOT IN (${terminalStates})${h ? ' AND run_epoch=? AND lease_token=?' : ''})`,
          row.id,
          ...(h ? [h.run_epoch, h.lease_token] : []),
        ),
        q(
          this.base.db,
          `UPDATE quota_buckets SET held=held-1 WHERE owner_id=? AND period IN (SELECT day_period FROM quota_reservations WHERE request_id=? AND state='held' UNION SELECT month_period FROM quota_reservations WHERE request_id=? AND state='held')`,
          row.owner_id,
          row.id,
          row.id,
        ),
        q(
          this.base.db,
          `INSERT OR IGNORE INTO quota_events SELECT request_id,owner_id,'release',${DB_NOW} FROM quota_reservations WHERE request_id=? AND state='held'`,
          row.id,
        ),
        q(
          this.base.db,
          "UPDATE quota_reservations SET state='released' WHERE request_id=? AND state='held'",
          row.id,
        ),
        q(
          this.base.db,
          `UPDATE generation_requests SET state=?,error_code=?,run_epoch=run_epoch+1,revision=revision+1,lease_token=NULL,lease_expires_at=NULL,finished_at=${DB_NOW} WHERE id=?`,
          state,
          code,
          row.id,
        ),
        q(
          this.base.db,
          `UPDATE generation_attempts SET outcome='blocked',finished_at=${DB_NOW} WHERE request_id=? AND finished_at IS NULL`,
          row.id,
        ),
        q(
          this.base.db,
          "UPDATE provider_dispatches SET state=CASE WHEN state='authorized' THEN 'unknown' ELSE state END,candidate_enc=NULL,transmission_enc=NULL,provider_response_id_enc=NULL WHERE request_id=?",
          row.id,
        ),
        q(
          this.base.db,
          `UPDATE cost_reservations SET state='unknown',settled_at=${DB_NOW} WHERE dispatch_id IN (SELECT id FROM provider_dispatches WHERE request_id=?) AND state='reserved'`,
          row.id,
        ),
        ...requestEvent(this.base.db, row.owner_id, row.id, 'STOPPED'),
        q(
          this.base.db,
          'UPDATE accounts SET data_revision=data_revision+1 WHERE id=?',
          row.owner_id,
        ),
      ]);
    } catch {
      // Concurrent terminalization/publication owns the final outcome.
    }
  }
  private async plan(h: Lease): Promise<VersionedPlan> {
    try {
      let plan: VersionedPlan;
      if (h.plan_enc) {
        plan = await this.base.crypt.open(
          h.owner_id,
          'generation_requests',
          'plan_enc',
          h.id,
          h.plan_enc,
          AnyPreparedPlan,
          1,
          h.key_version,
        );
      } else {
        if (h.state !== 'reserved' || !h.input_enc || !h.basis_id)
          throw new GenerationFailure('CONTENT_UNAVAILABLE');
        const input = await this.base.crypt.open(
          h.owner_id,
          'generation_requests',
          'input_enc',
          h.id,
          h.input_enc,
          StartRequest,
          1,
          h.key_version,
        );
        const basisRow = await q(
          this.base.db,
          'SELECT body_enc FROM basis_snapshots WHERE owner_id=? AND id=?',
          h.owner_id,
          h.basis_id,
        ).first<{ body_enc: string }>();
        if (!basisRow) throw new GenerationFailure('CONTENT_UNAVAILABLE');
        const basis = await this.base.crypt.open(
          h.owner_id,
          'basis_snapshots',
          'body_enc',
          h.basis_id,
          basisRow.body_enc,
          TarotBasis,
          1,
          h.key_version,
        );
        const content = await q(
          this.base.db,
          'SELECT bundle_json FROM content_editions WHERE hash=?',
          h.content_hash,
        ).first<string>('bundle_json');
        plan = await buildLocalPlan({
          requestId: h.id,
          basis,
          content: AnyContentBundle.parse(JSON.parse(content!)),
          question: input.question,
          language: 'en',
          operation: 'initial',
          parentEditionId: null,
          selected: [],
          permissionRevision: h.permission_revision,
          keyVersion: h.key_version,
          promptHash: h.policy_hash,
          validatorHash: h.policy_hash,
          generationPolicyHash: h.policy_hash,
        });
        const enc = await this.base.crypt.seal(
          h.owner_id,
          'generation_requests',
          'plan_enc',
          h.id,
          plan,
          1,
          h.key_version,
        );
        h.plan_hmac = await this.base.crypt.hash(h.owner_id, 'plan', plan);
        await this.base.db.batch([
          onlineGuard(this.base.db),
          this.fence(h),
          q(
            this.base.db,
            'UPDATE generation_requests SET plan_enc=?,plan_hmac=? WHERE id=?',
            enc,
            h.plan_hmac,
            h.id,
          ),
          this.guardCurrent(h, 'reserved'),
        ]);
        h.plan_enc = enc;
      }
      await validateLocalPlan(plan);
      const denied = inputAdmission(plan.question, plan.language);
      if (denied) throw new GenerationFailure(denied);
      if (
        plan.requestId !== h.id ||
        plan.basis.basisId !== h.basis_id ||
        plan.contentHash !== h.content_hash ||
        plan.keyVersion !== h.key_version ||
        plan.permissionRevision !== h.permission_revision ||
        plan.generationPolicyHash !== h.policy_hash ||
        plan.operation !== 'initial' ||
        plan.parentEditionId !== null ||
        plan.selected.length !== 0 ||
        h.context_count !== 0 ||
        (await this.base.crypt.hash(h.owner_id, 'plan', plan)) !== h.plan_hmac
      )
        throw new GenerationFailure('CONTENT_UNAVAILABLE');
      if (h.state === 'reserved') await this.transition(h, 'prepared');
      return plan;
    } catch (error) {
      if (error instanceof GenerationFailure) throw error;
      throw new GenerationFailure('CONTENT_UNAVAILABLE');
    }
  }
  private async transition(
    h: Lease,
    state: string,
    code?: string,
    reason: FallbackReason | null = null,
  ) {
    await this.base.db.batch([
      onlineGuard(this.base.db),
      this.guardCurrent(h, h.state),
      q(
        this.base.db,
        `UPDATE generation_requests SET state=?,revision=revision+1,fallback_reason=? WHERE id=? AND run_epoch=? AND lease_token=? AND state=? AND lease_expires_at>${DB_NOW} AND expires_at>${DB_NOW}`,
        state,
        reason,
        h.id,
        h.run_epoch,
        h.lease_token,
        h.state,
      ),
      assertion(this.base.db, 'changes()=1'),
      ...(code ? requestEvent(this.base.db, h.owner_id, h.id, code) : []),
    ]);
    h.state = state;
    h.fallback_reason = reason;
  }
  private async settle(
    dispatch: DispatchRow,
    policy: WriterProviderPolicy,
    receipt?: ProviderReceipt,
  ) {
    await reconcileProviderCost(this.base.db, {
      dispatchId: dispatch.id,
      receiptId: `${dispatch.id}:usage`,
      receipt: receipt ?? null,
      policy,
    });
  }

  private async dispatch(h: Lease, plan: VersionedPlan): Promise<DispatchRow> {
    const { payload, receipt: contextReceipt } = await prepareLocalWriter(plan),
      policy = planPolicy(plan),
      text = new TextDecoder().decode(payload),
      id = crypto.randomUUID();
    const transmission = await this.base.crypt.seal(
      h.owner_id,
      'provider_dispatches',
      'transmission_enc',
      id,
      { v: 1, syntheticOnly: true, payload: text, contextReceipt },
      1,
      h.key_version,
    );
    const hash = await this.base.crypt.hash(h.owner_id, 'transmission', text);
    await this.base.db.batch([
      onlineGuard(this.base.db),
      q(
        this.base.db,
        `INSERT OR IGNORE INTO spend_buckets(period,ceiling_microusd) VALUES (${DAY},10000000),(${MONTH},100000000)`,
      ),
      q(
        this.base.db,
        `UPDATE spend_buckets SET committed_microusd=committed_microusd+${policy.reservationMicrousd} WHERE period IN (${DAY},${MONTH}) AND committed_microusd+${policy.reservationMicrousd}<=ceiling_microusd`,
      ),
      assertion(this.base.db, 'changes()=2'),
      assertion(
        this.base.db,
        "(SELECT count(*) FROM provider_dispatches WHERE state='authorized')<10",
      ),
      q(
        this.base.db,
        `INSERT INTO provider_dispatches(id,owner_id,request_id,attempt_id,state,provider,requested_model,transmission_enc,transmission_hmac,key_version,prompt_hash,validator_hash,content_hash,parameters_json,authorized_at) VALUES (?,?,?,?,'authorized','openai',?,?,?,?,?,?,?,?,${DB_NOW})`,
        id,
        h.owner_id,
        h.id,
        h.attempt_id,
        policy.model,
        transmission,
        hash,
        h.key_version,
        plan.promptHash,
        plan.validatorHash,
        plan.contentHash,
        JSON.stringify({
          syntheticOnly: true,
          externalCall: false,
          ...policy.request,
        }),
      ),
      await costReservationStatement(this.base.db, {
        id: crypto.randomUUID(),
        ownerId: h.owner_id,
        dispatchId: id,
        applicationPolicyHash: plan.generationPolicyHash,
        policy,
      }),
      this.guardCurrent(h, 'prepared', 'dispatch'),
      q(
        this.base.db,
        `UPDATE generation_requests SET state='dispatching',revision=revision+1 WHERE id=? AND run_epoch=? AND lease_token=? AND state='prepared' AND lease_expires_at>=${DB_NOW}+${policy.timeoutMs + 3000} AND expires_at>=${DB_NOW}+${policy.timeoutMs + 3000}`,
        h.id,
        h.run_epoch,
        h.lease_token,
      ),
      assertion(this.base.db, 'changes()=1'),
      ...requestEvent(this.base.db, h.owner_id, h.id, 'WRITING'),
      ...this.accountWrite(h.owner_id),
    ]);
    h.state = 'dispatching';
    const dispatch = (await this.dispatchRow(h.id))!;
    let outcome: WriterOutcome;
    try {
      const candidate = await localTemplate(plan);
      const supplied =
        this.writer ??
        new InterceptedWritingProvider({
          outcome: {
            kind: 'candidate',
            candidate,
            receipt: {
              responseId: null,
              returnedModel: policy.model,
              serviceTier: policy.request.service_tier,
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
        });
      outcome = await supplied.write({
        dispatchId: id,
        model: policy.model,
        payload,
        timeoutMs: policy.timeoutMs,
        maxOutputTokens: policy.request.max_output_tokens,
        store: false,
        reasoning: policy.request.reasoning.effort,
        signal: AbortSignal.timeout(policy.timeoutMs),
      });
    } catch {
      outcome = { kind: 'uncertain', reason: 'network', receipt: null };
    }
    const parsedReceipt = ProviderReceipt.safeParse(outcome.receipt);
    const receipt = parsedReceipt.success ? parsedReceipt.data : null;
    const halt = outcome.kind === 'uncertain' && outcome.haltGeneration;
    await this.base.db.batch([
      onlineGuard(this.base.db),
      ...providerReceiptStatements(this.base.db, id, h.owner_id, receipt),
      ...(halt
        ? [
            q(
              this.base.db,
              `UPDATE system_state SET generation_enabled=0,revision=revision+1,updated_at=${DB_NOW} WHERE id=1`,
            ),
          ]
        : []),
    ]);
    await this.settle(dispatch, policy, receipt ?? undefined);
    if (halt) throw new GenerationFailure('DEPENDENCY_UNAVAILABLE');
    const responseId =
      receipt?.responseId == null
        ? null
        : await this.base.crypt.seal(
            h.owner_id,
            'provider_dispatches',
            'provider_response_id_enc',
            id,
            { v: 1, id: receipt.responseId },
            1,
            h.key_version,
          );
    if (outcome.kind !== 'candidate' || !receipt) {
      const failure =
        outcome.kind === 'refusal'
          ? 'PROVIDER_REFUSAL'
          : outcome.kind === 'rejected' && ![429, 500, 503].includes(outcome.status)
            ? 'PROVIDER_UNAVAILABLE'
            : null;
      const reason: FallbackReason =
        outcome.kind === 'invalid' || outcome.kind === 'candidate'
          ? 'MALFORMED'
          : outcome.kind === 'uncertain'
            ? 'TIMEOUT_UNKNOWN'
            : 'OUTAGE';
      await this.base.db.batch([
        onlineGuard(this.base.db),
        this.fence(h),
        q(
          this.base.db,
          "UPDATE provider_dispatches SET state=?,provider_response_id_enc=? WHERE id=? AND state='authorized'",
          outcome.kind === 'uncertain' ? 'unknown' : 'rejected',
          responseId,
          id,
        ),
        assertion(this.base.db, 'changes()=1'),
        q(
          this.base.db,
          'UPDATE generation_requests SET error_code=?,fallback_reason=? WHERE id=?',
          failure,
          failure ? null : reason,
          h.id,
        ),
      ]);
      if (outcome.kind === 'refusal') throw new GenerationFailure('PROVIDER_REFUSAL');
      if (outcome.kind === 'rejected' && ![429, 500, 503].includes(outcome.status))
        throw new GenerationFailure('PROVIDER_UNAVAILABLE');
      await this.transition(h, 'fallback_pending', 'USING_TEMPLATE', reason);
      return (await this.dispatchRow(h.id))!;
    }
    // Persist the raw bounded candidate separately: publication can resume after Worker loss.
    try {
      boundedCandidateJson(outcome.candidate);
    } catch {
      await this.transition(h, 'fallback_pending', 'USING_TEMPLATE', 'MALFORMED');
      return (await this.dispatchRow(h.id))!;
    }
    const candidate = await this.base.crypt.seal(
      h.owner_id,
      'provider_dispatches',
      'candidate_enc',
      id,
      outcome.candidate,
      1,
      h.key_version,
    );
    await this.base.db.batch([
      onlineGuard(this.base.db),
      this.guardCurrent(h, 'dispatching'),
      q(
        this.base.db,
        `UPDATE provider_dispatches SET state='received',candidate_enc=?,provider_response_id_enc=?,returned_model=?,input_tokens=?,output_tokens=?,duration_ms=?,received_at=${DB_NOW} WHERE id=? AND state='authorized'`,
        candidate,
        responseId,
        receipt.returnedModel,
        receipt.usage.inputTokens,
        receipt.usage.outputTokens,
        receipt.durationMs,
        id,
      ),
      assertion(this.base.db, 'changes()=1'),
      q(
        this.base.db,
        `UPDATE generation_requests SET state='received',revision=revision+1 WHERE id=? AND run_epoch=? AND lease_token=? AND state='dispatching' AND lease_expires_at>${DB_NOW} AND expires_at>${DB_NOW}`,
        h.id,
        h.run_epoch,
        h.lease_token,
      ),
      assertion(this.base.db, 'changes()=1'),
      ...requestEvent(this.base.db, h.owner_id, h.id, 'CHECKING'),
      ...this.accountWrite(h.owner_id),
    ]);
    h.state = 'received';
    return (await this.dispatchRow(h.id))!;
  }
  private async publish(h: Lease, plan: VersionedPlan, dispatch: DispatchRow | null) {
    let candidate: z.infer<typeof AnyModelCandidate>;
    let template = h.state === 'fallback_pending';
    const prepared = await prepareLocalWriter(plan);
    if (
      dispatch &&
      (await this.base.crypt.hash(
        h.owner_id,
        'transmission',
        new TextDecoder().decode(prepared.payload),
      )) !== dispatch.transmission_hmac
    )
      throw new GenerationFailure('CONTENT_UNAVAILABLE');
    const receipt = dispatch ? prepared.receipt : null;
    if (!template) {
      if (!dispatch?.candidate_enc) throw new GenerationFailure('INVALID_CANDIDATE');
      try {
        const stored = await this.base.crypt.open(
          h.owner_id,
          'provider_dispatches',
          'candidate_enc',
          dispatch.id,
          dispatch.candidate_enc,
          AnyModelCandidate,
          1,
          h.key_version,
        );
        candidate = await checkLocalCandidate(plan, stored, receipt);
      } catch {
        await this.transition(h, 'fallback_pending', 'USING_TEMPLATE', 'VALIDATION');
        template = true;
      }
    }
    if (template)
      candidate = await checkLocalCandidate(plan, await localTemplate(plan), receipt, true);
    else if (h.state !== 'validating') await this.transition(h, 'validating');
    const facts = renderFacts(plan.basis),
      editionId = crypto.randomUUID(),
      acceptedAt = Date.now();
    const reading = AnyAcceptedReading.parse({
      kind: plan.version === 'tarot-plan.v2' ? 'tarot.accepted.v2' : 'tarot.accepted.v1',
      editionId,
      sessionId: h.session_id,
      editionNumber: 1,
      parentEditionId: null,
      question: plan.question,
      basis: plan.basis,
      mode: template ? 'template' : 'model',
      contentHash: plan.contentHash,
      planHash: h.plan_hmac,
      sources: plan.sources,
      units: plan.basis.cards.map((card, i) => ({
        ...candidate!.units.find((unit) => unit.position === card.position)!,
        basisText: facts[i]!.text,
      })),
      ...(candidate!.schemaVersion === 2 && plan.version === 'tarot-plan.v2'
        ? {
            draw: plan.draw,
            spread: plan.spread,
            relationships: plan.relationships,
            synthesis: candidate!.synthesis,
            action: candidate!.action,
            reflectionQuestion: candidate!.reflectionQuestion,
            contextReceipt: receipt,
          }
        : candidate!.schemaVersion === 1
          ? { closing: candidate!.closing }
          : {}),
      acceptedAt: iso(acceptedAt),
      provenance: {
        ...(plan.version === 'tarot-plan.v2'
          ? { schemaHash: prepared.receipt!.schemaHash, contextHash: plan.contextHash }
          : {}),
        requestId: h.id,
        dispatchId: dispatch?.id ?? null,
        provider: null,
        requestedModel: dispatch?.requested_model ?? null,
        returnedModel: dispatch?.returned_model ?? null,
        promptHash: plan.promptHash,
        validatorHash: plan.validatorHash,
        policyHash: plan.generationPolicyHash,
        contentHash: plan.contentHash,
        selected: plan.selected,
        transmissionHash: dispatch?.transmission_hmac ?? null,
        fallbackReason: template ? h.fallback_reason : null,
      },
    });
    const enc = await this.base.crypt.seal(
      h.owner_id,
      'reading_editions',
      'body_enc',
      editionId,
      reading,
      1,
      h.key_version,
    );
    await this.base.db.batch([
      onlineGuard(this.base.db),
      q(
        this.base.db,
        `INSERT INTO reading_editions(id,owner_id,session_id,edition_number,request_id,basis_id,status,mode,body_enc,key_version,content_hash,accepted_at) VALUES (?,?,?,1,?,?,'accepted',?,?,?,?,?)`,
        editionId,
        h.owner_id,
        h.session_id,
        h.id,
        h.basis_id,
        template ? 'template' : 'model',
        enc,
        h.key_version,
        h.content_hash,
        acceptedAt,
      ),
      q(
        this.base.db,
        "UPDATE quota_reservations SET state=? WHERE request_id=? AND state='held'",
        template ? 'released' : 'consumed',
        h.id,
      ),
      assertion(this.base.db, 'changes()=1'),
      q(
        this.base.db,
        'UPDATE quota_buckets SET held=held-1,consumed=consumed+? WHERE owner_id=? AND period IN (SELECT day_period FROM quota_reservations WHERE request_id=? UNION SELECT month_period FROM quota_reservations WHERE request_id=?)',
        template ? 0 : 1,
        h.owner_id,
        h.id,
        h.id,
      ),
      assertion(this.base.db, 'changes()=2'),
      q(
        this.base.db,
        `INSERT INTO quota_events VALUES (?,?,?,${DB_NOW})`,
        h.id,
        h.owner_id,
        template ? 'release' : 'consume',
      ),
      this.guardCurrent(h, template ? 'fallback_pending' : 'validating', 'publish'),
      assertion(
        this.base.db,
        `EXISTS(SELECT 1 FROM reading_sessions WHERE owner_id=? AND id=? AND (status='saved' OR (status='open' AND retention_expires_at>${DB_NOW})))`,
        h.owner_id,
        h.session_id,
      ),
      q(
        this.base.db,
        `UPDATE generation_requests SET state='published',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,finished_at=${DB_NOW} WHERE id=? AND run_epoch=? AND lease_token=? AND state=? AND lease_expires_at>${DB_NOW} AND expires_at>${DB_NOW}`,
        h.id,
        h.run_epoch,
        h.lease_token,
        template ? 'fallback_pending' : 'validating',
      ),
      assertion(this.base.db, 'changes()=1'),
      q(
        this.base.db,
        `UPDATE generation_attempts SET outcome='complete',finished_at=${DB_NOW} WHERE id=?`,
        h.attempt_id,
      ),
      ...requestEvent(this.base.db, h.owner_id, h.id, 'ACCEPTED', editionId),
      ...this.accountWrite(h.owner_id),
    ]);
  }
  async drive(id: string): Promise<void> {
    await this.refreshLocalPolicy();
    const row = await this.row(id);
    if (!row || ['published', 'blocked', 'failed', 'expired', 'cancelled'].includes(row.state))
      return;
    if (row.expired) {
      await this.stop(row, 'EXPIRED');
      return;
    }
    if (row.policy_hash !== (await this.localPolicyHash())) {
      await this.stop(row, 'DEPENDENCY_UNAVAILABLE');
      return;
    }
    if (row.run_epoch >= 3) {
      const due = await q(
        this.base.db,
        `SELECT 1 FROM generation_requests WHERE id=? AND (lease_expires_at IS NULL OR lease_expires_at<=${DB_NOW})`,
        id,
      ).first();
      if (due) await this.stop(row, 'INTERNAL');
      return;
    }
    const h = await this.claim(row);
    if (!h) return;
    try {
      const invalid = await this.eligibility(id);
      if (invalid) throw new GenerationFailure(invalid);
      if (h.error_code === 'PROVIDER_REFUSAL' || h.error_code === 'PROVIDER_UNAVAILABLE')
        throw new GenerationFailure(h.error_code);
      const plan = await this.plan(h);
      let dispatch = await this.dispatchRow(id);
      if (!dispatch) {
        const mode = await q(
          this.base.db,
          'SELECT dispatch_mode FROM system_state WHERE id=1',
        ).first<string>('dispatch_mode');
        if (mode === 'outage_template')
          await this.transition(h, 'fallback_pending', 'USING_TEMPLATE', 'OUTAGE');
        else dispatch = await this.dispatch(h, plan);
      } else if (!dispatch.candidate_enc && h.state !== 'fallback_pending') {
        await this.settle(dispatch, planPolicy(plan));
        await this.base.db.batch([
          onlineGuard(this.base.db),
          this.fence(h),
          q(
            this.base.db,
            "UPDATE provider_dispatches SET state='unknown' WHERE id=? AND state='authorized'",
            dispatch.id,
          ),
        ]);
        await this.transition(
          h,
          'fallback_pending',
          'USING_TEMPLATE',
          h.fallback_reason ?? 'TIMEOUT_UNKNOWN',
        );
      }
      await this.publish(h, plan, dispatch);
    } catch (error) {
      const latest = await this.row(id);
      if (
        !latest ||
        ['published', 'cancelled', 'blocked', 'failed', 'expired'].includes(latest.state)
      )
        return;
      const failure = await this.eligibility(id);
      if (failure || error instanceof GenerationFailure)
        await this.stop(latest, failure ?? (error as GenerationFailure).code, h);
      // DB acknowledgement loss or Worker interruption leaves the lease for bounded Cron recovery.
    }
  }
}

type FallbackReason = 'OUTAGE' | 'MALFORMED' | 'VALIDATION' | 'TIMEOUT_UNKNOWN';
interface RequestRow {
  id: string;
  owner_id: string;
  session_id: string;
  basis_id: string | null;
  state: string;
  run_epoch: number;
  lease_token: string | null;
  key_version: number;
  permission_revision: number;
  content_hash: string;
  policy_hash: string;
  context_count: number;
  plan_hmac: string | null;
  plan_enc: string | null;
  input_enc: string | null;
  fallback_reason: FallbackReason | null;
  error_code: ErrorCode | null;
  expired: number;
}
interface Lease extends RequestRow {
  lease_token: string;
  attempt_id: string;
}
interface DispatchRow {
  id: string;
  state: string;
  candidate_enc: string | null;
  requested_model: string;
  returned_model: string | null;
  transmission_hmac: string;
}
class GenerationFailure extends Error {
  constructor(readonly code: ErrorCode) {
    super(code);
  }
}
