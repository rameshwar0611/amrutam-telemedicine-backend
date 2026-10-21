CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = clock_timestamp();
  RETURN NEW;
END;
$$;

-- Ciphertext envelope shape only. Actual encryption and key access are Phase 2+.
CREATE FUNCTION is_encryption_envelope(value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(value) = 'object'
    AND value ?& ARRAY['ciphertext', 'iv', 'tag', 'key_version']
    AND jsonb_typeof(value->'ciphertext') = 'string'
    AND jsonb_typeof(value->'iv') = 'string'
    AND jsonb_typeof(value->'tag') = 'string'
    AND jsonb_typeof(value->'key_version') = 'string';
$$;
