-- A verified independent cleanup receipt rejects snapshots below this recovery floor.
ALTER TABLE system_state ADD COLUMN recovery_epoch INTEGER NOT NULL DEFAULT 0 CHECK(recovery_epoch>=0);
