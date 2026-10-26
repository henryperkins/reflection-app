-- Preserve an honest financial-export state after attributable cost detail expires.
ALTER TABLE provider_dispatches ADD COLUMN cost_expired_at INTEGER;
CREATE INDEX request_event_retention ON request_events(created_at);
CREATE INDEX generation_retention ON generation_requests(state,finished_at);
CREATE INDEX attempt_retention ON generation_attempts(finished_at);
CREATE INDEX dispatch_retention ON provider_dispatches(received_at);
CREATE INDEX security_retention ON security_operations(state,applied_at);
CREATE INDEX cost_retention ON cost_reservations(state,settled_at);
CREATE INDEX deleted_session_retention ON reading_sessions(status,deleted_at);
