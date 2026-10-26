-- Proposed v1 DDL. Apply with foreign_keys=ON; D1 enforces foreign keys.
-- Authoritative table/column classifications: COLUMN_REGISTRY.json and DATA_LIFECYCLE.md.
-- IDs: UUIDv4 TEXT at service boundary (credential IDs/token hashes excepted).
-- Timestamps: UTC epoch milliseconds INTEGER, caller supplied from trusted server clock.
-- *_enc: versioned AES-GCM envelope serialized as JSON TEXT, never queryable plaintext.
-- No client-supplied owner_id is trusted. Every owner relation uses a composite FK.
PRAGMA foreign_keys = ON;

CREATE TABLE assertion_probe (ok INTEGER NOT NULL CHECK(ok = 1));
-- An assertion inserts 0 only when a predicate is false. Never store successful rows.
CREATE TABLE content_editions (
  hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash)=64),
  state TEXT NOT NULL CHECK(state IN ('staged','approved','superseded','withdrawn')),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK(policy_revision>0),
  bundle_json TEXT NOT NULL CHECK(json_valid(bundle_json)),
  reviewed_hash TEXT, reviewer_kind TEXT NOT NULL CHECK(reviewer_kind IN ('unreviewed','agent_reviewed','human_approved')),
  reviewer_id TEXT, rights_status TEXT NOT NULL CHECK(rights_status IN ('cleared','unknown','disallowed')),
  created_at INTEGER NOT NULL, approved_at INTEGER, withdrawn_at INTEGER,
  CHECK(reviewed_hash IS NULL OR reviewed_hash=hash),
  CHECK(state NOT IN ('approved','superseded') OR
    (reviewer_kind='human_approved' AND reviewer_id IS NOT NULL AND reviewed_hash IS NOT NULL AND reviewed_hash=hash AND rights_status='cleared' AND approved_at IS NOT NULL))
);
CREATE TABLE system_state (
  id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL DEFAULT 1,
  active_content_hash TEXT REFERENCES content_editions(hash), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  generation_enabled INTEGER NOT NULL DEFAULT 0 CHECK(generation_enabled IN (0,1)),
  dispatch_mode TEXT NOT NULL DEFAULT 'off' CHECK(dispatch_mode IN('off','model','outage_template')),
  provider_policy_hash TEXT NOT NULL CHECK(length(provider_policy_hash)=64),
  updated_at INTEGER NOT NULL
);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','frozen','deleting')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
  data_revision INTEGER NOT NULL DEFAULT 1 CHECK(data_revision>0),
  auth_epoch INTEGER NOT NULL DEFAULT 1 CHECK(auth_epoch>0),
  permission_revision INTEGER NOT NULL DEFAULT 1 CHECK(permission_revision>0),
  key_version INTEGER NOT NULL DEFAULT 1 CHECK(key_version>0),
  write_fence TEXT, recovery_handle_hash TEXT NOT NULL UNIQUE, recovery_ack_at INTEGER,
  storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK(storage_bytes>=0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE account_keys (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK(version>0), wrap_key_id TEXT NOT NULL, wrapped_key_enc TEXT NOT NULL,
  wrapped_index_key_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL, PRIMARY KEY(owner_id,version)
);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  public_key BLOB NOT NULL, sign_count INTEGER NOT NULL DEFAULT 0 CHECK(sign_count>=0),
  backed_up INTEGER NOT NULL CHECK(backed_up IN(0,1)),
  transports_json TEXT NOT NULL CHECK(json_valid(transports_json)), created_at INTEGER NOT NULL,
  UNIQUE(owner_id,id)
);
CREATE INDEX credentials_owner ON credentials(owner_id);
CREATE TABLE recovery_codes (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,code_hash)
);
CREATE TABLE auth_challenges (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK(purpose IN('register','authenticate','reauthenticate','add','recover')),
  challenge_hash TEXT NOT NULL UNIQUE, browser_hash TEXT NOT NULL, auth_epoch INTEGER,
  expires_at INTEGER NOT NULL, consumed_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX auth_challenges_expiry ON auth_challenges(expires_at);
CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  csrf_hash TEXT NOT NULL, auth_epoch INTEGER NOT NULL, authenticated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, idle_expires_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  CHECK(expires_at>=created_at), CHECK(idle_expires_at<=expires_at)
);
CREATE INDEX auth_sessions_owner ON auth_sessions(owner_id);
CREATE INDEX auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE permission_revisions (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>0), model_allowed INTEGER NOT NULL CHECK(model_allowed IN(0,1)),
  policy_version TEXT NOT NULL CHECK(policy_version='egress.v1'), created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_id,revision)
);
CREATE TABLE reading_sessions (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','saved','deleted')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), question_enc TEXT,
  created_at INTEGER NOT NULL, saved_at INTEGER, deleted_at INTEGER, retention_expires_at INTEGER,
  UNIQUE(owner_id,id), CHECK(status='deleted' OR question_enc IS NOT NULL),
  CHECK((status='saved')=(saved_at IS NOT NULL)),
  CHECK((status='deleted')=(deleted_at IS NOT NULL)),
  CHECK(status!='open' OR retention_expires_at IS NOT NULL)
);
CREATE INDEX reading_sessions_history ON reading_sessions(owner_id,status,created_at DESC,id DESC);
CREATE INDEX reading_sessions_retention ON reading_sessions(status,retention_expires_at);
CREATE TABLE basis_snapshots (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, session_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind='tarot.v1'), schema_version INTEGER NOT NULL CHECK(schema_version=1),
  body_enc TEXT, key_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(owner_id,id), UNIQUE(owner_id,id,session_id), UNIQUE(owner_id,session_id),
  FOREIGN KEY(owner_id,session_id) REFERENCES reading_sessions(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version)
);
CREATE TABLE generation_requests (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, session_id TEXT NOT NULL, client_intent_id TEXT NOT NULL,
  parent_edition_id TEXT, basis_id TEXT, operation TEXT NOT NULL CHECK(operation IN('initial','followup')),
  payload_hmac TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN('reserved','prepared','dispatching','received',
    'validating','fallback_pending','published','cancelled','expired','blocked','failed','uncertain')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), run_epoch INTEGER NOT NULL DEFAULT 0 CHECK(run_epoch>=0),
  lease_token TEXT, lease_expires_at INTEGER, next_run_at INTEGER NOT NULL,
  permission_revision INTEGER NOT NULL, key_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL REFERENCES content_editions(hash), content_policy_revision INTEGER NOT NULL,
  policy_hash TEXT NOT NULL, input_enc TEXT, plan_enc TEXT, plan_hmac TEXT,
  context_count INTEGER NOT NULL DEFAULT 0 CHECK(context_count BETWEEN 0 AND 3),
  next_event INTEGER NOT NULL DEFAULT 1 CHECK(next_event>0),
  error_code TEXT, fallback_reason TEXT CHECK(fallback_reason IN('OUTAGE','MALFORMED','VALIDATION','TIMEOUT_UNKNOWN')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, finished_at INTEGER,
  UNIQUE(owner_id,id), UNIQUE(owner_id,client_intent_id),
  FOREIGN KEY(owner_id,session_id) REFERENCES reading_sessions(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,basis_id,session_id) REFERENCES basis_snapshots(owner_id,id,session_id),
  FOREIGN KEY(owner_id,parent_edition_id) REFERENCES reading_editions(owner_id,id),
  FOREIGN KEY(owner_id,permission_revision) REFERENCES permission_revisions(owner_id,revision),
  FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version),
  CHECK((operation='initial' AND parent_edition_id IS NULL) OR (operation='followup' AND parent_edition_id IS NOT NULL)),
  CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)), CHECK(expires_at>created_at)
);
CREATE INDEX generation_due ON generation_requests(state,next_run_at,lease_expires_at);
CREATE INDEX generation_owner ON generation_requests(owner_id,created_at DESC,id DESC);
CREATE TABLE reading_editions (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, session_id TEXT NOT NULL, edition_number INTEGER NOT NULL CHECK(edition_number>0),
  request_id TEXT UNIQUE, basis_id TEXT, parent_edition_id TEXT,
  status TEXT NOT NULL CHECK(status IN('accepted','imported','withdrawn','deleted')),
  mode TEXT NOT NULL CHECK(mode IN('model','template','legacy')),
  body_enc TEXT, key_version INTEGER NOT NULL, content_hash TEXT REFERENCES content_editions(hash),
  accepted_at INTEGER NOT NULL, invalidated_at INTEGER,
  UNIQUE(owner_id,id), UNIQUE(owner_id,session_id,edition_number),
  FOREIGN KEY(owner_id,session_id) REFERENCES reading_sessions(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,request_id) REFERENCES generation_requests(owner_id,id),
  FOREIGN KEY(owner_id,basis_id,session_id) REFERENCES basis_snapshots(owner_id,id,session_id),
  FOREIGN KEY(owner_id,parent_edition_id) REFERENCES reading_editions(owner_id,id),
  FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version),
  CHECK(status IN('withdrawn','deleted') OR body_enc IS NOT NULL),
  CHECK((status IN('withdrawn','deleted'))=(invalidated_at IS NOT NULL)),
  CHECK((mode='legacy' AND request_id IS NULL) OR (mode IN('model','template') AND request_id IS NOT NULL AND basis_id IS NOT NULL AND content_hash IS NOT NULL))
);
CREATE INDEX editions_session ON reading_editions(owner_id,session_id,edition_number);
CREATE TABLE reflections (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, session_id TEXT NOT NULL, edition_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 1 CHECK(current_revision>0), deleted_at INTEGER,
  UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,session_id) REFERENCES reading_sessions(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,edition_id) REFERENCES reading_editions(owner_id,id)
);
CREATE INDEX reflections_session ON reflections(owner_id,session_id,id);
CREATE TABLE reflection_revisions (
  reflection_id TEXT NOT NULL, owner_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  body_enc TEXT, key_version INTEGER NOT NULL, created_at INTEGER NOT NULL, erased_at INTEGER,
  PRIMARY KEY(reflection_id,revision), UNIQUE(owner_id,reflection_id,revision),
  FOREIGN KEY(owner_id,reflection_id) REFERENCES reflections(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version),
  CHECK(body_enc IS NOT NULL OR erased_at IS NOT NULL)
);
CREATE TABLE context_grants (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  edition_id TEXT, reflection_id TEXT, reflection_revision INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0), state TEXT NOT NULL CHECK(state IN('allowed','revoked')),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,edition_id) REFERENCES reading_editions(owner_id,id),
  FOREIGN KEY(owner_id,reflection_id,reflection_revision) REFERENCES reflection_revisions(owner_id,reflection_id,revision),
  CHECK((edition_id IS NOT NULL AND reflection_id IS NULL AND reflection_revision IS NULL) OR
    (edition_id IS NULL AND reflection_id IS NOT NULL AND reflection_revision IS NOT NULL))
);
CREATE INDEX grants_edition ON context_grants(owner_id,edition_id,state);
CREATE INDEX grants_reflection ON context_grants(owner_id,reflection_id,reflection_revision,state);
CREATE TABLE generation_context (
  request_id TEXT NOT NULL, owner_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal BETWEEN 0 AND 2),
  grant_id TEXT NOT NULL, grant_revision INTEGER NOT NULL, fragment_enc TEXT, fragment_hmac TEXT NOT NULL, key_version INTEGER NOT NULL,
  PRIMARY KEY(request_id,ordinal), UNIQUE(request_id,grant_id),
  FOREIGN KEY(owner_id,request_id) REFERENCES generation_requests(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,grant_id) REFERENCES context_grants(owner_id,id),
  FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version)
);
CREATE INDEX context_grant_requests ON generation_context(owner_id,grant_id,request_id);
CREATE TABLE generation_attempts (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, request_id TEXT NOT NULL, run_epoch INTEGER NOT NULL CHECK(run_epoch BETWEEN 1 AND 3),
  lease_token TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
  outcome TEXT CHECK(outcome IN('complete','stale','crashed','blocked','uncertain')),
  UNIQUE(request_id,run_epoch), UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,request_id) REFERENCES generation_requests(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE provider_dispatches (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('authorized','received','rejected','unknown')),
  provider TEXT NOT NULL CHECK(provider='openai'), requested_model TEXT NOT NULL CHECK(requested_model='gpt-5.6-terra'),
  returned_model TEXT, provider_response_id_enc TEXT, transmission_enc TEXT, transmission_hmac TEXT NOT NULL,
  candidate_enc TEXT, key_version INTEGER NOT NULL, prompt_hash TEXT NOT NULL, validator_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES content_editions(hash), parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
  input_tokens INTEGER CHECK(input_tokens>=0), output_tokens INTEGER CHECK(output_tokens>=0),
  duration_ms INTEGER CHECK(duration_ms>=0), authorized_at INTEGER NOT NULL, received_at INTEGER,
  FOREIGN KEY(owner_id,request_id) REFERENCES generation_requests(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,attempt_id) REFERENCES generation_attempts(owner_id,id),
  FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version), UNIQUE(owner_id,id)
);
CREATE TABLE quota_buckets (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period TEXT NOT NULL, allowance INTEGER NOT NULL CHECK(allowance>=0),
  held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0), consumed INTEGER NOT NULL DEFAULT 0 CHECK(consumed>=0),
  PRIMARY KEY(owner_id,period), CHECK(held+consumed<=allowance)
);
CREATE TABLE quota_reservations (
  request_id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, day_period TEXT NOT NULL, month_period TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('held','consumed','released')), expires_at INTEGER NOT NULL,
  FOREIGN KEY(owner_id,request_id) REFERENCES generation_requests(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,day_period) REFERENCES quota_buckets(owner_id,period),
  FOREIGN KEY(owner_id,month_period) REFERENCES quota_buckets(owner_id,period)
);
CREATE TABLE quota_events (
  request_id TEXT NOT NULL, owner_id TEXT NOT NULL, event TEXT NOT NULL CHECK(event IN('reserve','consume','release')),
  created_at INTEGER NOT NULL, PRIMARY KEY(request_id,event),
  FOREIGN KEY(owner_id,request_id) REFERENCES generation_requests(owner_id,id) ON DELETE CASCADE
);
CREATE TABLE spend_buckets (
  period TEXT PRIMARY KEY NOT NULL, ceiling_microusd INTEGER NOT NULL CHECK(ceiling_microusd>=0),
  committed_microusd INTEGER NOT NULL DEFAULT 0 CHECK(committed_microusd>=0),
  CHECK(committed_microusd<=ceiling_microusd)
);
CREATE TABLE cost_reservations (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  dispatch_id TEXT UNIQUE, day_period TEXT NOT NULL REFERENCES spend_buckets(period),
  month_period TEXT NOT NULL REFERENCES spend_buckets(period),
  state TEXT NOT NULL CHECK(state IN('reserved','actual','unknown')),
  reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>=0),
  actual_microusd INTEGER CHECK(actual_microusd>=0), price_basis_json TEXT NOT NULL CHECK(json_valid(price_basis_json)),
  created_at INTEGER NOT NULL, settled_at INTEGER
); -- dispatch_id is detached (set NULL) on account erasure; costs remain aggregate, never refunded as product quota.
CREATE INDEX cost_reconcile ON cost_reservations(state,created_at);
CREATE TABLE cost_adjustments (
  idempotency_key TEXT PRIMARY KEY NOT NULL, cost_id TEXT NOT NULL REFERENCES cost_reservations(id) ON DELETE CASCADE,
  before_microusd INTEGER NOT NULL CHECK(before_microusd>=0), after_microusd INTEGER NOT NULL CHECK(after_microusd>=0),
  reason TEXT NOT NULL CHECK(reason IN('usage','reconciliation','price_correction')), created_at INTEGER NOT NULL
);
CREATE TABLE request_events (
  request_id TEXT NOT NULL, owner_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0),
  state TEXT NOT NULL, code TEXT NOT NULL CHECK(code IN('QUEUED','PREPARING','WRITING','CHECKING','USING_TEMPLATE','ACCEPTED','STOPPED')),
  edition_id TEXT, error_code TEXT, created_at INTEGER NOT NULL, PRIMARY KEY(request_id,sequence),
  FOREIGN KEY(owner_id,request_id) REFERENCES generation_requests(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,edition_id) REFERENCES reading_editions(owner_id,id)
);
CREATE TABLE idempotency_keys (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, key_hash TEXT NOT NULL,
  operation TEXT NOT NULL, payload_hmac TEXT NOT NULL, resource_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, PRIMARY KEY(owner_id,key_hash)
); -- resource_id is a typed operation result reference, not an ownership bypass; always reauthorize resolution.
CREATE INDEX idempotency_expiry ON idempotency_keys(expires_at);
CREATE TABLE revisits (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, edition_id TEXT NOT NULL, note_enc TEXT NOT NULL,
  key_version INTEGER NOT NULL, created_at INTEGER NOT NULL, UNIQUE(owner_id,id),
  FOREIGN KEY(owner_id,edition_id) REFERENCES reading_editions(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version)
);
CREATE INDEX revisits_history ON revisits(owner_id,created_at DESC,id DESC);
CREATE TABLE export_tickets (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  snapshot_revision INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  UNIQUE(owner_id,id)
);
CREATE INDEX export_expiry ON export_tickets(expires_at);
CREATE TABLE import_batches (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_format TEXT NOT NULL, document_hmac TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('preview','committing','complete','expired')),
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, UNIQUE(owner_id,id)
);
CREATE INDEX import_expiry ON import_batches(state,expires_at);
CREATE TABLE import_items (
  batch_id TEXT NOT NULL, owner_id TEXT NOT NULL, item_index INTEGER NOT NULL CHECK(item_index BETWEEN 0 AND 99),
  source_key_hmac TEXT NOT NULL, original_hmac TEXT NOT NULL, body_enc TEXT,
  key_version INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN('ready','duplicate','conflict','invalid','imported','failed')),
  session_id TEXT, error_code TEXT, PRIMARY KEY(batch_id,item_index),
  FOREIGN KEY(owner_id,batch_id) REFERENCES import_batches(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,session_id) REFERENCES reading_sessions(owner_id,id),
  FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version)
);
CREATE TABLE import_identities (
  owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_key_hmac TEXT NOT NULL, source_entity_hmac TEXT NOT NULL, original_hmac TEXT NOT NULL, session_id TEXT,
  entity_kind TEXT NOT NULL CHECK(entity_kind IN('session','edition','reflection_revision','revisit','receipt','permission','grant')),
  edition_id TEXT, reflection_id TEXT, reflection_revision INTEGER, revisit_id TEXT,
  source_record_enc TEXT, key_version INTEGER NOT NULL, erased_at INTEGER,
  PRIMARY KEY(owner_id,source_key_hmac),
  FOREIGN KEY(owner_id,session_id) REFERENCES reading_sessions(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,edition_id) REFERENCES reading_editions(owner_id,id),
  FOREIGN KEY(owner_id,reflection_id,reflection_revision) REFERENCES reflection_revisions(owner_id,reflection_id,revision),
  FOREIGN KEY(owner_id,revisit_id) REFERENCES revisits(owner_id,id),
  FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version),
  CHECK(erased_at IS NOT NULL OR entity_kind NOT IN('session','edition','reflection_revision','revisit') OR session_id IS NOT NULL),
  CHECK(erased_at IS NOT NULL OR (entity_kind='edition')=(edition_id IS NOT NULL)),
  CHECK(erased_at IS NOT NULL OR (entity_kind='reflection_revision' AND reflection_id IS NOT NULL AND reflection_revision IS NOT NULL) OR
    (entity_kind!='reflection_revision' AND reflection_id IS NULL AND reflection_revision IS NULL)),
  CHECK(erased_at IS NOT NULL OR (entity_kind='revisit')=(revisit_id IS NOT NULL)),
  CHECK(erased_at IS NULL OR (source_record_enc IS NULL AND session_id IS NULL AND edition_id IS NULL
    AND reflection_id IS NULL AND reflection_revision IS NULL AND revisit_id IS NULL))
);
CREATE INDEX import_erased_identity ON import_identities(owner_id,source_entity_hmac,erased_at);
CREATE TABLE deletion_jobs (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK(scope IN('account','session','reflection_revision','context_copy')),
  target_hmac TEXT NOT NULL, target_enc TEXT, receipt_token_hash TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN('fencing','ledger_pending','erasing','complete')),
  ledger_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_run_at INTEGER NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER, backup_expires_by INTEGER
);
CREATE INDEX deletion_due ON deletion_jobs(state,next_run_at);
CREATE TABLE security_operations (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  epoch INTEGER NOT NULL CHECK(epoch>0), state TEXT NOT NULL CHECK(state IN('fenced','ledgered','applied')),
  snapshot_enc TEXT NOT NULL, ledger_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, next_run_at INTEGER NOT NULL, applied_at INTEGER,
  UNIQUE(owner_id,epoch)
); -- encrypted with independent recovery KEK; no account DEK or raw bearer secrets in snapshot.
CREATE INDEX security_due ON security_operations(state,next_run_at);
CREATE TABLE rate_buckets (
  scope_hash TEXT NOT NULL, window_start INTEGER NOT NULL, count INTEGER NOT NULL CHECK(count>=0),
  expires_at INTEGER NOT NULL, PRIMARY KEY(scope_hash,window_start)
);
CREATE INDEX rate_expiry ON rate_buckets(expires_at);

