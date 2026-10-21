CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL CHECK (length(password_hash) >= 20),
  role text NOT NULL CHECK (role IN ('patient', 'doctor', 'admin')),
  status text NOT NULL DEFAULT 'pending_mfa' CHECK (status IN ('pending_mfa', 'active', 'disabled')),
  auth_version integer NOT NULL DEFAULT 1 CHECK (auth_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_normalized_email CHECK (email = lower(btrim(email)) AND length(email) BETWEEN 3 AND 254)
);

CREATE TABLE profiles (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
  phone text,
  time_zone text NOT NULL DEFAULT 'UTC' CHECK (length(time_zone) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE doctors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  public_name text NOT NULL CHECK (length(btrim(public_name)) BETWEEN 1 AND 200),
  specialty text NOT NULL CHECK (length(btrim(specialty)) BETWEEN 1 AND 100),
  biography text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX doctors_specialty_active_idx ON doctors (lower(specialty), id) WHERE active;
CREATE INDEX doctors_name_search_idx ON doctors USING gin (public_name gin_trgm_ops) WHERE active;

CREATE TABLE availability_slots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slots_positive_duration CHECK (ends_at > starts_at),
  CONSTRAINT slots_id_doctor_unique UNIQUE (id, doctor_id),
  CONSTRAINT slots_no_doctor_overlap EXCLUDE USING gist (
    doctor_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  )
);
CREATE INDEX slots_doctor_time_idx ON availability_slots (doctor_id, starts_at, id);
CREATE INDEX slots_open_time_idx ON availability_slots (starts_at, id) WHERE status = 'open';

CREATE TABLE consultations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slot_id uuid NOT NULL,
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  patient_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled', 'no_show')),
  clinical_notes jsonb CHECK (clinical_notes IS NULL OR is_encryption_envelope(clinical_notes)),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  no_show_at timestamptz,
  cancellation_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT consultation_slot_doctor_fk FOREIGN KEY (slot_id, doctor_id)
    REFERENCES availability_slots(id, doctor_id) ON DELETE RESTRICT,
  CONSTRAINT consultation_id_doctor_unique UNIQUE (id, doctor_id),
  CONSTRAINT consultation_state_timestamps CHECK (
    (status = 'scheduled' AND started_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL AND no_show_at IS NULL)
    OR (status = 'in_progress' AND started_at IS NOT NULL AND completed_at IS NULL AND cancelled_at IS NULL AND no_show_at IS NULL)
    OR (status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL AND completed_at >= started_at AND cancelled_at IS NULL AND no_show_at IS NULL)
    OR (status = 'cancelled' AND started_at IS NULL AND completed_at IS NULL AND cancelled_at IS NOT NULL AND no_show_at IS NULL AND cancellation_reason IS NOT NULL AND length(btrim(cancellation_reason)) > 0)
    OR (status = 'no_show' AND started_at IS NULL AND completed_at IS NULL AND cancelled_at IS NULL AND no_show_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX consultations_one_occupant_per_slot ON consultations (slot_id) WHERE status <> 'cancelled';
CREATE INDEX consultations_patient_date_idx ON consultations (patient_id, created_at DESC, id DESC);
CREATE INDEX consultations_doctor_date_idx ON consultations (doctor_id, created_at DESC, id DESC);
CREATE INDEX consultations_status_date_idx ON consultations (status, created_at, id);

CREATE TABLE prescriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE RESTRICT,
  doctor_id uuid NOT NULL REFERENCES doctors(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized', 'revoked')),
  clinical_payload jsonb NOT NULL CHECK (is_encryption_envelope(clinical_payload)),
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT prescription_author_fk FOREIGN KEY (consultation_id, doctor_id)
    REFERENCES consultations(id, doctor_id) ON DELETE RESTRICT,
  CONSTRAINT prescription_version_unique UNIQUE (consultation_id, version),
  CONSTRAINT prescription_finalized_time CHECK (
    (status = 'draft' AND finalized_at IS NULL) OR (status <> 'draft' AND finalized_at IS NOT NULL)
  )
);
CREATE UNIQUE INDEX prescriptions_one_current_finalized ON prescriptions (consultation_id) WHERE status = 'finalized';
CREATE INDEX prescriptions_doctor_idx ON prescriptions (doctor_id);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL REFERENCES consultations(id) ON DELETE RESTRICT,
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'authorized', 'paid', 'refund_pending', 'refunded', 'failed', 'cancelled')),
  provider_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payments_provider_reference_unique ON payments (provider_reference) WHERE provider_reference IS NOT NULL;
CREATE INDEX payments_consultation_idx ON payments (consultation_id, created_at);

CREATE TABLE audit_logs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES users(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  resource_type text NOT NULL CHECK (length(resource_type) BETWEEN 1 AND 100),
  resource_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('success', 'failure', 'denied')),
  request_id uuid,
  trace_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  PRIMARY KEY (occurred_at, id)
) PARTITION BY RANGE (occurred_at);

DO $$
DECLARE month_start date; month_end date;
BEGIN
  FOR offset_month IN 0..2 LOOP
    month_start := (date_trunc('month', CURRENT_DATE) + make_interval(months => offset_month))::date;
    month_end := (month_start + interval '1 month')::date;
    EXECUTE format('CREATE TABLE %I PARTITION OF audit_logs FOR VALUES FROM (%L) TO (%L)',
      'audit_logs_' || to_char(month_start, 'YYYY_MM'), month_start::text || ' 00:00:00+00', month_end::text || ' 00:00:00+00');
  END LOOP;
END;
$$;
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
CREATE INDEX audit_actor_time_idx ON audit_logs (actor_id, occurred_at DESC);
CREATE INDEX audit_resource_time_idx ON audit_logs (resource_type, resource_id, occurred_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['users', 'profiles', 'doctors', 'availability_slots', 'consultations', 'prescriptions', 'payments'] LOOP
    EXECUTE format('CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()', table_name);
  END LOOP;
END;
$$;
