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
