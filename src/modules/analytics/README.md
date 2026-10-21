# Analytics module

Implemented in Phase 4: Recent-MFA admin audit queries, live bounded-date analytics with asOf and doctor utilization, plus safe terminal-job visibility.

Routes/controllers, services/domain ports and SQL repositories remain separate.
Constructor injection is wired in the explicit composition root. See
`docs/clinical-payments-jobs.md` and the generated OpenAPI contract.
