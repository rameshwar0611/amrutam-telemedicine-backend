# Threat model — through Phase 5

Scope: implemented REST identity, booking, clinical, payment, worker and operational surfaces.
Cloud controls are configuration only and require deployment verification.

## Assets, actors and boundaries

Assets: identity/profile data, password hashes, MFA material, sessions, signing and
encryption keys, activation credentials, recovery codes, encrypted retry results,
audit history and availability of authentication.

Actors: unauthenticated attackers, authenticated patients/doctors/admins, users with
stolen passwords/tokens, trusted operators, database/host administrators and
dependency suppliers. Entry points are REST routes, operator CLI, env configuration,
Redis/PostgreSQL connections, package/image builds and CI. Browser/frontend, video,
real payment gateway and provider callbacks are not implemented attack surfaces.

Trust boundaries: client → Express validation/authentication; controller → policy
service; transaction → persistence; API → shared limiter; process → secret custody;
operator → setup credential file; build → package registry. Database/host owners
are privileged and can override controls; append-only audit is not tamper-proof.

## Threat/control/evidence mapping

| Threat                               | Controls                                                                                                | Evidence                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Account enumeration                  | Generic registration/credential failures, comparable Argon work, no activation token in public response | Unknown/existing account API tests; no constant-time network claim           |
| Password compromise                  | Argon2id, MFA, bounded inputs, account/IP limits                                                        | Hash work-factor and mandatory-MFA tests                                     |
| Pre-MFA token confusion              | Separate JWT types, flow purpose, server state, no session before MFA                                   | Challenge-as-access and MFA-bypass tests                                     |
| JWT forgery/confusion                | EdDSA allowlist, trusted kid, issuer/audience/type and lifetime verification                            | Tampering, symmetric substitution, missing/future/expired/wrong claims tests |
| TOTP/recovery replay                 | Conditional timestep/code consumption, flow single-use, failure cap, transactions                       | Sequential/concurrent replay and rollback tests                              |
| Refresh theft/replay                 | Opaque high-entropy credentials, purpose-bound hashes, all-generation history, family revocation        | Retry/reuse/older-generation/guessed-token tests                             |
| Stale authorization                  | Live role/status/version/session checks, recent MFA, atomic revocation                                  | Password/status/logout/session-revoke and stale-MFA tests                    |
| Horizontal/vertical escalation       | Strict DTOs, own-resource checks, no public roles, admin provisioning                                   | Cross-user/role, mass-assignment and signed-role mismatch tests              |
| Duplicate writes after lost response | Scoped HMAC fingerprints, row locks, encrypted atomic results, proof revalidation                       | Duplicate/conflicting/concurrent retry tests                                 |
| Partial security update              | One transaction for change, factor/token state, audit and idempotency                                   | Injected audit failures in registration/password/MFA flows                   |
| Secret leakage                       | No raw body/header/query logging, safe errors/DTOs, AEAD, owner-only operator file                      | Response/audit/ciphertext/log redaction tests                                |
| Brute force/resource exhaustion      | Fixed-window shared limits, durable MFA attempts, body caps, pool/query deadlines                       | Limit, malformed-input and fail-closed tests                                 |
| Proxy-header spoofing                | No trust by default; explicit bounded ingress CIDRs                                                     | Spoofed forwarding-header and config tests                                   |
| SQL injection                        | Typed parameterized SQL; no user-built identifiers in application queries                               | Repository review; strict API inputs                                         |
| Supply-chain or secret compromise    | Lockfile, dependency audit, non-root image, ignored local keys                                          | Audit/build checks; hosted CI/image scanning still pending                   |

Activation requires a recipient-chosen password and replaces pre-registration
credentials before issuing a challenge. Regression tests reject token-only activation
and verify that a pre-registrant password is invalid after recipient activation.

## Residual risks and operational assumptions

An attacker with both a consumed refresh credential and its original idempotency key
may replay the latest successful response during the short configured retry window.
This is the deliberate lost-response tradeoff. Outside it, or with another key,
known reuse revokes the family. Keys alone never reveal credentials.

The approved enrollment URI contains the seed; the intended user must provision it
securely. Authenticator compromise, device backup exposure, phishing-resistant MFA
and secure user-side storage are outside this backend's guarantees. No bypass for
lost factors/codes is offered.

Expired retry/setup ciphertext is removed in bounded batches after a seven-day grace by the restricted maintenance process.
Key custody and application/DB/host compromise remain important risks. Redis outage
blocks protected authentication paths rather than weakening limits. Actual ingress,
shared-network limits, operator access, dependency/image policies, monitoring,
backups and recovery require deployment validation before production claims.

No regional compliance certification, clinical safety validation, independent
penetration test, 100k/day capacity, latency SLO or 99.95% availability is claimed.

## Phase 3 booking and discovery threats

