DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='amrutam_worker') THEN
  REVOKE SELECT(id,status) ON consultations FROM amrutam_worker;
  GRANT SELECT ON users,profiles,consultations,prescriptions,audit_logs TO amrutam_worker;
  REVOKE INSERT ON outbox_jobs FROM amrutam_worker;
 END IF;
END $$;
DROP INDEX audit_action_time_idx;
DROP INDEX consultations_slot_status_idx;
DROP INDEX slots_time_analytics_idx;
DROP TABLE job_receipts;
DROP TRIGGER payment_state_guard ON payments;
DROP FUNCTION guard_payment_state();
DROP TRIGGER prescription_lineage_guard ON prescriptions;
DROP FUNCTION guard_prescription_lineage();
DROP INDEX prescriptions_consultation_history_idx;
ALTER TABLE prescriptions DROP COLUMN correction_of,DROP COLUMN revision,DROP COLUMN revoked_at,DROP COLUMN revocation_reason;
DROP TRIGGER consultation_lifecycle_guard ON consultations;
DROP FUNCTION guard_consultation_lifecycle();
