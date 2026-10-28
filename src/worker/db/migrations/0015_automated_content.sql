-- Preserve existing content/foreign keys; automated validation never claims human approval or clears unknown rights.
PRAGMA defer_foreign_keys=ON;
CREATE TABLE content_editions_next (
  hash TEXT PRIMARY KEY NOT NULL CHECK(length(hash)=64),
  state TEXT NOT NULL CHECK(state IN ('staged','approved','superseded','withdrawn')),
  policy_revision INTEGER NOT NULL DEFAULT 1 CHECK(policy_revision>0),
  bundle_json TEXT NOT NULL CHECK(json_valid(bundle_json)),
  reviewed_hash TEXT, reviewer_kind TEXT NOT NULL CHECK(reviewer_kind IN ('unreviewed','agent_reviewed','human_approved','automated_validated')),
  reviewer_id TEXT, rights_status TEXT NOT NULL CHECK(rights_status IN ('cleared','unknown','disallowed')),
  created_at INTEGER NOT NULL, approved_at INTEGER, withdrawn_at INTEGER, approval_json TEXT CHECK(approval_json IS NULL OR json_valid(approval_json)), approval_hash TEXT CHECK(approval_hash IS NULL OR length(approval_hash)=64),
  CHECK(reviewed_hash IS NULL OR reviewed_hash=hash),
  CHECK(state NOT IN ('approved','superseded') OR
    (reviewer_kind IN ('human_approved','automated_validated') AND reviewer_id IS NOT NULL AND reviewed_hash IS NOT NULL AND reviewed_hash=hash AND (rights_status='cleared' OR (reviewer_kind='automated_validated' AND rights_status='unknown')) AND approved_at IS NOT NULL))
);
INSERT INTO content_editions_next(hash,state,policy_revision,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at,withdrawn_at,approval_json,approval_hash) SELECT hash,state,policy_revision,bundle_json,reviewed_hash,reviewer_kind,reviewer_id,rights_status,created_at,approved_at,withdrawn_at,approval_json,approval_hash FROM content_editions;
DROP TABLE content_editions;
ALTER TABLE content_editions_next RENAME TO content_editions;
-- SQLite retains the deferred violation counter from DROP even after the same
-- parent keys exist again. Check the entire graph before clearing that counter;
-- a dangling key aborts the migration instead of committing inconsistent rows.
CREATE TABLE automated_content_integrity (violations INTEGER NOT NULL CHECK(violations=0));
INSERT INTO automated_content_integrity SELECT count(*) FROM pragma_foreign_key_check;
DROP TABLE automated_content_integrity;
PRAGMA defer_foreign_keys=OFF;
