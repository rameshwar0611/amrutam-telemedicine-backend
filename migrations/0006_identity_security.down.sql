-- Refuse a destructive downgrade until newly introduced lifecycle states are handled explicitly.
ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('pending_mfa', 'active', 'disabled'));
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'pending_mfa';
DROP TABLE refresh_token_history;
ALTER TABLE mfa_factors DROP COLUMN enrollment_flow_id;
DROP TABLE auth_flows;
ALTER TABLE auth_tokens DROP COLUMN requires_password;
ALTER TABLE users DROP COLUMN activated_at;
