CREATE FUNCTION guard_consultation_lifecycle() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='scheduled' AND NEW.status IN ('in_progress','cancelled','no_show')) OR
    (OLD.status='in_progress' AND NEW.status='completed')
  ) THEN RAISE EXCEPTION 'Invalid consultation transition' USING ERRCODE='23514'; END IF;
  IF OLD.status='completed' AND (
    NEW.clinical_notes IS DISTINCT FROM OLD.clinical_notes OR
    NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
  ) THEN RAISE EXCEPTION 'Finalized clinical records are immutable' USING ERRCODE='23514'; END IF;
  IF NEW.clinical_notes IS DISTINCT FROM OLD.clinical_notes AND OLD.status <> 'in_progress' THEN
    RAISE EXCEPTION 'Notes require an in-progress consultation' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consultation_lifecycle_guard BEFORE UPDATE ON consultations FOR EACH ROW EXECUTE FUNCTION guard_consultation_lifecycle();
ALTER TABLE prescriptions ADD COLUMN correction_of uuid REFERENCES prescriptions(id) ON DELETE RESTRICT,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revocation_reason text CHECK(revocation_reason IN ('clinical_correction','issued_in_error'));
CREATE INDEX prescriptions_consultation_history_idx ON prescriptions(consultation_id,version DESC);
CREATE FUNCTION guard_prescription_lineage() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND (NEW.consultation_id,NEW.doctor_id,NEW.version,NEW.correction_of) IS DISTINCT FROM
    (OLD.consultation_id,OLD.doctor_id,OLD.version,OLD.correction_of) THEN
    RAISE EXCEPTION 'Prescription identity is immutable' USING ERRCODE='23514';
  END IF;
  IF NEW.correction_of IS NOT NULL AND NOT EXISTS(SELECT 1 FROM prescriptions p WHERE p.id=NEW.correction_of
    AND p.consultation_id=NEW.consultation_id AND p.doctor_id=NEW.doctor_id AND p.version<NEW.version AND p.status<>'draft') THEN
    RAISE EXCEPTION 'Invalid prescription correction lineage' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prescription_lineage_guard BEFORE INSERT OR UPDATE ON prescriptions FOR EACH ROW EXECUTE FUNCTION guard_prescription_lineage();
CREATE FUNCTION guard_payment_state() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.consultation_id,NEW.amount_minor,NEW.currency) IS DISTINCT FROM (OLD.consultation_id,OLD.amount_minor,OLD.currency) THEN
    RAISE EXCEPTION 'Payment identity and amount are immutable' USING ERRCODE='23514'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status='pending' AND NEW.status IN ('authorized','failed','cancelled')) OR
    (OLD.status='authorized' AND NEW.status IN ('paid','failed','cancelled')) OR
    (OLD.status='paid' AND NEW.status='refund_pending') OR
    (OLD.status='refund_pending' AND NEW.status='refunded')
  ) THEN RAISE EXCEPTION 'Invalid payment transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_state_guard BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION guard_payment_state();
CREATE TABLE job_receipts (
  job_id uuid PRIMARY KEY REFERENCES outbox_jobs(id) ON DELETE RESTRICT,
  kind text NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX slots_time_analytics_idx ON availability_slots(starts_at,id);
CREATE INDEX consultations_slot_status_idx ON consultations(slot_id,status);
CREATE INDEX audit_action_time_idx ON audit_logs(action,occurred_at DESC,id DESC);
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='amrutam_api') THEN GRANT SELECT ON job_receipts TO amrutam_api; END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='amrutam_worker') THEN
    GRANT SELECT,INSERT ON job_receipts TO amrutam_worker;
    GRANT INSERT ON outbox_jobs TO amrutam_worker;
    REVOKE SELECT ON users,profiles,consultations,prescriptions,audit_logs FROM amrutam_worker;
    GRANT SELECT(id,status) ON consultations TO amrutam_worker;
  END IF;
END $$;
