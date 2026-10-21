# Identity module — Phase 2

Implemented: patient registration/activation, password login, mandatory TOTP MFA,
single-use recovery codes, sessions and refresh rotation/reuse detection,
own profiles, account/password lifecycle, and controlled doctor/admin provisioning.

Routes bind controllers and HTTP security middleware. Controllers validate with Zod
and return explicit DTOs. Services enforce policy and use constructor-injected
ports. Repositories contain typed SQL. The composition root supplies
transaction-bound identity, audit and idempotency repositories.

No booking/clinical functionality or frontend is implemented. Setup delivery is
queued encrypted; an operator CLI supports manual local delivery, not email sending.
See `docs/identity-security.md` for contracts, controls and limitations.
