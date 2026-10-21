CREATE FUNCTION guard_audit_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Audit records are append-only' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION guard_audit_immutability();

CREATE FUNCTION guard_prescription_immutability() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.status <> 'draft' THEN
    RAISE EXCEPTION 'Issued prescriptions cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  IF OLD.status <> 'draft' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.clinical_payload IS DISTINCT FROM OLD.clinical_payload
    OR NEW.consultation_id IS DISTINCT FROM OLD.consultation_id
    OR NEW.doctor_id IS DISTINCT FROM OLD.doctor_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
    OR NEW.status NOT IN ('finalized', 'revoked')
    OR (OLD.status = 'revoked' AND NEW.status <> 'revoked')
  ) THEN
    RAISE EXCEPTION 'Issued prescription contents are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER prescription_immutable BEFORE UPDATE OR DELETE ON prescriptions
  FOR EACH ROW EXECUTE FUNCTION guard_prescription_immutability();

CREATE FUNCTION guard_slot_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.doctor_id, NEW.starts_at, NEW.ends_at) IS DISTINCT FROM (OLD.doctor_id, OLD.starts_at, OLD.ends_at)
    AND EXISTS (SELECT 1 FROM consultations WHERE slot_id = OLD.id) THEN
    RAISE EXCEPTION 'A slot with consultation history cannot be moved' USING ERRCODE = '23514';
  END IF;
  IF NEW.status = 'blocked' AND EXISTS (
    SELECT 1 FROM consultations WHERE slot_id = OLD.id AND status IN ('scheduled', 'in_progress')
  ) THEN
    RAISE EXCEPTION 'Cancel the consultation before blocking this slot' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER slot_history_guard BEFORE UPDATE ON availability_slots
  FOR EACH ROW EXECUTE FUNCTION guard_slot_history();

CREATE FUNCTION guard_consultation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.slot_id, NEW.doctor_id, NEW.patient_id) IS DISTINCT FROM
     (OLD.id, OLD.slot_id, OLD.doctor_id, OLD.patient_id) THEN
    RAISE EXCEPTION 'Consultation booking identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER consultation_identity_guard BEFORE UPDATE ON consultations
  FOR EACH ROW EXECUTE FUNCTION guard_consultation_identity();

-- Compose creates these LOGIN roles before migrations. Managed environments must
-- provision equivalent roles separately; migrations never create login secrets.
DO $$
DECLARE runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['amrutam_api', 'amrutam_worker'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = runtime_role) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', runtime_role);
      EXECUTE format('GRANT SELECT ON users, profiles, doctors, availability_slots, consultations, prescriptions, payments, audit_logs, outbox_jobs TO %I', runtime_role);
      EXECUTE format('GRANT INSERT ON audit_logs TO %I', runtime_role);
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'amrutam_api') THEN
    GRANT SELECT ON auth_sessions, mfa_factors, mfa_recovery_codes, auth_tokens, idempotency_records TO amrutam_api;
    GRANT INSERT, UPDATE ON users, profiles, doctors, availability_slots, consultations, prescriptions, payments,
      auth_sessions, mfa_factors, mfa_recovery_codes, auth_tokens, idempotency_records, outbox_jobs TO amrutam_api;
    GRANT DELETE ON auth_sessions, mfa_recovery_codes, auth_tokens, idempotency_records TO amrutam_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'amrutam_worker') THEN
    GRANT SELECT (id, expires_at) ON idempotency_records, auth_tokens, auth_sessions TO amrutam_worker;
    GRANT UPDATE ON payments, outbox_jobs TO amrutam_worker;
    GRANT DELETE ON idempotency_records, auth_tokens, auth_sessions TO amrutam_worker;
  END IF;
END;
$$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
