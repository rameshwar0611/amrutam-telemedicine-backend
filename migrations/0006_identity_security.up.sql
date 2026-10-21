ALTER TABLE users DROP CONSTRAINT users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check
  CHECK (status IN ('pending_activation', 'pending_mfa', 'active', 'disabled'));
ALTER TABLE users ADD COLUMN activated_at timestamptz;
ALTER TABLE users ALTER COLUMN status SET DEFAULT 'pending_activation';
-- Existing Phase 1 rows may represent fixtures/imports; do not silently activate them.
ALTER TABLE auth_tokens ADD COLUMN requires_password boolean NOT NULL DEFAULT false;

CREATE TABLE auth_flows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  auth_version integer NOT NULL CHECK (auth_version > 0),
  purpose text NOT NULL CHECK (purpose IN ('enroll', 'verify')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT auth_flows_id_user_unique UNIQUE (id, user_id),
  CHECK (expires_at > created_at)
);
CREATE INDEX auth_flows_user_idx ON auth_flows(user_id);
CREATE INDEX auth_flows_expiry_idx ON auth_flows(expires_at);
ALTER TABLE mfa_factors ADD COLUMN enrollment_flow_id uuid;
ALTER TABLE mfa_factors ADD CONSTRAINT mfa_flow_owner_fk FOREIGN KEY (enrollment_flow_id, user_id)
  REFERENCES auth_flows(id, user_id) ON DELETE RESTRICT;

CREATE TABLE refresh_token_history (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  session_id uuid NOT NULL REFERENCES auth_sessions(id) ON DELETE CASCADE,
  used_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_history_session_idx ON refresh_token_history(session_id);

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='amrutam_api') THEN
    GRANT SELECT, INSERT, UPDATE ON auth_flows TO amrutam_api;
    GRANT SELECT, INSERT ON refresh_token_history TO amrutam_api;
  END IF;
END $$;
