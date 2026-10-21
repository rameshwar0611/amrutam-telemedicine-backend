# Database design — Phase 2

PostgreSQL 17; UUID identifiers; timezone-aware instants; UTC infrastructure;
integer money in minor units. `pg` returns bigint as strings to avoid silent
JavaScript precision loss; Kysely types reflect this. IANA timezone validation
belongs to later API schemas. Database timestamps are maintained by update triggers.

## Migration contract

| Version | Purpose                                                                 |
| ------- | ----------------------------------------------------------------------- |
| 0001    | Trusted extensions, timestamp trigger, encryption-envelope shape helper |
| 0002    | Eight required core tables, indexes, partitioned audit                  |
| 0003    | Sessions, MFA factors/recovery codes, one-use setup/recovery tokens     |
| 0004    | Idempotency and durable outbox                                          |
| 0005    | Clinical/audit/history guards and existing runtime-role grants          |

The runner checks source history, uses a dedicated connection/advisory lock and
applies each version in a transaction. SQL up/down pairs are checksummed together.
Down reverses one version. Extensions and the history table intentionally survive
complete rollback. Role creation is infrastructure bootstrap, not a schema migration.

Migration 0006 adds activation state, owned auth flows and consumed refresh-token history.

## Tables and access paths

| Table               | Relationships and constraints                                                       | Main indexes                                                  |
| ------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| users               | Normalized unique email; role/status values; authentication version                 | Email unique                                                  |
| profiles            | One profile per user; restricted deletion                                           | User primary key                                              |
| doctors             | One doctor per user; explicit public fields                                         | User unique; specialty/active; public-name trigram            |
| availability_slots  | Doctor FK; positive interval; globally non-overlapping ranges per doctor            | Doctor/time; open/time; GiST exclusion                        |
| consultations       | Patient FK; composite slot/doctor FK; lifecycle timestamps; encrypted-note envelope | Occupying slot unique; patient/date; doctor/date; status/date |
| prescriptions       | Composite consultation/doctor FK; positive version; immutable issued payload        | Consultation/version unique; current finalized unique; doctor |
| payments            | Consultation FK; nonnegative bigint amount; currency/status checks                  | Consultation/date; provider reference unique when present     |
| audit_logs          | Optional actor FK; append-only; partition-compatible primary key                    | Actor/time; resource/time                                     |
| auth_sessions       | User FK; unique token hashes; family and expiry; rotation metadata                  | User/live; family; expiry                                     |
| mfa_factors         | One TOTP factor per user; encrypted secret envelope; accepted timestep              | User unique                                                   |
| mfa_recovery_codes  | User FK; unique stored code hash; one-use timestamp                                 | User/unconsumed                                               |
| auth_tokens         | User FK; setup/recovery purpose; unique token hash; expiry                          | User/purpose; expiry                                          |
| idempotency_records | Optional actor; scoped key; fingerprint; result and expiry                          | Scope/key unique; expiry; actor                               |
| outbox_jobs         | Unique logical job key; retry count; lease/status consistency                       | Pending availability; expired leases                          |

## Booking invariants

Intervals are half-open `[start,end)`, allowing adjacent appointments. Blocked slots
also participate in overlap prevention. A non-cancelled consultation occupies its
slot permanently, including completed/no-show history. Cancelled consultations
allow rebooking but preserve history. A slot with any consultation history cannot
be moved. A booked scheduled/in-progress slot cannot simply be blocked.

The unique index is the final race protection, not a complete booking workflow.
Services must still authorize the patient/doctor, lock the slot consistently, check
it is open/future, and write idempotency/audit/outbox in one transaction. These are
explicitly later-phase responsibilities. Role/profile consistency and lifecycle
transition policy are also service responsibilities; foreign keys do not replace RBAC.

## Audit partitioning and permissions