| Threat                                       | Control                                                                    | Evidence / residual limits                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Double booking and cancellation race         | Slot FOR UPDATE, unique occupancy index, shared lock order                 | Real 100-patient test and repeated cancellation/block races; no deployment-scale load proof |
| Patient impersonation / cross-doctor edits   | Token-derived patient, ownership checks, strict DTOs                       | Cross-user/role/MFA/mass-assignment API tests                                               |
| Duplicate writes after lost response         | Actor-scoped encrypted SQL idempotency and event deduplication             | 100 retries, API restart replay and payload conflicts; retention window is 24h              |
| Partial commit or missing audit              | Same transaction for booking, audit, response and outbox                   | Injected failures at all three persistence boundaries; same-key recovery                    |
| Stale cache advertises unavailable slot      | Live DB availability filters and booking revalidation                      | Cache never owns slots; list responses are point-in-time hints                              |
| Cache invalidation fails during Redis outage | Transactional DB generation and post-read check                            | Closed cache connection, corrupt data, generation race and recovery tests                   |
| Discovery data exposure / expensive input    | Public-only schema, literal parameterized search, bounded pages and limits | DTO/filter tests; production capacity/rate tuning unverified                                |

Outbox payloads carry only consultationId. Pending jobs are not externally delivered
in Phase 3. Future at-least-once delivery requires idempotent consumers; no exactly-once
external effect is claimed. Redis security-enforcement failures remain fail-closed.

## Phase 4 threats and evidence

| Threat                                     | Control and evidence                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Cross-patient/doctor clinical disclosure   | Assigned/owner policies, strict DTOs, audited reads; API role tests                                |
| Ciphertext substitution                    | Record-bound AES-GCM AAD; swapped notes fail closed                                                |
| Final-record overwrite                     | SQL transition/immutability/lineage guards; API/SQL tests                                          |
| Concurrent prescription authoring          | Consultation lock, monotonic versions, one-current index; competing finalization tests             |
| Unauthorized accounting/capture            | Recent-MFA admin, immutable amount, SQL/API state graph, terminal-consult check                    |
| Duplicate refunds / crash after adapter    | Stable fake key/reference, payment lock, receipt and fenced ack; crash/redelivery tests            |
| Worker data compromise                     | No auth/decryption keys, clinical/prescription/user/audit read privileges removed                  |
| Lease theft/stale worker                   | UUID/attempt/expiry fence and SKIP LOCKED; expired-owner completion rejected                       |
| Retry storms or poison messages            | Bounded jitter/backoff/max attempts, permanent payload/unsupported failures, safe admin visibility |
| Audit exfiltration / large aggregate query | Recent-MFA admin, <=31-day ranges, bounded pages, omitted metadata/payload and access audits       |

Only deterministic fake refunds exist. No real money moves. Business event receipts
do not represent external notifications. Real-provider reconciliation, retention,
production key custody, full monitoring, load/SLO/DR and independent review remain
outstanding. No jurisdictional compliance certification is claimed.

## Phase 5 operational threats

| Threat                                      | Control / residual evidence boundary                                                                                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clinical/credential leakage into telemetry  | Explicit attribute allowlists, template routes, no SQL/raw URLs/headers/bodies/env, collector drop rules; unit and live marker checks. Avoid enabling raw auto-instrumentation or ALB request-target logs.                                        |
| Metrics cardinality / hostile trace context | Bounded route/method/status/job labels, validated traceparent, no user IDs or baggage; sampling and bounded exporter queues. Public trace IDs remain untrusted correlation hints, never authorization.                                            |
| Lost telemetry / exporter outage            | Collector memory limiter, bounded retries/queue, target-down alert; metrics are operational evidence and never slot authority. No durable telemetry delivery guarantee is claimed.                                                                |
| Maintenance privilege escalation            | Separate LOGIN secret; SECURITY DEFINER fixed search_path/UTC, no public schema CREATE, bounded batches/advisory locks, no direct table access; actual role tests.                                                                                |
| Restore loses revocations/grants or keys    | Isolated restore, explicit runtime ACL reapplication/assertions, session reconciliation and separate key-custody recovery; local row/grant drill only.                                                                                            |
| Build/deployment compromise                 | Lockfiles, secret/dependency/image/IaC scans, non-root runtime, immutable image digest, staging branch/environment/OIDC restrictions; hosted policies not yet tested.                                                                             |
| Infrastructure secret exposure              | Secret ARNs/JSON selectors only in task config; worker lacks auth keys; encrypted/private state required because cache token is stored in state. No state/values committed.                                                                       |
| Public edge / cloud misconfiguration        | HTTPS ALB intended public edge, private application/RDS/cache, endpoint-only egress, narrow SG/IAM, deletion protection and backups. Scanner exception AVD-AWS-0053 is documented and expires 2027-01-21. Cloud effectiveness remains unverified. |

No legal retention period for clinical/audit data is assumed. Preserve legal holds;
expired-security cleanup does not delete users, audit history, prescriptions,
consultations, payments or business receipts. Cloud operator/database owner can
still bypass application controls; audit append-only is not external WORM evidence.
