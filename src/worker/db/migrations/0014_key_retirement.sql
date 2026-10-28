-- Content-free audit only. No candidate secret material is persisted here.
CREATE TABLE key_retirement_operations (
 id TEXT PRIMARY KEY NOT NULL,
 environment_id TEXT NOT NULL,
 epoch INTEGER NOT NULL CHECK(epoch>0),
 kind TEXT NOT NULL CHECK(kind IN('environment','account-data')),
 owner_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
 version INTEGER CHECK(version IS NULL OR version>0),
 plan_hash TEXT NOT NULL CHECK(length(plan_hash)=64),
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
 created_at INTEGER NOT NULL,
 CHECK((kind='environment' AND owner_id IS NULL AND version IS NULL) OR (kind='account-data' AND owner_id IS NOT NULL AND version IS NOT NULL))
);
CREATE TRIGGER storage_key_retirement_operations_insert AFTER INSERT ON key_retirement_operations BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes+1024 WHERE id=NEW.owner_id;
END;
CREATE TRIGGER storage_key_retirement_operations_delete AFTER DELETE ON key_retirement_operations BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-1024 WHERE id=OLD.owner_id;
END;
CREATE TRIGGER storage_key_retirement_operations_update AFTER UPDATE ON key_retirement_operations BEGIN
 UPDATE accounts SET storage_bytes=storage_bytes-1024 WHERE id=OLD.owner_id;
 UPDATE accounts SET storage_bytes=storage_bytes+1024 WHERE id=NEW.owner_id;
END;