-- Persistent offline state complements the operator's synthetic-local runtime fence.
ALTER TABLE system_state ADD COLUMN restore_in_progress INTEGER NOT NULL DEFAULT 0 CHECK(restore_in_progress IN (0,1));

-- Exact account admission estimate: encrypted UTF-8 bytes plus 1 KiB per owned row.
-- Forward expansion; backfill existing counters before installing transactional deltas.
UPDATE accounts SET storage_bytes=1024+
  coalesce((SELECT sum(1024+coalesce(length(CAST(account_keys."wrapped_key_enc" AS BLOB)),0)+coalesce(length(CAST(account_keys."wrapped_index_key_enc" AS BLOB)),0)) FROM "account_keys" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "auth_challenges" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "auth_sessions" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(basis_snapshots."body_enc" AS BLOB)),0)) FROM "basis_snapshots" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "context_grants" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "cost_reservations" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "credentials" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(deletion_jobs."target_enc" AS BLOB)),0)) FROM "deletion_jobs" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "export_tickets" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "generation_attempts" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(generation_context."fragment_enc" AS BLOB)),0)) FROM "generation_context" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(generation_requests."input_enc" AS BLOB)),0)+coalesce(length(CAST(generation_requests."plan_enc" AS BLOB)),0)) FROM "generation_requests" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "idempotency_keys" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "import_batches" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(import_identities."source_record_enc" AS BLOB)),0)) FROM "import_identities" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(import_items."body_enc" AS BLOB)),0)) FROM "import_items" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "permission_revisions" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(provider_dispatches."provider_response_id_enc" AS BLOB)),0)+coalesce(length(CAST(provider_dispatches."transmission_enc" AS BLOB)),0)+coalesce(length(CAST(provider_dispatches."candidate_enc" AS BLOB)),0)) FROM "provider_dispatches" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "quota_buckets" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "quota_events" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "quota_reservations" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(reading_editions."body_enc" AS BLOB)),0)) FROM "reading_editions" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(reading_sessions."question_enc" AS BLOB)),0)) FROM "reading_sessions" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "recovery_codes" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(reflection_revisions."body_enc" AS BLOB)),0)) FROM "reflection_revisions" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "reflections" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024) FROM "request_events" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(revisits."note_enc" AS BLOB)),0)) FROM "revisits" WHERE owner_id=accounts.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(security_operations."snapshot_enc" AS BLOB)),0)) FROM "security_operations" WHERE owner_id=accounts.id),0)+
  1024*(SELECT count(*) FROM cost_adjustments a JOIN cost_reservations c ON c.id=a.cost_id WHERE c.owner_id=accounts.id);

