DROP FUNCTION cleanup_security_records(integer);
DROP FUNCTION maintain_audit_partitions();
ALTER TABLE outbox_jobs DROP COLUMN trace_parent;
-- The NOLOGIN/operational role is retained; independently managed login lifecycle.
