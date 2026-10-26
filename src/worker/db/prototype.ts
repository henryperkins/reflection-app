import type { WritingProvider, WriterOutcome } from '../../contracts/index.ts';
import {
  assertChanges,
  assertExists,
  currentGuard,
  DAY,
  DB_NOW,
  MONTH,
  statement as q,
} from './statements.ts';

/** Internal, synthetic-only prepared fixture boundary. NOT a GenerationService.
 * No encryption, identity authentication, input/plan/candidate validation or HTTP
 * routes. M2 must supply those boundaries before handling personal information.
 * Never pass real personal text to this prototype or its configured writer.
 */
export interface SyntheticPlan {
  syntheticOnly: true;
  /** Trusted synthetic fixtures may allocate identity before building a domain plan. */
  requestId?: string;
  ownerId: string;
  sessionId: string;
  basisId: string;
  clientIntentId: string;
  idempotencyKey: string;
  payloadHmac: string;
  planHmac: string;
  keyVersion: number;
  permissionRevision: number;
  contentHash: string;
  contentPolicyRevision: number;
  policyHash: string;
  parentEditionId?: string;
  context: Array<{ grantId: string; grantRevision: number; fragmentHmac: string }>;
}
export interface SyntheticLease {
  ownerId: string;
  requestId: string;
  runEpoch: number;
  leaseToken: string;
  attemptId: string;
  plan: SyntheticPlan;
}
export interface PrototypeBarriers {
  beforeDispatch?: () => Promise<void>;
  beforeReceipt?: () => Promise<void>;
  beforePublication?: () => Promise<void>;
}
const PLACEHOLDER = 'SYNTHETIC_ONLY_NOT_ENCRYPTED';
const TERMINAL = "'published','blocked','failed','expired','cancelled'";
function guardValues(h: SyntheticLease, state: string) {
  return {
    request_id: h.requestId,
    owner_id: h.ownerId,
    key_version: h.plan.keyVersion,
    run_epoch: h.runEpoch,
    lease_token: h.leaseToken,
    expected_state: state,
    plan_hmac: h.plan.planHmac,
    context_count: h.plan.context.length,
  };
}
export class SyntheticGenerationPrototype {
  constructor(
    private readonly db: D1Database,
    private readonly writer: WritingProvider,
    private readonly barriers: PrototypeBarriers = {},
  ) {}
  private async owned(owner: string, id: string) {
    const row = await q(
      this.db,
      'SELECT * FROM generation_requests WHERE owner_id=? AND id=?',
      owner,
      id,
    ).first<Record<string, string | number | null>>();
    if (!row) throw new Error('NOT_FOUND');
    return row;
  }
  private fragments(h: SyntheticLease) {
    return h.plan.context.map((x, i) =>
      assertExists(
        this.db,
        `SELECT 1 FROM generation_context WHERE request_id=? AND owner_id=? AND ordinal=? AND grant_id=? AND grant_revision=? AND fragment_hmac=?`,
        h.requestId,
        h.ownerId,
        i,
        x.grantId,
        x.grantRevision,
        x.fragmentHmac,
      ),
    );
  }
  private event(
    owner: string,
    id: string,
    state: string,
    code: string,
    edition: string | null = null,
  ) {
    return [
      q(
        this.db,
        `INSERT INTO request_events(request_id,owner_id,sequence,state,code,edition_id,created_at) SELECT id,owner_id,next_event,?,?,?,${DB_NOW} FROM generation_requests WHERE owner_id=? AND id=?`,
        state,
        code,
        edition,
        owner,
        id,
      ),
      q(
        this.db,
        'UPDATE generation_requests SET next_event=next_event+1 WHERE owner_id=? AND id=?',
        owner,
        id,
      ),
    ];
  }
  private async existing(plan: SyntheticPlan): Promise<string | null> {
    const rows = await q(
      this.db,
      `SELECT r.id,r.payload_hmac FROM generation_requests r WHERE r.owner_id=? AND (r.client_intent_id=? OR r.id IN (SELECT resource_id FROM idempotency_keys WHERE owner_id=? AND key_hash=?))`,
      plan.ownerId,
      plan.clientIntentId,
      plan.ownerId,
      plan.idempotencyKey,
    ).all<{ id: string; payload_hmac: string }>();
    if (!rows.results.length) return null;
    if (rows.results.length !== 1 || rows.results[0]!.payload_hmac !== plan.payloadHmac)
      throw new Error('CONFLICT');
    const id = rows.results[0]!.id;
    await this.db.batch([
      q(
        this.db,
        `INSERT OR IGNORE INTO idempotency_keys VALUES (?,?,'synthetic.start',?,?,${DB_NOW},${DB_NOW}+604800000)`,
        plan.ownerId,
        plan.idempotencyKey,
        plan.payloadHmac,
        id,
      ),
      assertExists(
        this.db,
        "SELECT 1 FROM idempotency_keys WHERE owner_id=? AND key_hash=? AND payload_hmac=? AND resource_id=? AND operation='synthetic.start'",
        plan.ownerId,
        plan.idempotencyKey,
        plan.payloadHmac,
        id,
      ),
    ]);
    return id;
  }
  async start(plan: SyntheticPlan): Promise<string> {
    if (plan.syntheticOnly !== true || plan.context.length > 3)
      throw new Error('SYNTHETIC_PLAN_REQUIRED');
    const existing = await this.existing(plan);
    if (existing) return existing;
    const id = plan.requestId ?? crypto.randomUUID();
    const h: SyntheticLease = {
      ownerId: plan.ownerId,
      requestId: id,
      runEpoch: 0,
      leaseToken: '',
      attemptId: '',
      plan,
    };
    try {
      await this.db.batch([
        assertExists(
          this.db,
          `SELECT 1 WHERE (SELECT count(*) FROM generation_requests WHERE owner_id=? AND state NOT IN (${TERMINAL}))<2`,
          plan.ownerId,
        ),
        q(
          this.db,
          `INSERT OR IGNORE INTO quota_buckets(owner_id,period,allowance) VALUES (?,${DAY},3),(?,${MONTH},30)`,
          plan.ownerId,
          plan.ownerId,
        ),
        q(
          this.db,
          `UPDATE quota_buckets SET held=held+1 WHERE owner_id=? AND period IN (${DAY},${MONTH}) AND held+consumed<allowance`,
          plan.ownerId,
        ),
        assertChanges(this.db, 2),
        q(
          this.db,
          `INSERT INTO generation_requests(id,owner_id,session_id,client_intent_id,parent_edition_id,basis_id,operation,payload_hmac,state,next_run_at,permission_revision,key_version,content_hash,content_policy_revision,policy_hash,input_enc,plan_enc,plan_hmac,context_count,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,'prepared',${DB_NOW},?,?,?,?,?,?,?,?,?,${DB_NOW},${DB_NOW}+180000)`,
          id,
          plan.ownerId,
          plan.sessionId,
          plan.clientIntentId,
          plan.parentEditionId ?? null,
          plan.basisId,
          plan.parentEditionId ? 'followup' : 'initial',
          plan.payloadHmac,
          plan.permissionRevision,
          plan.keyVersion,
          plan.contentHash,
          plan.contentPolicyRevision,
          plan.policyHash,
          PLACEHOLDER,
          JSON.stringify({ marker: PLACEHOLDER, plan }),
          plan.planHmac,
          plan.context.length,
        ),
        ...plan.context.map((x, i) =>
          q(
            this.db,
            `INSERT INTO generation_context(request_id,owner_id,ordinal,grant_id,grant_revision,fragment_enc,fragment_hmac,key_version) VALUES (?,?,?,?,?,?,?,?)`,
            id,
            plan.ownerId,
            i,
            x.grantId,
            x.grantRevision,
            PLACEHOLDER,
            x.fragmentHmac,
            plan.keyVersion,
          ),
        ),
        q(
          this.db,
          `INSERT INTO quota_reservations SELECT id,owner_id,${DAY},${MONTH},'held',expires_at FROM generation_requests WHERE id=? AND owner_id=?`,
          id,
          plan.ownerId,
        ),
        q(this.db, `INSERT INTO quota_events VALUES (?,?,'reserve',${DB_NOW})`, id, plan.ownerId),
        q(
          this.db,
          `INSERT INTO idempotency_keys VALUES (?,?,'synthetic.start',?,?,${DB_NOW},${DB_NOW}+604800000)`,
          plan.ownerId,
          plan.idempotencyKey,
          plan.payloadHmac,
          id,
        ),
        currentGuard(this.db, guardValues(h, 'prepared'), 'start'),
        ...this.event(plan.ownerId, id, 'prepared', 'QUEUED'),
        q(this.db, 'UPDATE accounts SET data_revision=data_revision+1 WHERE id=?', plan.ownerId),
      ]);
    } catch (error) {
      const raced = await this.existing(plan);
      if (raced) return raced;
      throw error;
    }
    return id;
  }
  async claim(ownerId: string, requestId: string): Promise<SyntheticLease | null> {
    const row = await this.owned(ownerId, requestId);
    const runEpoch = Number(row.run_epoch) + 1,
      leaseToken = crypto.randomUUID(),
      attemptId = crypto.randomUUID();
    try {
      await this.db.batch([
        q(
          this.db,
          `UPDATE generation_requests SET run_epoch=run_epoch+1,revision=revision+1,lease_token=?,lease_expires_at=${DB_NOW}+30000 WHERE owner_id=? AND id=? AND run_epoch=? AND run_epoch<3 AND state IN ('prepared','validating') AND (lease_expires_at IS NULL OR lease_expires_at<=${DB_NOW}) AND expires_at>${DB_NOW} AND next_run_at<=${DB_NOW}`,
          leaseToken,
          ownerId,
          requestId,
          runEpoch - 1,
        ),
        assertChanges(this.db, 1),
        q(
          this.db,
          `INSERT INTO generation_attempts(id,owner_id,request_id,run_epoch,lease_token,started_at) VALUES (?,?,?,?,?,${DB_NOW})`,
          attemptId,
          ownerId,
          requestId,
          runEpoch,
          leaseToken,
        ),
      ]);
    } catch {
      return null;
    }
    const stored = JSON.parse(String(row.plan_enc)) as { marker: string; plan: SyntheticPlan };
    if (stored.marker !== PLACEHOLDER) throw new Error('SYNTHETIC_PLAN_REQUIRED');
    return { ownerId, requestId, runEpoch, leaseToken, attemptId, plan: stored.plan };
  }
  async dispatch(h: SyntheticLease, payload: Uint8Array): Promise<WriterOutcome | null> {
    await this.owned(h.ownerId, h.requestId);
    const prior = await q(
      this.db,
      'SELECT id FROM provider_dispatches WHERE owner_id=? AND request_id=?',
      h.ownerId,
      h.requestId,
    ).first();
    if (prior) return null;
    await this.barriers.beforeDispatch?.();
    const dispatchId = crypto.randomUUID();
    try {
      await this.db.batch([
        q(
          this.db,
          `INSERT OR IGNORE INTO spend_buckets(period,ceiling_microusd) VALUES (${DAY},10000000),(${MONTH},100000000)`,
        ),
        q(
          this.db,
          `UPDATE spend_buckets SET committed_microusd=committed_microusd+40000 WHERE period IN (${DAY},${MONTH}) AND committed_microusd+40000<=ceiling_microusd`,
        ),
        assertChanges(this.db, 2),
        assertExists(
          this.db,
          "SELECT 1 WHERE (SELECT count(*) FROM provider_dispatches WHERE state='authorized')<10",
        ),
        ...this.fragments(h),
        q(
          this.db,
          `INSERT INTO provider_dispatches(id,owner_id,request_id,attempt_id,state,provider,requested_model,transmission_enc,transmission_hmac,key_version,prompt_hash,validator_hash,content_hash,parameters_json,authorized_at) VALUES (?,?,?,?,'authorized','openai','gpt-5.6-terra',?,?,?,?,?,?,?,${DB_NOW})`,
          dispatchId,
          h.ownerId,
          h.requestId,
          h.attemptId,
          PLACEHOLDER,
          h.plan.planHmac,
          h.plan.keyVersion,
          h.plan.planHmac,
          h.plan.planHmac,
          h.plan.contentHash,
          JSON.stringify({
            syntheticOnly: true,
            store: false,
            max_output_tokens: 1600,
            reasoning: 'none',
          }),
        ),
        q(
          this.db,
          `INSERT INTO cost_reservations(id,owner_id,dispatch_id,day_period,month_period,state,reserved_microusd,price_basis_json,created_at) VALUES (?,?,?,${DAY},${MONTH},'reserved',40000,'{"syntheticOnly":true}',${DB_NOW})`,
          crypto.randomUUID(),
          h.ownerId,
          dispatchId,
        ),
        currentGuard(this.db, guardValues(h, 'prepared'), 'dispatch'),
        q(
          this.db,
          `UPDATE generation_requests SET state='dispatching',revision=revision+1 WHERE id=? AND owner_id=? AND run_epoch=? AND lease_token=? AND state='prepared' AND lease_expires_at>=${DB_NOW}+21000 AND expires_at>=${DB_NOW}+21000`,
          h.requestId,
          h.ownerId,
          h.runEpoch,
          h.leaseToken,
        ),
        assertChanges(this.db, 1),
        ...this.event(h.ownerId, h.requestId, 'dispatching', 'WRITING'),
      ]);
    } catch (error) {
      // Unknown/duplicate authorization acknowledgements MUST NOT resend.
      if (
        await q(
          this.db,
          'SELECT id FROM provider_dispatches WHERE owner_id=? AND request_id=?',
          h.ownerId,
          h.requestId,
        ).first()
      )
        return null;
      throw error;
    }
    let outcome: WriterOutcome;
    try {
      outcome = await this.writer.write({
        dispatchId,
        model: 'gpt-5.6-terra',
        payload,
        timeoutMs: 18000,
        maxOutputTokens: 1600,
        store: false,
        reasoning: 'none',
        signal: AbortSignal.timeout(18000),
      });
    } catch {
      outcome = { kind: 'uncertain', reason: 'network' };
    }
    await this.barriers.beforeReceipt?.();
    if (outcome.kind !== 'candidate') {
      await this.db.batch([
        q(
          this.db,
          "UPDATE provider_dispatches SET state='unknown' WHERE id=? AND owner_id=?",
          dispatchId,
          h.ownerId,
        ),
        q(
          this.db,
          `UPDATE cost_reservations SET state='unknown',settled_at=${DB_NOW} WHERE dispatch_id=?`,
          dispatchId,
        ),
      ]);
      await this.terminalize(h.ownerId, h.requestId, 'failed');
      return outcome;
    }
    await this.settleUsage(dispatchId, outcome);
    // Placeholder persistence deliberately never serializes the private candidate.
    await this.db.batch([
      q(
        this.db,
        `UPDATE provider_dispatches SET state='received',candidate_enc=?,returned_model=?,input_tokens=?,output_tokens=?,duration_ms=?,received_at=${DB_NOW} WHERE id=? AND owner_id=?`,
        PLACEHOLDER,
        outcome.returnedModel,
        outcome.inputTokens,
        outcome.outputTokens,
        outcome.durationMs,
        dispatchId,
        h.ownerId,
      ),
      q(
        this.db,
        `UPDATE generation_requests SET state='validating',revision=revision+1 WHERE id=? AND owner_id=? AND state='dispatching' AND run_epoch=? AND lease_token=? AND lease_expires_at>${DB_NOW} AND expires_at>${DB_NOW}`,
        h.requestId,
        h.ownerId,
        h.runEpoch,
        h.leaseToken,
      ),
      assertChanges(this.db, 1),
      ...this.event(h.ownerId, h.requestId, 'validating', 'CHECKING'),
    ]);
    return outcome;
  }
  async publish(h: SyntheticLease): Promise<string> {
    const row = await this.owned(h.ownerId, h.requestId);
    if (row.state === 'published') {
      const edition = await q(
        this.db,
        'SELECT id FROM reading_editions WHERE owner_id=? AND request_id=?',
        h.ownerId,
        h.requestId,
      ).first<{ id: string }>();
      if (!edition) throw new Error('MISSING_EDITION');
      return edition.id;
    }
    await this.barriers.beforePublication?.();
    const editionId = crypto.randomUUID();
    try {
      await this.db.batch([
        ...this.fragments(h),
        q(
          this.db,
          `INSERT INTO reading_editions(id,owner_id,session_id,edition_number,request_id,basis_id,parent_edition_id,status,mode,body_enc,key_version,content_hash,accepted_at) SELECT ?,r.owner_id,r.session_id,(SELECT coalesce(max(edition_number),0)+1 FROM reading_editions e WHERE e.owner_id=r.owner_id AND e.session_id=r.session_id),r.id,r.basis_id,r.parent_edition_id,'accepted','model',?,r.key_version,r.content_hash,${DB_NOW} FROM generation_requests r WHERE r.id=? AND r.owner_id=?`,
          editionId,
          PLACEHOLDER,
          h.requestId,
          h.ownerId,
        ),
        assertChanges(this.db, 1),
        q(
          this.db,
          "UPDATE quota_reservations SET state='consumed' WHERE request_id=? AND owner_id=? AND state='held'",
          h.requestId,
          h.ownerId,
        ),
        assertChanges(this.db, 1),
        q(
          this.db,
          `UPDATE quota_buckets SET held=held-1,consumed=consumed+1 WHERE owner_id=? AND period IN (SELECT day_period FROM quota_reservations WHERE owner_id=? AND request_id=? UNION SELECT month_period FROM quota_reservations WHERE owner_id=? AND request_id=?)`,
          h.ownerId,
          h.ownerId,
          h.requestId,
          h.ownerId,
          h.requestId,
        ),
        assertChanges(this.db, 2),
        q(
          this.db,
          `INSERT INTO quota_events VALUES (?,?,'consume',${DB_NOW})`,
          h.requestId,
          h.ownerId,
        ),
        currentGuard(this.db, guardValues(h, 'validating'), 'publish'),
        q(
          this.db,
          `UPDATE generation_requests SET state='published',finished_at=${DB_NOW},lease_token=NULL,lease_expires_at=NULL,revision=revision+1 WHERE id=? AND owner_id=? AND state='validating' AND run_epoch=? AND lease_token=? AND lease_expires_at>${DB_NOW} AND expires_at>${DB_NOW}`,
          h.requestId,
          h.ownerId,
          h.runEpoch,
          h.leaseToken,
        ),
        assertChanges(this.db, 1),
        ...this.event(h.ownerId, h.requestId, 'published', 'ACCEPTED', editionId),
        q(this.db, 'UPDATE accounts SET data_revision=data_revision+1 WHERE id=?', h.ownerId),
        q(
          this.db,
          `UPDATE generation_attempts SET outcome='complete',finished_at=${DB_NOW} WHERE owner_id=? AND id=?`,
          h.ownerId,
          h.attemptId,
        ),
      ]);
    } catch (error) {
      // A lost acknowledgement or concurrent publication resolves by identity.
      const committed = await q(
        this.db,
        "SELECT e.id FROM reading_editions e JOIN generation_requests r ON r.id=e.request_id AND r.owner_id=e.owner_id WHERE r.owner_id=? AND r.id=? AND r.state='published'",
        h.ownerId,
        h.requestId,
      ).first<{ id: string }>();
      if (committed) return committed.id;
      throw error;
    }
    return editionId;
  }
  private async settleUsage(
    dispatchId: string,
    outcome: Extract<WriterOutcome, { kind: 'candidate' }>,
  ): Promise<void> {
    const actual = outcome.inputTokens * 2 + outcome.outputTokens * 12;
    if (
      !Number.isSafeInteger(actual) ||
      actual < 0 ||
      !Number.isSafeInteger(outcome.inputTokens) ||
      outcome.inputTokens < 0 ||
      !Number.isSafeInteger(outcome.outputTokens) ||
      outcome.outputTokens < 0
    )
      throw new Error('INVALID_USAGE');
    const cost = await q(
      this.db,
      'SELECT id,state FROM cost_reservations WHERE dispatch_id=?',
      dispatchId,
    ).first<{ id: string; state: string }>();
    if (cost?.state !== 'reserved') return;
    await this.db.batch([
      q(
        this.db,
        `UPDATE cost_reservations SET state='actual',actual_microusd=?,settled_at=${DB_NOW} WHERE id=? AND state='reserved'`,
        actual,
        cost.id,
      ),
      assertChanges(this.db, 1),
      q(
        this.db,
        `UPDATE spend_buckets SET committed_microusd=min(ceiling_microusd,committed_microusd+?) WHERE period IN (SELECT day_period FROM cost_reservations WHERE id=? UNION SELECT month_period FROM cost_reservations WHERE id=?)`,
        actual - 40000,
        cost.id,
        cost.id,
      ),
      assertChanges(this.db, 2),
      q(
        this.db,
        `INSERT INTO cost_adjustments VALUES (?,?,40000,?,'usage',${DB_NOW})`,
        dispatchId,
        cost.id,
        actual,
      ),
      q(this.db, `UPDATE system_state SET generation_enabled=0 WHERE id=1 AND ?>40000`, actual),
    ]);
  }
  async terminalize(
    ownerId: string,
    requestId: string,
    state: 'blocked' | 'expired' | 'failed' | 'cancelled',
  ): Promise<void> {
    const row = await this.owned(ownerId, requestId);
    if (['published', 'blocked', 'expired', 'failed', 'cancelled'].includes(String(row.state)))
      return;
    try {
      await this.db.batch([
        q(
          this.db,
          `UPDATE generation_requests SET state=?,run_epoch=run_epoch+1,revision=revision+1,finished_at=${DB_NOW},lease_token=NULL,lease_expires_at=NULL,input_enc=NULL,plan_enc=NULL WHERE owner_id=? AND id=? AND state NOT IN (${TERMINAL})`,
          state,
          ownerId,
          requestId,
        ),
        assertChanges(this.db, 1),
        q(
          this.db,
          "UPDATE quota_reservations SET state='released' WHERE owner_id=? AND request_id=? AND state='held'",
          ownerId,
          requestId,
        ),
        assertChanges(this.db, 1),
        q(
          this.db,
          `UPDATE quota_buckets SET held=held-1 WHERE owner_id=? AND period IN (SELECT day_period FROM quota_reservations WHERE owner_id=? AND request_id=? UNION SELECT month_period FROM quota_reservations WHERE owner_id=? AND request_id=?)`,
          ownerId,
          ownerId,
          requestId,
          ownerId,
          requestId,
        ),
        assertChanges(this.db, 2),
        q(this.db, `INSERT INTO quota_events VALUES (?,?,'release',${DB_NOW})`, requestId, ownerId),
        q(
          this.db,
          'UPDATE generation_context SET fragment_enc=NULL WHERE owner_id=? AND request_id=?',
          ownerId,
          requestId,
        ),
        q(
          this.db,
          "UPDATE provider_dispatches SET state=CASE WHEN state='authorized' THEN 'unknown' ELSE state END,candidate_enc=NULL,transmission_enc=NULL WHERE owner_id=? AND request_id=?",
          ownerId,
          requestId,
        ),
        ...this.event(ownerId, requestId, state, 'STOPPED'),
      ]);
    } catch (error) {
      const current = await this.owned(ownerId, requestId);
      if (
        !['published', 'blocked', 'expired', 'failed', 'cancelled'].includes(String(current.state))
      )
        throw error;
    }
  }
}
