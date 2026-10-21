# Prescriptions module

Implemented in Phase 4: Encrypted doctor-authored drafts, optimistic editing, immutable finalization, linked correction versions, revocation and audited patient-safe retrieval.

Routes/controllers, services/domain ports and SQL repositories remain separate.
Constructor injection is wired in the explicit composition root. See
`docs/clinical-payments-jobs.md` and the generated OpenAPI contract.
