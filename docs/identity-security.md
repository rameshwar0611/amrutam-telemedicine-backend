# Identity and security contract — Phase 2

Status: implemented identity foundation; no production-readiness, capacity or SLO
claim. See OpenAPI for exact inputs/responses and `phase2-verification.md` for evidence.

## States and authentication boundaries

Accounts progress `pending_activation → pending_mfa → active`. Disabled accounts
cannot authenticate or replay protected results. Reactivation requires an admin,
does not skip activation/MFA, and never restores old sessions. Existing Phase 1
rows are not automatically activated by migration 0006.

Public registration accepts patient fields only, always returns the same 202
message, performs Argon2id work before checking account existence, and queues
encrypted setup delivery for newly created accounts. Repeated email registration
cannot replace passwords or elevate roles. A high-entropy single-use setup token
activates the account only when the recipient supplies a new/current chosen password.
This replaces any password from public registration, preventing credentials chosen
by a pre-registrant from surviving the legitimate recipient's activation. A setup
token alone never issues an enrollment challenge. The same chosen password may be
used again by the legitimate registrant; existing active accounts cannot be reset
through this single-use pending-account flow.
No email provider/delivery consumer is configured. The audited operator export is
the controlled local/manual delivery path; tokens never appear in registration output.

Password verification returns a short-lived **challenge**, never an access token.
Unknown users use a randomized dummy Argon2id hash. Invalid, inactive, disabled and
unknown account login failures share the same public error. This reduces enumeration
signals; it is not a claim of constant end-to-end response timing under load.

Argon2id uses 64 MiB memory, 3 iterations, parallelism 1, randomized salt. Registration
and new-password inputs are 12–128 characters with a UTF-8 byte bound. Passwords
are never trimmed, normalized, logged or reversibly encrypted.

## JWT and session policy

Ed25519/EdDSA signatures use explicitly configured key IDs. Verification restricts
algorithm, trusted key ID, issuer, audience, token type, subject/session/flow shape,
issued-at, expiration, maximum age and maximum lifetime. `alg=none`, symmetric
substitution, missing expiry, wrong audience/issuer/type and future-issued tokens
are rejected. Access and challenge token types cannot be substituted for each other.

Defaults: access 5 minutes (configuration capped at 15); challenge 5 minutes;
absolute refresh-session lifetime 7 days; setup token 1 hour. Session rotation does
not extend absolute expiry. Full tokens are created only after successful TOTP or
recovery-code verification. Every protected request checks live user status, role,
auth version, session ownership, revocation, expiry, activation and MFA assurance.
No cached authorization decisions or fail-open behavior are used.

Refresh credentials combine a session UUID with 256 random bits. Session/history
tables store only purpose-bound HMAC-SHA256 digests with a separate secret pepper.
Credential responses also exist as encrypted idempotency ciphertext for the documented
retry flow; they are never plaintext token columns. Rotation and used-token
history commit atomically. Reusing a known consumed credential with a new key—or
outside the retry window—revokes the family. Guessing a wrong credential for a known
session does not revoke it. History covers all generations, not only the last token.

Logout revokes its session. Its route alone permits a still-valid access JWT from
an already revoked session to repeat the harmless logout. That exception cannot
read profiles, provision users, or obtain tokens. Password changes, deactivation and
admin status changes increment auth version and revoke all affected sessions in
the same transaction. Pending challenges with old versions become invalid too.

## MFA policy and the approved disclosure exception

TOTP uses a cryptographically random 160-bit secret, SHA1 interoperability, 6 digits,
30-second periods and a ±1 timestep window. Secrets are AES-256-GCM encrypted with
user-bound associated data. Accepted timesteps advance through a conditional database
update, so a timestep cannot authorize multiple independent operations, including
concurrent requests and different challenges.

The **only approved seed disclosure** is the `otpauth` provisioning URI during a
password-authenticated enrollment challenge. Its logical response can be replayed
for 30 seconds by default with the same challenge, key and payload. It is encrypted
at rest, non-cacheable and unavailable after enrollment confirmation. New keys do
not retrieve the existing URI. A replacement enrollment consumes earlier enrollment
flows, and composite FK ownership binds a factor to its user/flow. No raw seed field
exists in ordinary DTOs, logs, audits or setup-delivery payloads.

An invalid MFA attempt increments a durable per-flow counter. Identical failed
retries do not increment it twice; five independent failures lock that flow. A
fresh password login is rate-limited and must obtain another flow. A successful
TOTP/recovery verification consumes the flow.

Ten random 256-bit recovery codes are disclosed for the one logical confirmation
operation; the recovery-code table stores only purpose-bound HMAC digests, and the
replayable response is encrypted as described above. Consumption is conditional
and single-use. Regeneration requires current password, recent MFA and a fresh
unused TOTP, invalidating all old codes atomically. Lost-device reset after all
recovery codes are lost is not implemented; there is no insecure MFA-reset bypass.

## Roles and resource ownership

- Patient/doctor/admin accounts can access only their own identity profile/session
  resources. A target identifier in a path does not override ownership.
