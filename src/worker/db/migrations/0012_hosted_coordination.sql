-- This mirror never establishes exclusion. The Durable Object is independent of D1 rollback.
CREATE TABLE hosted_coordination (
  environment_id TEXT PRIMARY KEY NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch>=0),
  state TEXT NOT NULL CHECK(state IN('offline','validated','online')),
  evidence_hash TEXT CHECK(evidence_hash IS NULL OR length(evidence_hash)=64),
  updated_at INTEGER NOT NULL
);
