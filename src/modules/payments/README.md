# Payments module

Implemented in Phase 4: Admin-managed internal accounting records and state graph; asynchronous cancellation/no-show compensation through a deterministic fake refund boundary. No real gateway or booking dependency.

Routes/controllers, services/domain ports and SQL repositories remain separate.
Constructor injection is wired in the explicit composition root. See
`docs/clinical-payments-jobs.md` and the generated OpenAPI contract.
