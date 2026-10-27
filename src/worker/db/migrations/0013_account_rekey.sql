CREATE TABLE account_rekey_jobs (
 id TEXT PRIMARY KEY NOT NULL,
 owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 expected_version INTEGER NOT NULL CHECK(expected_version>0),
 target_version INTEGER NOT NULL CHECK(target_version=expected_version+1),
 phase TEXT NOT NULL CHECK(phase IN('inventorying','rewriting','validating','checkpoint','complete')),
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 registry_hash TEXT NOT NULL CHECK(length(registry_hash)=64),
 inventory_hash TEXT NOT NULL CHECK(length(inventory_hash)=64),
 expected_count INTEGER NOT NULL CHECK(expected_count>=0),
 field_count INTEGER NOT NULL DEFAULT 0 CHECK(field_count>=0),
 cursor_json TEXT NOT NULL CHECK(json_valid(cursor_json)),
 context_json TEXT NOT NULL CHECK(json_valid(context_json)),
 checkpoint_operation_id TEXT NOT NULL,
 checkpoint_epoch INTEGER,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL,
 UNIQUE(owner_id,id)
);
CREATE UNIQUE INDEX one_account_rekey ON account_rekey_jobs(owner_id) WHERE phase!='complete';
CREATE TABLE account_rekey_entries (
 operation_id TEXT NOT NULL,
 owner_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 table_name TEXT NOT NULL,
 column_name TEXT NOT NULL,
 key_json TEXT NOT NULL CHECK(json_valid(key_json)),
 aad_revision INTEGER NOT NULL CHECK(aad_revision>0),
 source_version INTEGER NOT NULL CHECK(source_version>0),
 source_cipher_hash TEXT NOT NULL CHECK(length(source_cipher_hash)=64),
 value_hmac TEXT NOT NULL CHECK(length(value_hmac)=64),
 target_cipher_hash TEXT CHECK(target_cipher_hash IS NULL OR length(target_cipher_hash)=64),
 completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN(0,1)),
 validated INTEGER NOT NULL DEFAULT 0 CHECK(validated IN(0,1)),
 PRIMARY KEY(operation_id,ordinal),
 FOREIGN KEY(owner_id,operation_id) REFERENCES account_rekey_jobs(owner_id,id) ON DELETE CASCADE
);

CREATE TRIGGER storage_account_rekey_jobs_insert AFTER INSERT ON account_rekey_jobs BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes+1024 WHERE id=NEW.owner_id;
END;
CREATE TRIGGER storage_account_rekey_jobs_delete AFTER DELETE ON account_rekey_jobs BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-1024 WHERE id=OLD.owner_id;
END;
CREATE TRIGGER storage_account_rekey_jobs_update AFTER UPDATE ON account_rekey_jobs BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-1024 WHERE id=OLD.owner_id;
 UPDATE accounts SET storage_bytes=storage_bytes+1024 WHERE id=NEW.owner_id;
END;

CREATE TRIGGER storage_account_rekey_entries_insert AFTER INSERT ON account_rekey_entries BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes+1024 WHERE id=NEW.owner_id;
END;
CREATE TRIGGER storage_account_rekey_entries_delete AFTER DELETE ON account_rekey_entries BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-1024 WHERE id=OLD.owner_id;
END;
CREATE TRIGGER storage_account_rekey_entries_update AFTER UPDATE ON account_rekey_entries BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-1024 WHERE id=OLD.owner_id;
 UPDATE accounts SET storage_bytes=storage_bytes+1024 WHERE id=NEW.owner_id;
END;
