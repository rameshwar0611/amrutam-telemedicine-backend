# Data handling — current controls and remaining operations work

No jurisdiction or regulatory certification is specified. The controls below are
engineering measures, not a claim of HIPAA/GDPR/other certification. Retention and
data-subject policies must be established before real patient data is introduced.

| Classification         | Examples                                                     | Current handling                                                                                          |
| ---------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Public                 | Approved doctor directory name/specialty                     | Separate doctor public fields; directory API/cache not implemented                                        |
| Internal               | Job kind, health, counters, key IDs                          | Bounded operational access; no clinical payloads in HTTP logs                                             |
| Personal               | User email/name/contact/timezone, actor/resource identifiers | Own-profile access; explicit admin provisioning; restricted DB; no email in audit metadata                |
| Clinical               | Notes and prescription contents                              | Schema envelope checks and relationship guards; clinical workflows/encryption not implemented yet         |
| Authentication secrets | Passwords, MFA seeds, setup/refresh/recovery credentials     | Argon2id or purpose-bound HMAC in credential tables; AES-GCM for MFA and authorized delivery/retry copies |
| Cryptographic keys     | JWT private key, encryption key ring, HMAC pepper            | Validated injected env; no source values, no logs; absent from worker/migrator configuration              |

Passwords are never persisted reversibly. Token tables store digests, not raw
credentials. Necessary setup-delivery and idempotent credential responses are
encrypted separately using random IVs, authentication tags, key versions and
context-bound associated data. The approved enrollment URI contains the seed only
for its password-authenticated logical enrollment. Audit/HTTP logs contain none of
those values; ordinary DTOs contain no hashes, seeds or internal database rows.

Sensitive writes, audit events and idempotency results are transactional. Clinical
and financial history cannot be cascaded away through user lifecycle operations;
deactivation disables access rather than deleting historical records. Session
expiry, challenge expiry, single-use credentials and replay windows are enforced.
Expired ciphertext, flows, sessions/history and pending delivery records are not
physically purged by an automated job yet. Their retention cleanup must be added
and tested; replay expiry must not be mistaken for deletion.

Local Docker volume storage/transport is for development, not real patient data.
Production mode rejects unverified DB transport and plaintext Redis URLs, but
deployment/storage encryption, backup encryption, secret custody/KMS, key rotation
and recovery drills are not verified here. Preserve older decryption keys for
retained data/backups; staged public-key rollout is required before signing-key
cutover. Pepper rotation requires credential/session reconciliation, not a blind
environment edit. Limit operator access and protect/delete exported setup files
after their intended manual delivery.

Phase 3 caches only directory pages of doctor id/name/specialty/biography and
pagination for 30 seconds. No patient, booking, availability or clinical content is
cached. All application endpoints still require completed MFA. SQL idempotency
responses containing booking identity are encrypted with purpose-bound associated
data; replay is allowed for 24 hours and physical retention cleanup is pending.
Booking/cancellation outbox records contain only consultationId; audit metadata
omits patient data, free-text reasons and clinical content. Cancellation reasons
are restricted codes. Retention policy and downstream delivery remain future work.

Phase 4 encrypts notes and prescription contents at application level with fresh
AES-GCM nonces and record-bound associated data. Patients read only their own
completed notes/current finalized prescriptions; assigned doctors author/read
clinical history, and admins cannot use clinical-content endpoints. Access auditing
is mandatory and atomic. Finalized contents are preserved; correction creates a
linked prescription version and revokes the predecessor without changing payload.

Admin audit/analytics/job results omit clinical content, audit metadata and job
payloads. Worker has no crypto/JWT keys and cannot read clinical notes, prescriptions,
users or audit history. Its durable receipts contain job ID/kind/time only. Internal
payment records contain amounts/currency/status and deterministic fake references,
not card data; no real provider transaction is represented. Retention/partition
maintenance and production backup/key-custody evidence are still outstanding.

## Phase 5 operational data

Telemetry stores route templates, allowlisted operations/kinds, timing/status and
trace/span IDs, never raw request data or SQL. Local Prometheus/Tempo retention is
7 days/24 hours; deployment must approve production retention and access policies.
Security cleanup deletes only expired flows/tokens/sessions/retry records and
associated obsolete setup payloads after a seven-day grace, with bounded batches
and count-only audit events. Enrollment-referenced flows and all clinical/audit/
account/business history remain. Legal clinical/audit retention and legal holds
require policy approval; none is invented. Backup dumps and Terraform state are
sensitive operational artifacts and remain ignored/private. See backup-dr.md.
