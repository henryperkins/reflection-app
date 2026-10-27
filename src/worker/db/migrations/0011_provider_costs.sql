-- Rebuild the referenced financial graph in one D1 migration batch.
-- Copying rows must preserve storage counters, historical bills and all foreign keys.
-- Admission ceilings remain enforced by dispatch; real liability can exceed them.


DROP TRIGGER storage_accounts_insert;

DROP TRIGGER storage_cost_reservations_insert;

DROP TRIGGER storage_cost_reservations_delete;

DROP TRIGGER storage_cost_reservations_update;

DROP TRIGGER storage_cost_adjustments_insert;

DROP TRIGGER storage_cost_adjustments_delete;

DROP TRIGGER storage_cost_adjustments_update;

CREATE TABLE spend_buckets_next (
  period TEXT PRIMARY KEY NOT NULL,
  ceiling_microusd INTEGER NOT NULL CHECK(ceiling_microusd>=0),
  committed_microusd INTEGER NOT NULL DEFAULT 0 CHECK(committed_microusd>=0)
);
INSERT INTO spend_buckets_next SELECT * FROM spend_buckets;

CREATE TABLE cost_reservations_next (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  dispatch_id TEXT UNIQUE, day_period TEXT NOT NULL REFERENCES spend_buckets_next(period),
  month_period TEXT NOT NULL REFERENCES spend_buckets_next(period),
  state TEXT NOT NULL CHECK(state IN('reserved','actual','unknown')),
  reserved_microusd INTEGER NOT NULL CHECK(reserved_microusd>=0),
  actual_microusd INTEGER CHECK(actual_microusd>=0), price_basis_json TEXT NOT NULL CHECK(json_valid(price_basis_json)),
  created_at INTEGER NOT NULL, settled_at INTEGER,
  dispatch_hash TEXT CHECK(dispatch_hash IS NULL OR length(dispatch_hash)=64),
  requested_model TEXT,
  application_policy_hash TEXT,
  provider_policy_hash TEXT,
  reconciled_policy_hash TEXT,
  price_hash TEXT,
  receipt_hash TEXT,
  receipt_id TEXT,
  returned_model TEXT,
  service_tier TEXT,
  input_tokens INTEGER CHECK(input_tokens IS NULL OR input_tokens>=0),
  cached_input_tokens INTEGER CHECK(cached_input_tokens IS NULL OR cached_input_tokens BETWEEN 0 AND input_tokens),
  cache_write_tokens INTEGER CHECK(cache_write_tokens IS NULL OR cache_write_tokens BETWEEN 0 AND input_tokens-cached_input_tokens),
  output_tokens INTEGER CHECK(output_tokens IS NULL OR output_tokens>=0),
  reasoning_tokens INTEGER CHECK(reasoning_tokens IS NULL OR reasoning_tokens BETWEEN 0 AND output_tokens)
);

INSERT INTO cost_reservations_next(id,owner_id,dispatch_id,day_period,month_period,state,reserved_microusd,actual_microusd,price_basis_json,created_at,settled_at) SELECT id,owner_id,dispatch_id,day_period,month_period,state,reserved_microusd,actual_microusd,price_basis_json,created_at,settled_at FROM cost_reservations;

CREATE TABLE cost_adjustments_next (
  idempotency_key TEXT PRIMARY KEY NOT NULL, cost_id TEXT NOT NULL REFERENCES cost_reservations_next(id) ON DELETE CASCADE,
  before_microusd INTEGER NOT NULL CHECK(before_microusd>=0), after_microusd INTEGER NOT NULL CHECK(after_microusd>=0),
  reason TEXT NOT NULL CHECK(reason IN('usage','reconciliation','price_correction')), created_at INTEGER NOT NULL
);

INSERT INTO cost_adjustments_next SELECT * FROM cost_adjustments;

DROP TABLE cost_adjustments;

DROP TABLE cost_reservations;

DROP TABLE spend_buckets;

ALTER TABLE spend_buckets_next RENAME TO spend_buckets;

ALTER TABLE cost_reservations_next RENAME TO cost_reservations;

ALTER TABLE cost_adjustments_next RENAME TO cost_adjustments;

CREATE INDEX cost_reconcile ON cost_reservations(state,created_at);

CREATE UNIQUE INDEX cost_dispatch_hash ON cost_reservations(dispatch_hash) WHERE dispatch_hash IS NOT NULL;

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

-- Signed editorial approval metadata contains only public catalog evidence digests.
ALTER TABLE content_editions ADD COLUMN approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json));
ALTER TABLE content_editions ADD COLUMN approval_hash TEXT CHECK(approval_hash IS NULL OR length(approval_hash)=64);
