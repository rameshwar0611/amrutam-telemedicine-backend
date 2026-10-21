# Audit module — Phase 2

The module owns the audit port and PostgreSQL append-only writer. Identity/security
services append redacted events using the same transaction as their business write.
Failures such as bad MFA preserve attempt counters and audit events by returning
an outcome from the transaction before HTTP error handling.

Rows and monthly partitions retain Phase 1 protections. Administrative audit-query
APIs, clinical-access audit emission, archival and partition-maintenance jobs are
not implemented yet. Database-owner tamper resistance is not claimed.
