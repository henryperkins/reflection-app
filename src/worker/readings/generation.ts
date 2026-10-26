import type { z } from 'zod';
import {
  AcceptedReading,
  apiSchemas,
  ModelCandidate,
  type StartRequest,
} from '../../contracts/index.ts';
import { drawTarot } from '../../domain/tarot/draw.ts';
import { buildPlan, validateCandidateBindings } from '../../domain/tarot/plan.ts';
import { composeTemplate, projectWriterPayload } from '../../domain/tarot/render.ts';
import { sha256Json } from '../../domain/json.ts';
import { InterceptedWritingProvider } from '../provider/intercepted.ts';
import { assertion } from '../identity/checkpoint.ts';
import type { Session } from '../identity/types.ts';
import { statement as q, DB_NOW, DAY, MONTH } from '../db/statements.ts';
import { iso, type RecordBase, RecordError } from './base.ts';
import { encryptedBytes } from './crypto.ts';
import { syntheticBundle } from './local-content.ts';

/** Only instantiated behind the explicit localhost simulation switch. No fetch transport. */
export class LocalGeneration {
  constructor(readonly base: RecordBase) {}
  async maintenance() {
    const expired = await q(
      this.base.db,
      `SELECT id,owner_id,session_id FROM generation_requests WHERE state NOT IN ('published','blocked','failed','expired','cancelled') AND expires_at<=${DB_NOW} ORDER BY expires_at LIMIT 20`,
    ).all<{ id: string; owner_id: string; session_id: string }>();
    for (const row of expired.results)
      await this.base.db.batch([
        ...this.base.stopStatements(row.owner_id, row.session_id),
        q(
          this.base.db,
          "UPDATE generation_requests SET state='expired',error_code='EXPIRED' WHERE owner_id=? AND id=? AND state='blocked'",
          row.owner_id,
          row.id,
        ),
        q(
          this.base.db,
          'UPDATE accounts SET data_revision=data_revision+1 WHERE id=?',
          row.owner_id,
        ),
      ]);
  }
  async status(session: Session, id: string) {
    const row = await q(
      this.base.db,
      'SELECT r.*,e.id AS edition_id FROM generation_requests r LEFT JOIN reading_editions e ON e.request_id=r.id AND e.owner_id=r.owner_id WHERE r.owner_id=? AND r.id=?',
      session.subjectId,
      id,
    ).first<{
      id: string;
      session_id: string;
      state: string;
      revision: number;
      error_code: string | null;
      expires_at: number;
      edition_id: string | null;
    }>();
    if (!row) throw new RecordError(404, 'NOT_FOUND');
    await this.base.ownedSession(session, row.session_id);
    const events = await q(
      this.base.db,
      'SELECT sequence,created_at,state,code,edition_id,error_code FROM request_events WHERE owner_id=? AND request_id=? ORDER BY sequence LIMIT 20',
      session.subjectId,
      id,
    ).all<{
      sequence: number;
      created_at: number;
      state: string;
      code: string;
      edition_id: string | null;
      error_code: string | null;
    }>();
    await this.base.checked(session);
    return apiSchemas.RequestStatus.parse({
      requestId: id,
      sessionId: row.session_id,
      state: row.state,
      revision: row.revision,
      events: events.results.map((e) => ({
        sequence: e.sequence,
        at: iso(e.created_at),
        state: e.state,
        code: e.code,
        editionId: e.edition_id,
        errorCode: e.error_code,
      })),
      nextSequence: events.results.at(-1)?.sequence ?? 0,
      editionId: row.edition_id,
      errorCode: row.error_code,
      expiresAt: iso(row.expires_at),
    });
  }
  private guard(session: Session, permission: number, content: string) {
    return assertion(
      this.base.db,
      `EXISTS(SELECT 1 FROM accounts a JOIN permission_revisions p ON p.owner_id=a.id AND p.revision=a.permission_revision JOIN system_state sys ON sys.id=1 JOIN content_editions c ON c.hash=sys.active_content_hash WHERE a.id=? AND a.permission_revision=? AND p.model_allowed=1 AND a.recovery_ack_at IS NOT NULL AND a.key_version=1 AND sys.generation_enabled=1 AND sys.dispatch_mode='model' AND c.hash=? AND c.state='approved')`,
      session.subjectId,
      permission,
      content,
    );
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
  async start(session: Session, input: z.infer<typeof StartRequest>, key: string) {
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
      return this.reply(session, row.id, true);
    };
    const prior = await resolve();
    if (prior) return prior;
    const account = await this.base.account(session);
    if (!account.model_allowed) throw new RecordError(403, 'CONSENT_REQUIRED');
    if (!account.recovery_ack_at) throw new RecordError(403, 'FORBIDDEN');
    if (account.permission_revision !== input.permissionRevision)
      throw new RecordError(409, 'CONFLICT', account.permission_revision);
    const content = await syntheticBundle(),
      policyHash = await sha256Json({ localOnly: true, writer: 'simulation.v1' });
    await this.base.db.batch([
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
    const plan = await buildPlan({
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
      await this.base.atomic(
        session,
        [
          this.guard(session, input.permissionRevision, content.editionHash),
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
          q(
            this.base.db,
            `INSERT INTO request_events(request_id,owner_id,sequence,state,code,created_at) VALUES (?,?,1,'prepared','QUEUED',${DB_NOW})`,
            requestId,
            session.subjectId,
          ),
        ],
        encryptedBytes(question, basisEnc, inputEnc, planEnc) + 10 * 1024,
      );
    } catch (error) {
      const joined = await resolve();
      if (joined) return joined;
      const view = await this.base.identity.sessions.view(session);
      if (!view.permission.modelAllowed) throw new RecordError(403, 'CONSENT_REQUIRED');
      if (view.remainingDay === 0 || view.remainingMonth === 0)
        throw new RecordError(429, 'QUOTA_EXCEEDED');
      throw error;
    }
    // The simulated provider is deliberately invoked only after unique durable dispatch authorization.
    try {
      const template = await composeTemplate(plan),
        payload = await projectWriterPayload(plan);
      const candidate = ModelCandidate.parse({
        schemaVersion: 1,
        kind: 'tarot.interpretation.v1',
        units: template.units.map(({ basisText: _text, ...unit }) => unit),
        closing: template.closing,
      });
      const dispatchId = crypto.randomUUID(),
        attemptId = crypto.randomUUID(),
        lease = crypto.randomUUID();
      const transmission = await seal('provider_dispatches', 'transmission_enc', dispatchId, {
        v: 1,
        syntheticOnly: true,
        payload: new TextDecoder().decode(payload),
      });
      const transmissionHash = await this.base.crypt.hash(
        session.subjectId,
        'transmission',
        new TextDecoder().decode(payload),
      );
      await this.base.atomic(
        session,
        [
          this.guard(session, input.permissionRevision, content.editionHash),
          this.base.sessionGuard(session, sessionId),
          q(
            this.base.db,
            `UPDATE generation_requests SET state='dispatching',revision=revision+1,run_epoch=1,lease_token=?,lease_expires_at=${DB_NOW}+30000 WHERE owner_id=? AND id=? AND state='prepared' AND expires_at>${DB_NOW}`,
            lease,
            session.subjectId,
            requestId,
          ),
          assertion(this.base.db, 'changes()=1'),
          q(
            this.base.db,
            `INSERT INTO generation_attempts(id,owner_id,request_id,run_epoch,lease_token,started_at) VALUES (?,?,?,1,?,${DB_NOW})`,
            attemptId,
            session.subjectId,
            requestId,
            lease,
          ),
          q(
            this.base.db,
            `INSERT INTO provider_dispatches(id,owner_id,request_id,attempt_id,state,provider,requested_model,transmission_enc,transmission_hmac,key_version,prompt_hash,validator_hash,content_hash,parameters_json,authorized_at) VALUES (?,?,?,?,'authorized','openai','gpt-5.6-terra',?,?,1,?,?,?,'{"syntheticOnly":true,"externalCall":false}',${DB_NOW})`,
            dispatchId,
            session.subjectId,
            requestId,
            attemptId,
            transmission,
            transmissionHash,
            policyHash,
            policyHash,
            content.editionHash,
          ),
        ],
        encryptedBytes(transmission) + 2048,
      );
      const writer = new InterceptedWritingProvider({
        outcome: {
          kind: 'candidate',
          candidate,
          providerResponseId: null,
          returnedModel: 'synthetic-local-writer.v1',
          inputTokens: 0,
          outputTokens: 0,
          durationMs: 0,
        },
      });
      const outcome = await writer.write({
        dispatchId,
        model: 'gpt-5.6-terra',
        payload,
        timeoutMs: 18000,
        maxOutputTokens: 1600,
        store: false,
        reasoning: 'none',
        signal: AbortSignal.timeout(18000),
      });
      if (outcome.kind !== 'candidate') throw new Error('Local writer unavailable');
      validateCandidateBindings(plan, outcome.candidate);
      const editionId = crypto.randomUUID(),
        acceptedAt = Date.now();
      const reading = AcceptedReading.parse({
        kind: 'tarot.accepted.v1',
        editionId,
        sessionId,
        editionNumber: 1,
        parentEditionId: null,
        question: input.question,
        basis,
        mode: 'model',
        contentHash: content.editionHash,
        planHash,
        sources: plan.sources,
        units: template.units,
        closing: template.closing,
        acceptedAt: iso(acceptedAt),
        provenance: {
          requestId,
          dispatchId,
          provider: 'openai',
          requestedModel: 'gpt-5.6-terra',
          returnedModel: outcome.returnedModel,
          promptHash: policyHash,
          validatorHash: policyHash,
          policyHash,
          contentHash: content.editionHash,
          selected: [],
          transmissionHash,
          fallbackReason: null,
        },
      });
      const body = await seal('reading_editions', 'body_enc', editionId, reading),
        candidateEnc = await seal(
          'provider_dispatches',
          'candidate_enc',
          dispatchId,
          outcome.candidate,
        );
      await this.base.atomic(
        session,
        [
          this.guard(session, input.permissionRevision, content.editionHash),
          this.base.sessionGuard(session, sessionId),
          assertion(
            this.base.db,
            `EXISTS(SELECT 1 FROM generation_requests WHERE owner_id=? AND id=? AND state='dispatching' AND lease_token=? AND expires_at>${DB_NOW} AND lease_expires_at>${DB_NOW})`,
            session.subjectId,
            requestId,
            lease,
          ),
          q(
            this.base.db,
            `INSERT INTO reading_editions(id,owner_id,session_id,edition_number,request_id,basis_id,status,mode,body_enc,key_version,content_hash,accepted_at) VALUES (?,?,?,1,?,?,'accepted','model',?,1,?,?)`,
            editionId,
            session.subjectId,
            sessionId,
            requestId,
            basisId,
            body,
            content.editionHash,
            acceptedAt,
          ),
          q(
            this.base.db,
            "UPDATE quota_reservations SET state='consumed' WHERE owner_id=? AND request_id=? AND state='held'",
            session.subjectId,
            requestId,
          ),
          assertion(this.base.db, 'changes()=1'),
          q(
            this.base.db,
            'UPDATE quota_buckets SET held=held-1,consumed=consumed+1 WHERE owner_id=? AND period IN (SELECT day_period FROM quota_reservations WHERE request_id=? UNION SELECT month_period FROM quota_reservations WHERE request_id=?)',
            session.subjectId,
            requestId,
            requestId,
          ),
          assertion(this.base.db, 'changes()=2'),
          q(
            this.base.db,
            `INSERT INTO quota_events VALUES (?,?,'consume',${DB_NOW})`,
            requestId,
            session.subjectId,
          ),
          q(
            this.base.db,
            `UPDATE provider_dispatches SET state='received',candidate_enc=?,returned_model='synthetic-local-writer.v1',input_tokens=0,output_tokens=0,duration_ms=0,received_at=${DB_NOW} WHERE owner_id=? AND id=?`,
            candidateEnc,
            session.subjectId,
            dispatchId,
          ),
          q(
            this.base.db,
            `UPDATE generation_requests SET state='published',revision=revision+1,lease_token=NULL,lease_expires_at=NULL,finished_at=${DB_NOW} WHERE owner_id=? AND id=?`,
            session.subjectId,
            requestId,
          ),
          q(
            this.base.db,
            `UPDATE generation_attempts SET outcome='complete',finished_at=${DB_NOW} WHERE owner_id=? AND id=?`,
            session.subjectId,
            attemptId,
          ),
          q(
            this.base.db,
            `INSERT INTO request_events(request_id,owner_id,sequence,state,code,edition_id,created_at) VALUES (?,?,2,'published','ACCEPTED',?,${DB_NOW})`,
            requestId,
            session.subjectId,
            editionId,
          ),
        ],
        encryptedBytes(body, candidateEnc) + 3072,
      );
    } catch {
      // Never redispatch an authorized simulation on retry; keep a recoverable terminal status.
      await this.base.db.batch([
        ...this.base.stopStatements(session.subjectId, sessionId),
        q(
          this.base.db,
          'UPDATE accounts SET data_revision=data_revision+1 WHERE id=?',
          session.subjectId,
        ),
      ]);
    }
    return this.reply(session, requestId, false);
  }
}
