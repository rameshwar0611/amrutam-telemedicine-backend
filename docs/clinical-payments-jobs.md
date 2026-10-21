# Phase 4 clinical, accounting, compliance and worker contract

All routes use the existing Express composition root, strict Zod, live MFA/session
and RBAC checks, limits, safe errors and no-store responses. Services depend on
constructor-injected domain ports. Only repositories execute SQL. No frontend,
real gateway, video platform or paid cloud service is introduced.

## Consultation state and clinical access

Assigned doctors can transition scheduled -> in_progress within [slot start,end),
in_progress -> completed after start, and scheduled -> no_show at/after slot end.
Existing cancellation permits scheduled -> cancelled strictly before start with
owner/assigned-doctor/admin policies. Other transitions return 409. PostgreSQL also
rejects invalid transitions; terminal records cannot return to earlier states.

Owning patients and assigned doctors can GET booking metadata. Assigned doctors
can PUT notes only in_progress; expectedVersion prevents concurrent lost updates.
Notes contain bounded summary/assessment/plan fields and are AES-256-GCM encrypted
with fresh IV and consultation-bound associated data. Completion freezes notes,
started_at and completed_at at the database layer. Notes are optional; the API does
not invent a mandatory clinical-content rule. There is no finalized-note overwrite
or correction endpoint in this phase. Later corrections need append-only design.

Only assigned doctors and owning patients after completion may decrypt notes.
Admins have no clinical-content API permission. Reads and mandatory access audits
share a transaction; audit failure returns an error without clinical content.
Notes, medication contents and plaintext encrypted-response values are never put
in audit metadata, logs, directory cache or outbox payloads. Authorized clinical
responses contain the requested plaintext by design; their DTOs exclude envelopes,
keys, hashes and internal fields. All clinical access is audited.

## Prescription versions

Assigned doctors can create drafts for in_progress/completed consultations, edit
drafts with expectedRevision, finalize and revoke using coded reasons. A consultation
row lock serializes version allocation and all prescription mutations. Draft contents
are encrypted with prescription-ID-bound associated data. Each version has a distinct
ID and increasing consultation version; edits increase the draft revision.

Where a current finalized prescription exists, a new draft must name correctionOf.
Finalizing that correction atomically revokes the linked predecessor and finalizes
the successor, with audits/outbox records for both. Existing ciphertext/history is
preserved. Database guards protect authorship, immutable identity/lineage and finalized
contents; the existing partial index permits one current finalized version. Concurrent
competing finalizations return one success and one state conflict.

Patients can retrieve only their own currently finalized prescriptions; drafts and
revoked versions are not exposed. Assigned doctors see audited version history with
bounded pagination. Admins and other patients/doctors cannot read clinical contents.
Revocation reasons are clinical_correction or issued_in_error, not free-text notes.

## Internal accounting and compensation boundary

Payments are internal records, not proof of an actual money transfer. Booking never
checks for payment. Recent-MFA admins create amount/currency records and manage:

- pending -> authorized, failed, cancelled
- authorized -> paid, failed, cancelled
- paid -> refund_pending
- refund_pending -> refunded (worker only)

Amounts/currency/consultation identity are immutable in PostgreSQL. No card data,
provider credentials or user-controlled callback URL is accepted. API DTO amounts
are decimal strings of minor units; creation accepts safe bounded integers. Owning
patients and admins can read audited accounting DTOs; doctor access is denied.
Capture/authorization is rejected after cancellation/no_show, and new records cannot
be created against those terminal consultations.

Cancellation/no_show and its event commit together. A worker consumes that event
and compensates every associated pending/authorized record to cancelled, and every
paid record to refund_pending plus a unique refund job. Refunds use a constructor-
injected deterministic fake adapter. Its input binds payment ID, amount, currency
and stable refund key; duplicates across process restarts return one reference.
It performs no network call and moves no money. The adapter boundary deliberately
runs after SQL preparation and before a separate completion transaction.

A crash after the fake call but before commit can repeat the call. Logical identity
is stable; the payment transition/audit/receipt/ack commit once. This is at-least-once
processing with idempotent effects, not exactly-once external execution. A real
provider would need durable provider idempotency, result reconciliation, deadlines,
and credentials; none is integrated or claimed. Terminal failures leave refund_pending
visible for operator reconciliation; no automatic unsafe refund reset is exposed.

## Durable outbox processing

Worker polls with WORKER_POLL_MS (default 1000), leases one due row using FOR UPDATE
SKIP LOCKED, increments attempts, and assigns a fresh owner UUID/lease expiry.
WORKER_LEASE_MS defaults to 30000. Expired leases can be reclaimed; owner, attempt,
status and expiry fencing prevent stale completion/failure. A final abandoned lease
becomes failed/LEASE_EXHAUSTED rather than stuck processing.

Business event handlers validate minimal ID-only payloads. Consultation/prescription/
payment events without a configured external destination create a durable processing
receipt only; they do not pretend to send notifications. Cancellation/no_show performs
accounting compensation; payment.refund_requested invokes the fake boundary. Encrypted
identity.setup_delivery remains pending on the audited manual delivery path: the worker
receives no decryption/JWT keys and cannot read users, prescriptions, clinical notes
or audit history. It can read terminal consultation IDs/status for compensation.

job_receipts has one row per outbox job and is committed with logical effects and
acknowledgement. Redelivery after commit does not repeat the effect. Transient failures
release the lease and schedule exponential backoff capped at 60 seconds, multiplied by
uniform jitter in [0.5,1]. Attempts are bounded by max_attempts (default 8). Malformed
or unsupported jobs fail immediately. Only fixed safe error codes are persisted/logged;
raw errors and payloads are excluded. Receipt/audit/ack failures roll back effects.
Shutdown interrupts idle polling and awaits active work before closing dependencies;
a forced shutdown relies on lease recovery. There is no manual replay API yet.

## Admin audit, analytics and job visibility

Recent-MFA admins can query audit logs, analytics and job status. Inputs require an
explicit [from,to) range of at most 31 days, limit 1–100 (default 20) and offset
0–10000. Query access itself is audited; failed audit persistence prevents disclosure.
Audit filters are actor/resource IDs, exact action and outcome. Responses omit
metadata/payloads and expose only identifiers, action, time, outcome and request ID.
Audit remains append-only and monthly partitioned, with a fallback partition.
Job queries filter creation range/status and expose safe attempts/lease/error state,
not payloads, credentials, ciphertext or ownership tokens.

Analytics use one PostgreSQL statement/snapshot and return statement_timestamp as
asOf. Counts use scheduled starts in the requested range, including cancelled and
rebooked consultations as distinct bookings. Totals include bookings, completed,
cancellations and noShows; optional doctorId filters totals and utilization. Doctor
pagination does not truncate global totals. Utilization clips open-slot seconds to
the range: booked seconds / offered seconds, where any non-cancelled occupant
(including no_show) consumes booked capacity. Zero capacity gives zero utilization.
Blocked capacity is excluded; utilization is capacity reservation, not attendance.
The result is computed live, uncached, with documented freshness. No 100k/day or
latency SLO claim follows from bounded local correctness tests.

## Remaining operational boundaries

Physical retention cleanup, monthly partition maintenance, production encryption/key
custody, real email delivery, full telemetry/alerts, staged deployment/CD, independent
security review, load/SLO evidence and backup/DR drills remain pending. No regulatory
certification is implied. Original requirements remain tracked. Phase 4 stops here;
Phase 5 requires explicit approval.
