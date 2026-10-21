-- Role grants disappear automatically as their target tables are rolled back.
DROP TRIGGER consultation_identity_guard ON consultations;
DROP FUNCTION guard_consultation_identity();
DROP TRIGGER slot_history_guard ON availability_slots;
DROP FUNCTION guard_slot_history();
DROP TRIGGER prescription_immutable ON prescriptions;
DROP FUNCTION guard_prescription_immutability();
DROP TRIGGER audit_immutable ON audit_logs;
DROP FUNCTION guard_audit_immutability();
