-- Requires quiesced migration and deployment of the matching writer binary.
-- Keep the current ciphertext identity unchanged. Existing import aliases retain
-- their note FK, and unsaved/expired parents keep their original retention.
PRAGMA defer_foreign_keys=ON;
DROP TRIGGER storage_accounts_insert;
DROP TRIGGER storage_revisits_insert;
DROP TRIGGER storage_revisits_delete;
DROP TRIGGER storage_revisits_update;
DROP TRIGGER storage_deletion_jobs_insert;
DROP TRIGGER storage_deletion_jobs_delete;
DROP TRIGGER storage_deletion_jobs_update;
CREATE UNIQUE INDEX reading_edition_session_identity ON reading_editions(owner_id,id,session_id);
CREATE TABLE revisits_next (
 id TEXT PRIMARY KEY NOT NULL, owner_id TEXT NOT NULL, edition_id TEXT NOT NULL,
 note_enc TEXT, key_version INTEGER NOT NULL, created_at INTEGER NOT NULL,
 session_id TEXT NOT NULL, current_revision INTEGER NOT NULL DEFAULT 1 CHECK(current_revision BETWEEN 1 AND 100),
 updated_at INTEGER NOT NULL, deleted_at INTEGER,
 UNIQUE(owner_id,id),
 FOREIGN KEY(owner_id,edition_id,session_id) REFERENCES reading_editions(owner_id,id,session_id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,session_id) REFERENCES reading_sessions(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version),
 CHECK(note_enc IS NOT NULL OR deleted_at IS NOT NULL)
);
INSERT INTO revisits_next(id,owner_id,edition_id,note_enc,key_version,created_at,session_id,current_revision,updated_at)
 SELECT r.id,r.owner_id,r.edition_id,r.note_enc,r.key_version,r.created_at,e.session_id,1,r.created_at
 FROM revisits r JOIN reading_editions e ON e.owner_id=r.owner_id AND e.id=r.edition_id;
DROP TABLE revisits;
ALTER TABLE revisits_next RENAME TO revisits;
CREATE INDEX revisits_history ON revisits(owner_id,edition_id,created_at ASC,id ASC);
CREATE TABLE revisit_revisions (
 revisit_id TEXT NOT NULL, owner_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 100),
 body_enc TEXT, key_version INTEGER NOT NULL, created_at INTEGER NOT NULL, erased_at INTEGER,
 PRIMARY KEY(owner_id,revisit_id,revision),
 FOREIGN KEY(owner_id,revisit_id) REFERENCES revisits(owner_id,id) ON DELETE CASCADE,
 FOREIGN KEY(owner_id,key_version) REFERENCES account_keys(owner_id,version),
 CHECK(body_enc IS NOT NULL OR erased_at IS NOT NULL)
);
CREATE TABLE deletion_jobs_next (
  id TEXT PRIMARY KEY NOT NULL, owner_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  scope TEXT NOT NULL CHECK(scope IN('account','session','reflection_revision','context_copy','revisit')),
  target_hmac TEXT NOT NULL, target_enc TEXT, receipt_token_hash TEXT UNIQUE,
  state TEXT NOT NULL CHECK(state IN('fencing','ledger_pending','erasing','complete')),
  ledger_key TEXT NOT NULL UNIQUE, attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
  next_run_at INTEGER NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER, backup_expires_by INTEGER
);
INSERT INTO deletion_jobs_next SELECT * FROM deletion_jobs;
DROP TABLE deletion_jobs;
ALTER TABLE deletion_jobs_next RENAME TO deletion_jobs;
CREATE INDEX deletion_due ON deletion_jobs(state,next_run_at);
CREATE TRIGGER storage_revisits_insert AFTER INSERT ON "revisits" BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."note_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;
CREATE TRIGGER storage_revisits_delete AFTER DELETE ON "revisits" BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."note_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;
CREATE TRIGGER storage_revisits_update AFTER UPDATE ON "revisits" BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."note_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
 UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."note_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;
CREATE TRIGGER storage_revisit_revisions_insert AFTER INSERT ON "revisit_revisions" BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."body_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;
CREATE TRIGGER storage_revisit_revisions_delete AFTER DELETE ON "revisit_revisions" BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."body_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;
CREATE TRIGGER storage_revisit_revisions_update AFTER UPDATE ON "revisit_revisions" BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."body_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
 UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."body_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;