CREATE TRIGGER storage_accounts_insert AFTER INSERT ON accounts BEGIN
  UPDATE accounts SET storage_bytes=1024+
  coalesce((SELECT sum(1024+coalesce(length(CAST(account_keys."wrapped_key_enc" AS BLOB)),0)+coalesce(length(CAST(account_keys."wrapped_index_key_enc" AS BLOB)),0)) FROM "account_keys" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "auth_challenges" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "auth_sessions" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(basis_snapshots."body_enc" AS BLOB)),0)) FROM "basis_snapshots" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "context_grants" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "cost_reservations" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "credentials" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(deletion_jobs."target_enc" AS BLOB)),0)) FROM "deletion_jobs" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "export_tickets" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "generation_attempts" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(generation_context."fragment_enc" AS BLOB)),0)) FROM "generation_context" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(generation_requests."input_enc" AS BLOB)),0)+coalesce(length(CAST(generation_requests."plan_enc" AS BLOB)),0)) FROM "generation_requests" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "idempotency_keys" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "import_batches" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(import_identities."source_record_enc" AS BLOB)),0)) FROM "import_identities" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(import_items."body_enc" AS BLOB)),0)) FROM "import_items" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "permission_revisions" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(provider_dispatches."provider_response_id_enc" AS BLOB)),0)+coalesce(length(CAST(provider_dispatches."transmission_enc" AS BLOB)),0)+coalesce(length(CAST(provider_dispatches."candidate_enc" AS BLOB)),0)) FROM "provider_dispatches" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "quota_buckets" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "quota_events" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "quota_reservations" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(reading_editions."body_enc" AS BLOB)),0)) FROM "reading_editions" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(reading_sessions."question_enc" AS BLOB)),0)) FROM "reading_sessions" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "recovery_codes" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(reflection_revisions."body_enc" AS BLOB)),0)) FROM "reflection_revisions" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "reflections" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024) FROM "request_events" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(revisits."note_enc" AS BLOB)),0)) FROM "revisits" WHERE owner_id=NEW.id),0)+
  coalesce((SELECT sum(1024+coalesce(length(CAST(security_operations."snapshot_enc" AS BLOB)),0)) FROM "security_operations" WHERE owner_id=NEW.id),0)+
  1024*(SELECT count(*) FROM cost_adjustments a JOIN cost_reservations c ON c.id=a.cost_id WHERE c.owner_id=NEW.id) WHERE id=NEW.id;
