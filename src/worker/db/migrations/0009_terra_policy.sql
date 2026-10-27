-- Forward-only model allowlist expansion. Historical transmissions, readings and costs are immutable.
-- D1 applies this migration in one batch. There are no inbound dispatch FKs.
-- Temporarily remove the account trigger referencing this table so the rename validates.
-- Remove accounting triggers before replacement: copying rows must not change storage counters.
DROP TRIGGER storage_accounts_insert;
DROP TRIGGER storage_provider_dispatches_insert;
DROP TRIGGER storage_provider_dispatches_delete;
DROP TRIGGER storage_provider_dispatches_update;

CREATE TABLE provider_dispatches_terra (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN('authorized','received','rejected','unknown')),
  provider TEXT NOT NULL CHECK(provider='openai'), requested_model TEXT NOT NULL CHECK(requested_model IN('gpt-5.6-terra','gpt-6.1-terra')),
  returned_model TEXT, provider_response_id_enc TEXT, transmission_enc TEXT, transmission_hmac TEXT NOT NULL,
  candidate_enc TEXT, key_version INTEGER NOT NULL, prompt_hash TEXT NOT NULL, validator_hash TEXT NOT NULL,
  content_hash TEXT NOT NULL REFERENCES content_editions(hash), parameters_json TEXT NOT NULL CHECK(json_valid(parameters_json)),
  input_tokens INTEGER CHECK(input_tokens>=0), output_tokens INTEGER CHECK(output_tokens>=0),
  duration_ms INTEGER CHECK(duration_ms>=0), authorized_at INTEGER NOT NULL, received_at INTEGER, cost_expired_at INTEGER,
  FOREIGN KEY(owner_id,request_id) REFERENCES generation_requests(owner_id,id) ON DELETE CASCADE,
  FOREIGN KEY(owner_id,attempt_id) REFERENCES generation_attempts(owner_id,id),
  FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version), UNIQUE(owner_id,id)
);
INSERT INTO provider_dispatches_terra SELECT * FROM provider_dispatches;
DROP TABLE provider_dispatches;
ALTER TABLE provider_dispatches_terra RENAME TO provider_dispatches;
CREATE INDEX dispatch_retention ON provider_dispatches(received_at);

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