CREATE TRIGGER storage_deletion_jobs_insert AFTER INSERT ON "deletion_jobs" BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."target_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;
CREATE TRIGGER storage_deletion_jobs_delete AFTER DELETE ON "deletion_jobs" BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."target_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
END;
CREATE TRIGGER storage_deletion_jobs_update AFTER UPDATE ON "deletion_jobs" BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-(1024+coalesce(length(CAST(OLD."target_enc" AS BLOB)),0)) WHERE id=OLD.owner_id;
 UPDATE accounts SET storage_bytes=storage_bytes+(1024+coalesce(length(CAST(NEW."target_enc" AS BLOB)),0)) WHERE id=NEW.owner_id;
END;
CREATE TRIGGER storage_accounts_insert AFTER INSERT ON accounts BEGIN
 UPDATE accounts SET storage_bytes=1024+
 coalesce((SELECT sum(1024+coalesce(length(CAST(account_keys."wrapped_key_enc" AS BLOB)),0)+coalesce(length(CAST(account_keys."wrapped_index_key_enc" AS BLOB)),0)) FROM "account_keys" WHERE owner_id=NEW.id),0)+
 coalesce((SELECT sum(1024) FROM "account_rekey_entries" WHERE owner_id=NEW.id),0)+
 coalesce((SELECT sum(1024) FROM "account_rekey_jobs" WHERE owner_id=NEW.id),0)+
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
 coalesce((SELECT sum(1024) FROM "key_retirement_operations" WHERE owner_id=NEW.id),0)+
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
 coalesce((SELECT sum(1024+coalesce(length(CAST(revisit_revisions."body_enc" AS BLOB)),0)) FROM "revisit_revisions" WHERE owner_id=NEW.id),0)+
 coalesce((SELECT sum(1024+coalesce(length(CAST(revisits."note_enc" AS BLOB)),0)) FROM "revisits" WHERE owner_id=NEW.id),0)+
 coalesce((SELECT sum(1024+coalesce(length(CAST(security_operations."snapshot_enc" AS BLOB)),0)) FROM "security_operations" WHERE owner_id=NEW.id),0)+
 1024*(SELECT count(*) FROM cost_adjustments a JOIN cost_reservations c ON c.id=a.cost_id WHERE c.owner_id=NEW.id) WHERE id=NEW.id;
END;
-- Recompute once after copying with accounting disabled for rebuilt tables.
UPDATE accounts SET storage_bytes=1024+
 coalesce((SELECT sum(1024+coalesce(length(CAST(account_keys."wrapped_key_enc" AS BLOB)),0)+coalesce(length(CAST(account_keys."wrapped_index_key_enc" AS BLOB)),0)) FROM "account_keys" WHERE owner_id=accounts.id),0)+
 coalesce((SELECT sum(1024) FROM "account_rekey_entries" WHERE owner_id=accounts.id),0)+
 coalesce((SELECT sum(1024) FROM "account_rekey_jobs" WHERE owner_id=accounts.id),0)+
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
 coalesce((SELECT sum(1024) FROM "key_retirement_operations" WHERE owner_id=accounts.id),0)+
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
 coalesce((SELECT sum(1024+coalesce(length(CAST(revisit_revisions."body_enc" AS BLOB)),0)) FROM "revisit_revisions" WHERE owner_id=accounts.id),0)+
 coalesce((SELECT sum(1024+coalesce(length(CAST(revisits."note_enc" AS BLOB)),0)) FROM "revisits" WHERE owner_id=accounts.id),0)+
 coalesce((SELECT sum(1024+coalesce(length(CAST(security_operations."snapshot_enc" AS BLOB)),0)) FROM "security_operations" WHERE owner_id=accounts.id),0)+
 1024*(SELECT count(*) FROM cost_adjustments a JOIN cost_reservations c ON c.id=a.cost_id WHERE c.owner_id=accounts.id);
-- Check the complete ownership graph before clearing SQLite's deferred
-- DROP counter (which otherwise remembers the temporary absence of parents).
CREATE TABLE revisit_migration_integrity(violations INTEGER NOT NULL CHECK(violations=0));
INSERT INTO revisit_migration_integrity SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE revisit_migration_integrity;
PRAGMA defer_foreign_keys=OFF;
