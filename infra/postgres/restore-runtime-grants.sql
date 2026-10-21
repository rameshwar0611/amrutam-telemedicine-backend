-- Run as the database owner after pg_restore --no-acl, before enabling runtime access.
-- Login roles/passwords are provisioned separately; never embed them in this file.
BEGIN;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, amrutam_api, amrutam_worker, amrutam_maintenance;
REVOKE ALL ON FUNCTION invalidate_doctor_directory(), maintain_audit_partitions(), cleanup_security_records(integer)
  FROM PUBLIC, amrutam_api, amrutam_worker, amrutam_maintenance;
GRANT USAGE ON SCHEMA public TO amrutam_api, amrutam_worker, amrutam_maintenance;
GRANT SELECT ON users, profiles, doctors, availability_slots, consultations, prescriptions, payments,
  audit_logs, outbox_jobs, auth_sessions, mfa_factors, mfa_recovery_codes, auth_tokens,
  idempotency_records, auth_flows, refresh_token_history, doctor_directory_revision, job_receipts TO amrutam_api;
GRANT INSERT, UPDATE ON users, profiles, doctors, availability_slots, consultations, prescriptions, payments,
  auth_sessions, mfa_factors, mfa_recovery_codes, auth_tokens, idempotency_records, outbox_jobs, auth_flows TO amrutam_api;
GRANT INSERT ON audit_logs, refresh_token_history TO amrutam_api;
GRANT DELETE ON auth_sessions, mfa_recovery_codes, auth_tokens, idempotency_records TO amrutam_api;
GRANT SELECT ON doctors, availability_slots, payments, outbox_jobs, job_receipts TO amrutam_worker;
GRANT SELECT (id, status) ON consultations TO amrutam_worker;
GRANT SELECT (id, expires_at) ON idempotency_records, auth_tokens, auth_sessions TO amrutam_worker;
GRANT DELETE ON idempotency_records, auth_tokens, auth_sessions TO amrutam_worker;
GRANT INSERT ON audit_logs, outbox_jobs, job_receipts TO amrutam_worker;
GRANT UPDATE ON payments, outbox_jobs TO amrutam_worker;
GRANT EXECUTE ON FUNCTION maintain_audit_partitions(), cleanup_security_records(integer) TO amrutam_maintenance;
DO $$ BEGIN
  IF has_function_privilege('amrutam_api','cleanup_security_records(integer)','EXECUTE')
    OR has_function_privilege('amrutam_worker','maintain_audit_partitions()','EXECUTE')
    OR has_table_privilege('amrutam_worker','prescriptions','SELECT')
    OR has_column_privilege('amrutam_worker','consultations','clinical_notes','SELECT')
    OR has_table_privilege('amrutam_maintenance','users','SELECT')
    OR has_table_privilege('amrutam_api','audit_logs','UPDATE') THEN
    RAISE EXCEPTION 'Restored runtime privilege assertions failed';
  END IF;
END $$;
COMMIT;
