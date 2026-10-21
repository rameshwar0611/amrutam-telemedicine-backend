# Security checklist — through Phase 5

Checked items describe implemented controls; verification evidence is in
`phase2-verification.md`. This is not a compliance certification or penetration test.

- [x] No public doctor/admin registration, role patching or default credentials.
- [x] Single-use activation and owner-only operator export; generic registration response.
- [x] Argon2id with randomized salts, bounded inputs and dummy verification for unknown users.
- [x] Strict asymmetric JWT validation, type separation, expiry/age/lifetime bounds.
- [x] Mandatory MFA before full sessions; encrypted TOTP secrets and replay-safe timesteps.
- [x] Explicitly approved URI-only enrollment disclosure; no ordinary seed/hash exposure.
- [x] Single-use recovery codes; fresh-factor regeneration and persistent failure caps.
- [x] Refresh rotation, all-generation reuse history, revocation and safe retry reconciliation.
- [x] Role and resource ownership checks; authoritative account/session checks per request.
- [x] Recent-MFA gates; auth-version changes revoke old credentials/challenges.
- [x] Strict Zod inputs, bounded bodies, explicit safe DTOs and centralized safe errors.
- [x] Shared endpoint/account/IP limits, no fail-open dependency handling, safe proxy defaults.
- [x] Purpose-bound token/fingerprint HMAC and randomized AES-GCM envelopes with associated data.
- [x] Atomic writes/audit/idempotency, no network side effects inside transactions.
- [x] Audit append-only protections and payload/query/header redaction tests.
- [x] Secrets ignored and supplied through validated environment variables.
- [x] Dependency audit, tests, non-root container and separate runtime/migration identities.
- [x] Key-version/key-ID support and staged rotation compatibility tests.
- [x] Bounded expired-security cleanup with a separate function-only role.
- [ ] Complete key/pepper rotation/recovery drills.
- [ ] Production secret manager/KMS, storage encryption and private-network deployment evidence.
- [x] Clinical authorization, idempotency, encryption and immutable-final tests implemented in Phase 4.
- [ ] Provider setup-email delivery, provider abuse controls and operator recovery procedures.
- [ ] Full metrics/traces/alerts, image scanning and hosted CI/CD evidence.
- [ ] Load/SLO, failover and backup/DR evidence; independent security review.

OWASP coverage includes object/function authorization, broken authentication,
mass assignment, resource exhaustion, injection, security misconfiguration,
sensitive-data exposure and vulnerable dependencies. Public APIs accept no URLs
for server-side fetching and no arbitrary SQL/sort expressions. These controls
do not imply every OWASP risk has been eliminated.

## Phase 3 evidence

- [x] Token-derived patient booking identity; doctor-owned availability; authorized cancellation.
- [x] Existing MFA/live session/RBAC/limits apply to every new business endpoint.
- [x] Database row locks, overlap/occupancy constraints and blocked-slot INSERT guard.
- [x] 100 competing patients, 100 identical booking retries and 100 cancellation retries.
- [x] Atomic audit/outbox/encrypted result; injected failure and same-key recovery tests.
- [x] Strict filter/pagination/offset/date validation and safe public directory DTOs.
- [x] Cache is advisory, versioned in PostgreSQL; cache fallback retains security enforcement.
- [ ] Outbox delivery, physical retention cleanup and production controls remain future work.

## Phase 4 evidence

- [x] Assigned doctor/owner clinical authorization; admins cannot decrypt clinical APIs.
- [x] AES-GCM with record-bound AAD, strict DTOs, no-store and audited reads.
- [x] Completed notes and finalized prescriptions protected against overwrite.
- [x] Prescription correction lineage, serialized versions and patient finalized-only access.
- [x] Payment amount/state guards, recent-MFA writes and fake compensation outside transactions.
- [x] Admin audit/analytics/job queries bounded and audited; metadata/payload omitted.
- [x] Leases/fencing/receipts/backoff/jitter/terminal failures and crash/duplicate tests.
- [x] Worker permissions exclude users, notes, prescriptions and audit-history reads.
- [x] Sensitive plaintext excluded from SQL envelopes, retries, caches, logs and audit metadata.
- [ ] Independent audit, deployment controls, retention and recovery exercises remain pending.

## Phase 5 evidence and remaining gates

- [x] Allowlisted telemetry excludes raw URLs, request content, SQL text, process env and clinical data.
- [x] OTLP configuration rejects credential-bearing endpoints; outbox propagates traceparent only.
- [x] Separate maintenance role cannot directly read clinical/security tables; API/worker cannot execute maintenance.
- [x] Audit partition maintenance preserves fallback conflicts; no audit/clinical deletion policy invented.
- [x] Logical restore reapplies PUBLIC revocations and asserts restricted runtime permissions.
- [x] Private AWS services, encryption/TLS, scoped secret references and short-lived GitHub OIDC defined as code.
- [x] Dependency/image/Terraform/secret scans and local workflow validation have explicit evidence and exceptions.
- [ ] Cloud IAM/TLS/ADOT/EMF/backups/paging and hosted CI/CD execution.
- [ ] Sustained capacity, production SLO, regional failover and independent penetration/security review.

Earlier phase sections are historical evidence. Business outbox consumers, physical
security-record cleanup, partition maintenance and local telemetry are now implemented;
manual setup delivery and cloud-dependent operational validation remain open.