Migration creates the current UTC calendar month and next two monthly partitions,
plus a default partition so out-of-range audit events remain durable. Parent indexes
cover partitions. Runtime roles have no direct child-table privileges or audit
update/delete/truncate privileges. A trigger additionally rejects row updates/deletes.
Database owners remain privileged; this is not claimed as tamper-proof storage.

Partition creation/archival and fallback monitoring are future jobs. Creating a new
partition when matching rows exist in the fallback requires a controlled evacuation
and attach procedure. Do not simply create overlapping partitions or drop audit data.

## Security and retention boundaries

Clinical and MFA fields accept ciphertext-envelope-shaped JSON, not plaintext objects.
Clinical encryption remains future work. Phase 2 implements identity MFA/setup/retry encryption; production key custody and rotation drills remain outstanding.
Session/setup/recovery tables contain one-way hashes. Identity retry responses and
setup delivery are additionally retained as encrypted ciphertext for their documented
flows; replay expiry is enforced, while automated physical deletion remains future work.

Clinical/financial history is protected with restricted FK deletion rather than
automatic cascades. Retention periods are not invented: jurisdiction and business
policy are unspecified. Future maintenance uses controlled operational privileges,
not runtime schema ownership. Payment tracking does not imply a live gateway.

## Phase 2 additions

`users` now defaults to `pending_activation` and records activation time; legacy
rows are not silently activated. `auth_tokens.requires_password` retains setup metadata; current activation always
requires a recipient-chosen password regardless of legacy flags. `auth_flows` persists purpose, version,
expiry, consumption and a five-failure cap. A composite FK binds pending MFA setup
to its user/flow; confirmation clears that transient link. `refresh_token_history`
retains consumed hashes with session-cascade cleanup. Both tables have appropriate
owner/time access paths. Worker cannot read these secrets or MFA/refresh hashes.

Identity services now execute the security workflows and encrypt MFA/retry/setup
payloads. At the Phase 2 boundary clinical encryption/consumers were pending; Phase 4 implementation is described below.
All encrypted response records have enforced replay expiry; automated physical
retention cleanup remains future work. Do not edit prior applied migration files.

## Phase 3 additions

Migration 0007 leaves migrations 0001–0006 unchanged. Existing half-open GiST
exclusion and partial unique slot occupancy indexes remain authoritative. The
new consultation INSERT guard locks the slot and rejects blocked slots, closing
the blocking/inserting race for direct database writers too. Booking/cancellation
services lock doctor -> slot -> consultation in a consistent order after live
authorization and idempotency claims. All business/audit/outbox/result writes share
a transaction. Foreign keys and historical identity guards remain unchanged.

`doctor_directory_revision` contains one boolean-keyed generation UUID. Fixed
search-path triggers update it in the same transaction as doctor or relevant
account changes. API role can SELECT it but cannot directly UPDATE it. Cached
public directory pages are namespaced by generation; slot availability is never
cached. No patient/doctor overlap rules beyond the assignment are invented.

## Phase 4 additions

Migration 0008 retains 0001–0007 unchanged. It enforces consultation transitions
and immutable completed notes, adds prescription correction lineage/revisions/revocation
metadata, payment state/amount guards, job_receipts and audit/analytics access indexes.
Worker leases/fencing are persisted in the existing outbox table. Its privileges
exclude users, prescriptions, clinical notes and audit history; terminal consultation
status is readable for compensation. Job effects/receipt/audit/ack commit together.
Legacy fixtures now traverse valid lifecycle transitions; cleanup includes receipts.

## Phase 5 migration 0009

Adds nullable validated W3C traceparent to outbox rows. No core table or Phase 1–4
constraint is replaced. Fixed-search-path SECURITY DEFINER maintenance functions
create current/next-three audit partitions and perform bounded expired-security
cleanup with a seven-day grace. Only the separate maintenance role may call them;
API/worker are denied. No audit/clinical data is automatically deleted. Existing
fallback rows prevent automatic partition attachment and are reported for review.
Logical no-ACL restores must reapply `infra/postgres/restore-runtime-grants.sql`.
