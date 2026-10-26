-- Persistent offline state complements the operator's synthetic-local runtime fence.
ALTER TABLE system_state ADD COLUMN restore_in_progress INTEGER NOT NULL DEFAULT 0 CHECK(restore_in_progress IN (0,1));