- Only an active MFA-authenticated admin can provision a doctor/admin or change
  account status. These operations require MFA within five minutes.
- Provisioning does not create a usable default password or bypass MFA. Doctor
  directory activation follows the account's security state.
- Admins cannot disable/deactivate themselves through these routes, avoiding an
  accidental last-admin lockout. Roles cannot be patched onto a patient account.
- Initial admin bootstrap is an operator-only command, serialized with a PostgreSQL
  advisory lock. It is unavailable once an admin exists and audits rejection.
- Future booking/clinical services must enforce their own assignment/ownership
  policies; those APIs do not exist in this phase.

## Idempotency and transaction contract

Every implemented HTTP mutation requires an 8–128 character idempotency key. Keys
are scoped to the operation and actor or verified authentication flow/credential
generation. Canonical payload fingerprints use HMAC to avoid offline password/code
guessing from request hashes. All stored response bodies are encrypted with
scope/key-bound associated data. Reusing a scoped key with a different body returns 409. PostgreSQL uniqueness and row locks serialize duplicates across replicas.

User changes, token consumption/rotation, MFA counters, audit events and idempotency
results share one transaction and connection. There are no Redis/provider calls in
that transaction. Mandatory audit failure rolls business state back. Failed MFA
attempts instead return an outcome so counters/audit commit before HTTP error mapping.

Login/activation challenge results replay briefly within challenge validity; full
MFA/token responses and enrollment URIs use the shorter 30-second retry window.
Refresh retries require the original credential and key; knowing a key alone is
insufficient. Cached token responses must still match a current, unrevoked session
and its latest refresh generation. Passwords are reverified for login retries.
Protected replay rechecks authorization before returning data. Following revocation
or auth-version changes, retry may return 401 rather than replay a stale success.

Profile/account operation records have a 24-hour replay window. Expired records
return 409 and require a fresh key. **Replay expiry is enforced, but physical
deletion of expired ciphertext/flows/history is not automated yet.** Retention
maintenance remains a later worker/operations requirement.

## Rate limits and transport protections

Redis atomically counts fixed-window buckets. Login has uniform per-account and
per-IP limits; registration has a stricter IP limit; MFA/activation, refresh,
protected reads/writes and provisioning have separate operation buckets. Defaults
include a shared pre-authentication ingress limit of five times `AUTH_IP_LIMIT`
per IP/minute. It executes before authorization and its audit writes. Rate-limit
denial audit is recorded once per bucket/window, preventing rejected floods from
causing unbounded database audit growth. Other authentication failures remain audited.
Operation defaults
are documented in code/config: 10 login attempts per account per 15 minutes,
5 registrations/IP/hour, 30 MFA requests/IP/15 minutes, plus actor limits for
protected operations. Login/IP settings are configurable. Denial returns 429 and
Retry-After; Redis failure rejects with 503 rather than bypassing enforcement.

Forwarded addresses are untrusted by default. `TRUST_PROXY_CIDRS` accepts only
explicit trusted ingress addresses/CIDRs, rejecting blanket `/0` trust. A real
deployment must configure and test its actual ingress topology and capacity limits.
Shared/NAT/IPv6 traffic and brute-force policies need production tuning; tests do
not establish real-world anti-bot effectiveness.

Zod strict objects reject unknown privileged fields and malformed input. SQL is
parameterized. Explicit DTOs never return credential hashes or database rows.
Bodies are bounded, all responses use no-store, and errors omit raw validation
values, stack traces, SQL and configuration credentials. Bearer tokens are not
cookies; no cookie-based authentication or permissive CORS is introduced.

## Audit, keys and operational limits

Identity, authentication, MFA, role/resource denials, rate-limit events and privileged
changes emit whitelisted metadata. No request bodies, passwords, bearer/refresh/setup
tokens, seeds, URIs, recovery values/hashes or email addresses are copied into audit
metadata. Security failures may have both a specific event and a request-denied
event; successful idempotent business retries do not duplicate their change event.
HTTP logs omit authorization/cookies, bodies and query strings.

JWT public-key maps allow staged signing-key rotation. AES envelopes retain key
versions so older data can be decrypted while new writes use the current key.
Private/encryption/pepper values come from environment configuration, never source.
Rotating the pepper requires revoking sessions/challenges and reissuing setup/recovery
credentials as appropriate. Production key custody, rotation drills, backup-key
recovery, KMS integration and ciphertext retention maintenance remain operations work.

Local tests use disposable PostgreSQL/Redis and in-memory random test keys. Container
runtime uses a non-owner DB role, non-root user and read-only filesystem. Multi-AZ
deployment, storage encryption, SLO/load evidence, full telemetry, alerting, backup/DR
exercises and independent penetration testing are not verified by this phase.

Conflicting MFA confirmation/verification retries consume the same durable five-attempt
budget as new guesses, even after a successful response. The stored original retry
result is not overwritten. Authenticated recovery-code regeneration also has a
per-account limit of five requests per 15 minutes, including failed factor proofs.
