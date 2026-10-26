-- Pattern-Like Astrology App
-- M3 daily reading pipeline (Cloudflare D1 / SQLite)
-- Contract package: contracts/m3 schema_version 0.3.0
--
-- FORWARD-ONLY. 0001_m0_core.sql is immutable from this point on: the
-- production runbook records a live Worker bound to D1 `patternlike-ops` with
-- the 22-table M0 schema already applied, so editing the baseline and deleting
-- local Wrangler state cannot change production.
--
-- What this migration does, and why:
--
--  * daily_readings gains a revision identity. UNIQUE (user_id, local_date,
--    release_version) offered no way to correct a reading without violating the
--    constraint or overwriting history, and — because it was scoped by
--    release_version — it permitted TWO published readings for one user-day
--    whenever a release activated mid-day, against the product contract of one
--    coherent daily chapter.
--
--  * Generation inputs are frozen at enqueue in an encrypted, immutable job
--    command. Cloudflare Queues is at-least-once, so neither a retry nor a
--    recovered lease may resolve "today" or "active" inputs again.
--
--  * Cycles gain an ordered pass list. A one-pass model cannot express
--    `reconsidering`, which is precisely the interior of a retrograde loop.
--
--  * Reading prose AND every reconstructive evidence field are encrypted.
--    Fragment ids plus a text hash in clear, together with the retained R2
--    release catalogue, reconstruct deleted prose offline.
--
-- ASSERTION PRIMITIVE. This migration uses `assertion_probe` rather than
-- triggers. Inserting a row whose id is anything but 0 violates its CHECK and
-- aborts the enclosing transaction, so `INSERT ... SELECT 1, '<reason>' WHERE
-- <bad condition>` is a conditional abort in pure SQL. It is used here to
-- refuse a destructive rebuild over unconvertible rows, and at runtime to make
-- reading publication all-or-nothing. Triggers would have worked too, but they
-- carry two avoidable risks: ALTER TABLE ... RENAME rewrites references inside
-- trigger bodies, which collides with the table rebuilds below, and D1's
-- support for them on the remote path is not something this migration needs to
-- depend on. A CHECK constraint is supported everywhere SQLite is.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Assertion primitive
-- ---------------------------------------------------------------------------