END;

CREATE TRIGGER storage_account_keys_insert AFTER INSERT ON "account_keys" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."wrapped_key_enc" AS BLOB)),0)+coalesce(length(CAST(NEW."wrapped_index_key_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_account_keys_delete AFTER DELETE ON "account_keys" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."wrapped_key_enc" AS BLOB)),0)+coalesce(length(CAST(OLD."wrapped_index_key_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_account_keys_update AFTER UPDATE OF "owner_id","wrapped_key_enc","wrapped_index_key_enc" ON "account_keys" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."wrapped_key_enc" AS BLOB)),0)+coalesce(length(CAST(OLD."wrapped_index_key_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."wrapped_key_enc" AS BLOB)),0)+coalesce(length(CAST(NEW."wrapped_index_key_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_auth_challenges_insert AFTER INSERT ON "auth_challenges" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_auth_challenges_delete AFTER DELETE ON "auth_challenges" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_auth_challenges_update AFTER UPDATE OF "owner_id" ON "auth_challenges" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_auth_sessions_insert AFTER INSERT ON "auth_sessions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_auth_sessions_delete AFTER DELETE ON "auth_sessions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_auth_sessions_update AFTER UPDATE OF "owner_id" ON "auth_sessions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_basis_snapshots_insert AFTER INSERT ON "basis_snapshots" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."body_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_basis_snapshots_delete AFTER DELETE ON "basis_snapshots" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."body_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_basis_snapshots_update AFTER UPDATE OF "owner_id","body_enc" ON "basis_snapshots" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."body_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."body_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_context_grants_insert AFTER INSERT ON "context_grants" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_context_grants_delete AFTER DELETE ON "context_grants" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_context_grants_update AFTER UPDATE OF "owner_id" ON "context_grants" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_cost_reservations_insert AFTER INSERT ON "cost_reservations" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+1024*(SELECT count(*) FROM cost_adjustments WHERE cost_id=NEW.id)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_cost_reservations_delete BEFORE DELETE ON "cost_reservations" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+1024*(SELECT count(*) FROM cost_adjustments WHERE cost_id=OLD.id)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_cost_reservations_update AFTER UPDATE OF "owner_id" ON "cost_reservations" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+1024*(SELECT count(*) FROM cost_adjustments WHERE cost_id=OLD.id)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+1024*(SELECT count(*) FROM cost_adjustments WHERE cost_id=NEW.id)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_credentials_insert AFTER INSERT ON "credentials" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_credentials_delete AFTER DELETE ON "credentials" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_credentials_update AFTER UPDATE OF "owner_id" ON "credentials" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_deletion_jobs_insert AFTER INSERT ON "deletion_jobs" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."target_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_deletion_jobs_delete AFTER DELETE ON "deletion_jobs" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."target_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_deletion_jobs_update AFTER UPDATE OF "owner_id","target_enc" ON "deletion_jobs" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."target_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."target_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_export_tickets_insert AFTER INSERT ON "export_tickets" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_export_tickets_delete AFTER DELETE ON "export_tickets" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_export_tickets_update AFTER UPDATE OF "owner_id" ON "export_tickets" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_generation_attempts_insert AFTER INSERT ON "generation_attempts" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_generation_attempts_delete AFTER DELETE ON "generation_attempts" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_generation_attempts_update AFTER UPDATE OF "owner_id" ON "generation_attempts" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_generation_context_insert AFTER INSERT ON "generation_context" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."fragment_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_generation_context_delete AFTER DELETE ON "generation_context" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."fragment_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_generation_context_update AFTER UPDATE OF "owner_id","fragment_enc" ON "generation_context" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."fragment_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."fragment_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_generation_requests_insert AFTER INSERT ON "generation_requests" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."input_enc" AS BLOB)),0)+coalesce(length(CAST(NEW."plan_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_generation_requests_delete AFTER DELETE ON "generation_requests" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."input_enc" AS BLOB)),0)+coalesce(length(CAST(OLD."plan_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_generation_requests_update AFTER UPDATE OF "owner_id","input_enc","plan_enc" ON "generation_requests" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."input_enc" AS BLOB)),0)+coalesce(length(CAST(OLD."plan_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."input_enc" AS BLOB)),0)+coalesce(length(CAST(NEW."plan_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_idempotency_keys_insert AFTER INSERT ON "idempotency_keys" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_idempotency_keys_delete AFTER DELETE ON "idempotency_keys" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_idempotency_keys_update AFTER UPDATE OF "owner_id" ON "idempotency_keys" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_import_batches_insert AFTER INSERT ON "import_batches" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_import_batches_delete AFTER DELETE ON "import_batches" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_import_batches_update AFTER UPDATE OF "owner_id" ON "import_batches" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_import_identities_insert AFTER INSERT ON "import_identities" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."source_record_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_import_identities_delete AFTER DELETE ON "import_identities" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."source_record_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_import_identities_update AFTER UPDATE OF "owner_id","source_record_enc" ON "import_identities" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."source_record_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."source_record_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_import_items_insert AFTER INSERT ON "import_items" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."body_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_import_items_delete AFTER DELETE ON "import_items" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."body_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_import_items_update AFTER UPDATE OF "owner_id","body_enc" ON "import_items" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."body_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."body_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_permission_revisions_insert AFTER INSERT ON "permission_revisions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_permission_revisions_delete AFTER DELETE ON "permission_revisions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_permission_revisions_update AFTER UPDATE OF "owner_id" ON "permission_revisions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_provider_dispatches_insert AFTER INSERT ON "provider_dispatches" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."provider_response_id_enc" AS BLOB)),0)+coalesce(length(CAST(NEW."transmission_enc" AS BLOB)),0)+coalesce(length(CAST(NEW."candidate_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_provider_dispatches_delete AFTER DELETE ON "provider_dispatches" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."provider_response_id_enc" AS BLOB)),0)+coalesce(length(CAST(OLD."transmission_enc" AS BLOB)),0)+coalesce(length(CAST(OLD."candidate_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_provider_dispatches_update AFTER UPDATE OF "owner_id","provider_response_id_enc","transmission_enc","candidate_enc" ON "provider_dispatches" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."provider_response_id_enc" AS BLOB)),0)+coalesce(length(CAST(OLD."transmission_enc" AS BLOB)),0)+coalesce(length(CAST(OLD."candidate_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."provider_response_id_enc" AS BLOB)),0)+coalesce(length(CAST(NEW."transmission_enc" AS BLOB)),0)+coalesce(length(CAST(NEW."candidate_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_quota_buckets_insert AFTER INSERT ON "quota_buckets" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_quota_buckets_delete AFTER DELETE ON "quota_buckets" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_quota_buckets_update AFTER UPDATE OF "owner_id" ON "quota_buckets" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_quota_events_insert AFTER INSERT ON "quota_events" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_quota_events_delete AFTER DELETE ON "quota_events" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_quota_events_update AFTER UPDATE OF "owner_id" ON "quota_events" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_quota_reservations_insert AFTER INSERT ON "quota_reservations" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_quota_reservations_delete AFTER DELETE ON "quota_reservations" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_quota_reservations_update AFTER UPDATE OF "owner_id" ON "quota_reservations" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_reading_editions_insert AFTER INSERT ON "reading_editions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."body_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_reading_editions_delete AFTER DELETE ON "reading_editions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."body_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_reading_editions_update AFTER UPDATE OF "owner_id","body_enc" ON "reading_editions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."body_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."body_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_reading_sessions_insert AFTER INSERT ON "reading_sessions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."question_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_reading_sessions_delete AFTER DELETE ON "reading_sessions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."question_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_reading_sessions_update AFTER UPDATE OF "owner_id","question_enc" ON "reading_sessions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."question_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."question_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_recovery_codes_insert AFTER INSERT ON "recovery_codes" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_recovery_codes_delete AFTER DELETE ON "recovery_codes" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_recovery_codes_update AFTER UPDATE OF "owner_id" ON "recovery_codes" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_reflection_revisions_insert AFTER INSERT ON "reflection_revisions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."body_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_reflection_revisions_delete AFTER DELETE ON "reflection_revisions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."body_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_reflection_revisions_update AFTER UPDATE OF "owner_id","body_enc" ON "reflection_revisions" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."body_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."body_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_reflections_insert AFTER INSERT ON "reflections" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_reflections_delete AFTER DELETE ON "reflections" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_reflections_update AFTER UPDATE OF "owner_id" ON "reflections" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_request_events_insert AFTER INSERT ON "request_events" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_request_events_delete AFTER DELETE ON "request_events" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_request_events_update AFTER UPDATE OF "owner_id" ON "request_events" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_revisits_insert AFTER INSERT ON "revisits" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."note_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_revisits_delete AFTER DELETE ON "revisits" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."note_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_revisits_update AFTER UPDATE OF "owner_id","note_enc" ON "revisits" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."note_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."note_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_security_operations_insert AFTER INSERT ON "security_operations" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."snapshot_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_security_operations_delete AFTER DELETE ON "security_operations" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."snapshot_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;

CREATE TRIGGER storage_security_operations_update AFTER UPDATE OF "owner_id","snapshot_enc" ON "security_operations" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."snapshot_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
  UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."snapshot_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_cost_adjustments_insert AFTER INSERT ON "cost_adjustments" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=(SELECT owner_id FROM cost_reservations WHERE id=NEW.cost_id);
END;

CREATE TRIGGER storage_cost_adjustments_delete AFTER DELETE ON "cost_adjustments" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=(SELECT owner_id FROM cost_reservations WHERE id=OLD.cost_id);
END;

CREATE TRIGGER storage_cost_adjustments_update AFTER UPDATE OF "cost_id" ON "cost_adjustments" BEGIN
  UPDATE accounts SET storage_bytes=storage_bytes-(1024) WHERE id=(SELECT owner_id FROM cost_reservations WHERE id=OLD.cost_id);
  UPDATE accounts SET storage_bytes=storage_bytes+(1024) WHERE id=(SELECT owner_id FROM cost_reservations WHERE id=NEW.cost_id);
END;
