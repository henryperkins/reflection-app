-- Receipt metadata survives rejected prose. NULL means unknown, never zero usage.
-- L2 introduces storage; L4 supplies qualified pricing and reconciliation.
ALTER TABLE provider_dispatches ADD COLUMN cached_input_tokens INTEGER
  CHECK(cached_input_tokens IS NULL OR (input_tokens IS NOT NULL AND cached_input_tokens>=0 AND cached_input_tokens<=input_tokens));
ALTER TABLE provider_dispatches ADD COLUMN cache_write_tokens INTEGER
  CHECK(cache_write_tokens IS NULL OR (input_tokens IS NOT NULL AND cached_input_tokens IS NOT NULL AND cache_write_tokens>=0 AND cache_write_tokens<=input_tokens-cached_input_tokens));
ALTER TABLE provider_dispatches ADD COLUMN reasoning_tokens INTEGER
  CHECK(reasoning_tokens IS NULL OR (output_tokens IS NOT NULL AND reasoning_tokens>=0 AND reasoning_tokens<=output_tokens));
ALTER TABLE provider_dispatches ADD COLUMN service_tier TEXT CHECK(service_tier IS NULL OR length(service_tier) BETWEEN 1 AND 32);