-- Always empty. A row can never be inserted successfully, which is the point:
-- an INSERT guarded by `WHERE <bad condition>` is a no-op when the condition is
-- false and an abort when it is true.
CREATE TABLE IF NOT EXISTS assertion_probe (
  id     INTEGER PRIMARY KEY CHECK (id = 0),
  reason TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Pre-flight: refuse to destroy rows this migration cannot convert
-- ---------------------------------------------------------------------------
--
-- daily_readings.reading_enc and reading_sources' clear evidence columns can
-- only be re-shaped by an application layer holding the per-user DEK. If
-- production contains an unexpected row, migration stops here for an
-- application-layer encrypted backfill; it never discards the row.

INSERT INTO assertion_probe (id, reason)
SELECT 1, 'daily_readings contains rows - convert them with an application-layer encrypted backfill before applying 0002'
WHERE EXISTS (SELECT 1 FROM daily_readings);

INSERT INTO assertion_probe (id, reason)
SELECT 1, 'reading_sources contains rows - convert them with an application-layer encrypted backfill before applying 0002'
WHERE EXISTS (SELECT 1 FROM reading_sources);

-- reading_feedback references daily_readings, which is dropped below.
INSERT INTO assertion_probe (id, reason)
SELECT 1, 'reading_feedback contains rows referencing daily_readings - back them up before applying 0002'
WHERE EXISTS (SELECT 1 FROM reading_feedback);

-- ---------------------------------------------------------------------------
-- users: scheduling timezone and locale become owned values
-- ---------------------------------------------------------------------------
--
-- Identity creation writes timezone 'UTC' and locale 'en-US' as server
-- defaults with no writer anywhere. M3 makes both load-bearing — the scheduling
-- zone decides which local day is generated, the locale selects the reviewed
-- fallback and timing template — so a default nobody chose must be
-- distinguishable from a decision somebody made.

ALTER TABLE users ADD COLUMN timezone_source TEXT NOT NULL DEFAULT 'default_unconfirmed';
ALTER TABLE users ADD COLUMN timezone_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN timezone_updated_at TEXT;
ALTER TABLE users ADD COLUMN locale_source TEXT NOT NULL DEFAULT 'default_unconfirmed';
ALTER TABLE users ADD COLUMN locale_updated_at TEXT;

-- The data source registry requires a 35-day change log for scheduling-zone
-- changes (DEV-01). Retention is enforced by a sweeper, not by this table.
CREATE TABLE IF NOT EXISTS timezone_changes (
  id            TEXT PRIMARY KEY NOT NULL,
  user_id       TEXT NOT NULL REFERENCES users(id),
  previous_zone TEXT,
  next_zone     TEXT NOT NULL,
  source        TEXT NOT NULL
    CHECK (source IN ('default_unconfirmed', 'device_derived', 'user_confirmed')),
  revision      INTEGER NOT NULL,
  changed_at    TEXT NOT NULL,
  UNIQUE (user_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_timezone_changes_user_time
  ON timezone_changes(user_id, changed_at DESC);

-- ---------------------------------------------------------------------------
-- jobs: encrypted immutable command, durable outbox, claim lease
-- ---------------------------------------------------------------------------
--
-- Rebuilt rather than ALTERed because the payload_enc pairing CHECK cannot be
-- added to an existing table, and because daily_readings is about to take a
-- composite foreign key into it.

CREATE TABLE IF NOT EXISTS jobs_m3 (
  id TEXT PRIMARY KEY NOT NULL,
  job_type TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- Clear payload for system jobs that carry no user data. The M3 daily
  -- generation command NEVER lands here.
  payload_json TEXT,
  -- The immutable GenerateDailyReadingCommandV1, DEK-encrypted with AAD bound
  -- to (subject, 'jobs.payload_enc', job_id, key_version). Added to
  -- ENCRYPTED_COLUMNS in apps/api/src/db/users.ts before its first writer.
  payload_enc BLOB,
  payload_key_version INTEGER,
  payload_nonce TEXT,
  result_class TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TEXT,
  started_at TEXT,
  finished_at TEXT,
  -- Durable outbox. D1 and Queue delivery cannot share a transaction, so the
  -- job row IS the outbox: only after the reservation batch commits does a
  -- dispatcher send the opaque message. Advisory by design — an undispatched
  -- sweeper retries a crash before send, and a crash after send may send twice.
  -- Both paths converge through the command idempotency key and the claim CAS,
  -- and no code treats a Queue send response as proof generation completed.
  dispatched_at TEXT,
  -- Claim lease. A consumer compare-and-swaps queued -> running with a random
  -- token; a zero-row claim does no work.
  claim_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  -- Encrypted payloads are per-user by construction: the AAD subject comes from
  -- the owning user's crypto_subject, and rotation walks the table by user_id.
  CHECK (payload_enc IS NULL OR user_id IS NOT NULL),
  CHECK (
    (payload_enc IS NULL AND payload_key_version IS NULL AND payload_nonce IS NULL)
    OR (payload_enc IS NOT NULL AND payload_key_version IS NOT NULL AND payload_nonce IS NOT NULL)
  )
);

INSERT INTO jobs_m3 (
  id, job_type, user_id, idempotency_key, status, payload_json,
  result_class, attempts, available_at, started_at, finished_at, created_at
)
SELECT
  id, job_type, user_id, idempotency_key, status, payload_json,
  result_class, attempts, available_at, started_at, finished_at, created_at
FROM jobs;

DROP TABLE jobs;

ALTER TABLE jobs_m3 RENAME TO jobs;

-- Unchanged from 0001: idempotency is scoped to (job_type, user, key), with
-- COALESCE keeping system jobs in a single namespace because SQLite treats
-- NULLs as distinct in a UNIQUE constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_scope_key
  ON jobs(job_type, COALESCE(user_id, ''), idempotency_key);

CREATE INDEX IF NOT EXISTS idx_jobs_status_available
  ON jobs(status, available_at);

-- A reading must not be able to point at another user's command. Two
-- independently valid foreign keys would not enforce that relation, so the
-- parent key is composite.
CREATE UNIQUE INDEX IF NOT EXISTS uq_jobs_id_user ON jobs(id, user_id);

-- The outbox sweeper's query: queued and never dispatched.
CREATE INDEX IF NOT EXISTS idx_jobs_undispatched
  ON jobs(created_at) WHERE status = 'queued' AND dispatched_at IS NULL;

-- Reclaiming an expired lease.
CREATE INDEX IF NOT EXISTS idx_jobs_running_lease
  ON jobs(lease_expires_at) WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- daily_readings: revision identity, frozen reservation, encrypted result
-- ---------------------------------------------------------------------------

-- Dropped and recreated under their FINAL names rather than built alongside and
-- renamed. ALTER TABLE ... RENAME rewrites REFERENCES clauses in other tables
-- only when foreign key enforcement is on at that moment, so a rename-based
-- rebuild silently produces a dangling reference wherever that assumption does
-- not hold. The pre-flight assertions above are what make dropping safe: both
-- tables are provably empty, so there is nothing to copy.
DROP TABLE reading_sources;
DROP TABLE daily_readings;

CREATE TABLE IF NOT EXISTS daily_readings (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  local_date TEXT NOT NULL,
  release_version TEXT NOT NULL REFERENCES content_releases(version),
  reading_key TEXT NOT NULL,
  chart_fingerprint TEXT NOT NULL,
  contract_id TEXT NOT NULL,
  assembly_mode TEXT NOT NULL
    CHECK (assembly_mode IN ('deterministic', 'constrained_model')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'published', 'failed', 'superseded')),

  -- Artifact revision. Monotonic within a user's local day, so uniqueness no
  -- longer resets when the editorial release changes.
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  revision_reason TEXT NOT NULL DEFAULT 'initial'
    CHECK (revision_reason IN (
      'initial', 'chart_recalculated', 'consent_revoked',
      'safety_correction', 'defect_repair'
    )),
  supersedes_reading_id TEXT REFERENCES daily_readings(id),

  -- Command generation is a DIFFERENT identity from artifact revision. A
  -- terminally failed command is replaced by the next generation against the
  -- same reservation; that replacement does not consume a revision.
  command_generation INTEGER NOT NULL DEFAULT 1 CHECK (command_generation >= 1),
  active_generation_job_id TEXT,

  -- Generated prose, DEK-encrypted with AAD bound to
  -- (subject, 'daily_readings.reading_enc', reading_id, key_version).
  --
  -- Output-derived metadata capable of identifying the deterministic result —
  -- the assembly_id, the content hash, selected cycle refs, and validation
  -- detail — moved INSIDE this envelope. M0 kept them in clear columns, where
  -- they were a dictionary oracle over the day's facts. The M3 response
  -- reconstructs them after decryption.
  reading_enc BLOB,
  reading_key_version INTEGER,
  reading_nonce TEXT,

  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,

  UNIQUE (reading_key),
  -- Revision replaces release_version in the uniqueness key.
  UNIQUE (user_id, local_date, revision),
  -- Parent key for reading_sources' composite foreign key.
  UNIQUE (id, user_id),

  CHECK (
    status != 'published'
    OR (
      reading_enc IS NOT NULL
      AND reading_key_version IS NOT NULL
      AND reading_nonce IS NOT NULL
    )
  ),
  -- Revision 1 is the initial reading and has no predecessor; every later
  -- revision has one.
  CHECK (
    (revision_reason = 'initial' AND revision = 1 AND supersedes_reading_id IS NULL)
    OR (revision_reason != 'initial' AND revision > 1 AND supersedes_reading_id IS NOT NULL)
  ),
  FOREIGN KEY (active_generation_job_id, user_id) REFERENCES jobs(id, user_id)
);

-- ---------------------------------------------------------------------------
-- reading_sources: owner-constrained, encrypted evidence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS reading_sources (
  id TEXT PRIMARY KEY NOT NULL,
  reading_id TEXT NOT NULL,
  -- Added so the composite foreign key can reject cross-user evidence, and so
  -- the existing DEK rotation walker can select and update this table by
  -- user_id like every other encrypted column.
  user_id TEXT NOT NULL REFERENCES users(id),
  paragraph_id TEXT NOT NULL,
  paragraph_order INTEGER NOT NULL CHECK (paragraph_order >= 1),

  -- The complete evidence object, DEK-encrypted with AAD bound to
  -- (subject, 'reading_sources.evidence_enc', reading_source_id, key_version).
  -- Role, lane, text hash, fact refs, content refs, context and source refs,
  -- ranking factors and reasons, model linkage, and timing-template provenance
  -- all live inside. Fragment ids plus a text hash must not remain clear: a
  -- retained D1 backup plus the R2 release catalogue would otherwise
  -- reconstruct deleted prose offline.
  evidence_enc BLOB NOT NULL,
  evidence_key_version INTEGER NOT NULL,
  evidence_nonce TEXT NOT NULL,

  created_at TEXT NOT NULL,
  UNIQUE (reading_id, paragraph_id),
  UNIQUE (reading_id, paragraph_order),
  FOREIGN KEY (reading_id, user_id) REFERENCES daily_readings(id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_daily_readings_user_date
  ON daily_readings(user_id, local_date DESC);

-- The product invariant the M0 key could not express: at most ONE published
-- reading per user per local day, with no release component, so activating a
-- release mid-day cannot produce two.
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_readings_live
  ON daily_readings(user_id, local_date) WHERE status = 'published';

-- One in-progress successor at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_readings_pending
  ON daily_readings(user_id, local_date) WHERE status = 'pending';

-- Competing reissue chains cannot both claim the same predecessor.
CREATE UNIQUE INDEX IF NOT EXISTS uq_daily_readings_successor
  ON daily_readings(supersedes_reading_id) WHERE supersedes_reading_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reading_sources_reading
  ON reading_sources(reading_id, paragraph_order);

CREATE INDEX IF NOT EXISTS idx_reading_sources_user
  ON reading_sources(user_id);

-- ---------------------------------------------------------------------------
-- cycle_instances + cycle_passes
-- ---------------------------------------------------------------------------

ALTER TABLE cycle_instances ADD COLUMN pass_count INTEGER NOT NULL DEFAULT 1;

-- Parent key for cycle_passes' composite foreign key. Two individually valid
-- foreign keys would not make a cross-user pass impossible.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cycle_instances_id_user
  ON cycle_instances(id, user_id);

CREATE TABLE IF NOT EXISTS cycle_passes (
  id           TEXT PRIMARY KEY NOT NULL,
  cycle_id     TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES users(id),
  pass_index   INTEGER NOT NULL CHECK (pass_index >= 1),
  direction    TEXT NOT NULL CHECK (direction IN ('direct', 'retrograde')),
  exact_at     TEXT NOT NULL,
  speed_deg_per_day REAL NOT NULL,
  created_at   TEXT NOT NULL,
  UNIQUE (cycle_id, pass_index),
  FOREIGN KEY (cycle_id, user_id) REFERENCES cycle_instances(id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_cycle_passes_user_exact
  ON cycle_passes(user_id, exact_at);

-- ---------------------------------------------------------------------------
-- Migration self-check
-- ---------------------------------------------------------------------------
--
-- The rebuilds above are only correct if nothing was silently dropped. These
-- assertions run inside the same transaction as the rebuild, so a failure rolls
-- the whole migration back rather than leaving a half-converted schema.

INSERT INTO assertion_probe (id, reason)
SELECT 1, 'assertion_probe must be empty - a guard row survived'
WHERE EXISTS (SELECT 1 FROM assertion_probe);

INSERT INTO assertion_probe (id, reason)
SELECT 1, 'daily_readings must be empty after the rebuild'
WHERE EXISTS (SELECT 1 FROM daily_readings);

INSERT INTO assertion_probe (id, reason)
SELECT 1, 'reading_sources must be empty after the rebuild'
WHERE EXISTS (SELECT 1 FROM reading_sources);

