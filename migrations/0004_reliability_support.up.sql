CREATE TABLE idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  scope text NOT NULL CHECK (length(scope) BETWEEN 1 AND 300),
  key text NOT NULL CHECK (length(key) BETWEEN 8 AND 255),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status smallint,
  response_body jsonb,
  response_encrypted boolean NOT NULL DEFAULT false,
  resource_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT idempotency_scope_key_unique UNIQUE (scope, key),
  CHECK (expires_at > created_at),
  CHECK ((status = 'in_progress' AND response_status IS NULL) OR
    (status = 'completed' AND response_status IS NOT NULL AND response_status BETWEEN 200 AND 599)),
  CHECK (NOT response_encrypted OR (response_body IS NOT NULL AND is_encryption_envelope(response_body)))
);
CREATE INDEX idempotency_expiry_idx ON idempotency_records (expires_at);
CREATE INDEX idempotency_actor_idx ON idempotency_records (actor_id);

CREATE TABLE outbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (length(kind) BETWEEN 1 AND 100),
  deduplication_key text NOT NULL UNIQUE CHECK (length(deduplication_key) BETWEEN 1 AND 300),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
  available_at timestamptz NOT NULL DEFAULT now(),
  leased_by text,
  lease_until timestamptz,
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (attempts <= max_attempts),
  CHECK ((status = 'processing' AND leased_by IS NOT NULL AND lease_until IS NOT NULL)
    OR (status <> 'processing' AND leased_by IS NULL AND lease_until IS NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE INDEX jobs_pending_idx ON outbox_jobs (available_at, id) WHERE status = 'pending';
CREATE INDEX jobs_expired_lease_idx ON outbox_jobs (lease_until) WHERE status = 'processing';
CREATE TRIGGER set_updated_at BEFORE UPDATE ON outbox_jobs FOR EACH ROW EXECUTE FUNCTION set_updated_at();
