# Consultations module

Implemented in Phase 4: Assigned-doctor lifecycle transitions and encrypted, version-checked notes; immutable completed records; audited owner/doctor reads.

Routes/controllers, services/domain ports and SQL repositories remain separate.
Constructor injection is wired in the explicit composition root. See
`docs/clinical-payments-jobs.md` and the generated OpenAPI contract.
