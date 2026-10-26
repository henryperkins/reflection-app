-- A registration is not proof of recent existing-passkey authentication.
ALTER TABLE auth_sessions ADD COLUMN passkey_authenticated_at INTEGER;
