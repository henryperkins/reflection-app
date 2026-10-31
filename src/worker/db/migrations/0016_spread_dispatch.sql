-- Commit before image egress. A missing durable result after this marker is
-- uncertain and must never authorize another recognition call for this intent.
ALTER TABLE generation_requests ADD COLUMN spread_dispatch_id TEXT;
CREATE UNIQUE INDEX generation_spread_dispatch ON generation_requests(spread_dispatch_id)
  WHERE spread_dispatch_id IS NOT NULL;
