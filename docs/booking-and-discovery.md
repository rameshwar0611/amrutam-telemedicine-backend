# Phase 3 booking and discovery contract

The API is Express/TypeScript with constructor injection and an explicit root.
The bookings module owns availability, booking and cancellation. Doctors owns
public directory queries/cache policy. Controllers validate HTTP; services enforce
policy; repositories alone execute SQL. All business endpoints require a live,
active, MFA-complete session and use existing shared/operation rate limits.

## Implemented endpoints

| Method/path                                            | Policy and behavior                                                                                                                  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| GET /v1/doctors                                        | All authenticated roles; name substring, exact specialty and whole-slot availableFrom/availableTo filters; public directory DTO only |
| GET /v1/doctors/:doctorId/availability                 | Other users see future open unoccupied slots; owner doctor also sees blocked, occupied and historical slots                          |
| POST /v1/doctors/:doctorId/availability                | Owning doctor only; future slots; PostgreSQL overlap exclusion; Idempotency-Key required                                             |
| PATCH /v1/doctors/:doctorId/availability/:slotId/block | Owning doctor only; future unoccupied slots; no unblocking/moving/deleting endpoint                                                  |
| POST /v1/consultations                                 | Patient only; body contains only slotId; patient ID is derived from authenticated actor                                              |
| POST /v1/consultations/:consultationId/cancel          | Owning patient, assigned doctor or admin; scheduled state strictly before slot start                                                 |

Cancellation uses coded reasons: patient_request for patients, doctor_unavailable
for doctors, any of the defined codes (including administrative) for admins. No
free-text clinical data is accepted here. Responses omit notes, hashes, seeds and
internal doctor account identifiers. Nonowners cannot modify availability or cancel
another patient's/doctor's consultation. Admins cannot create availability as doctors.

## Transaction and lock protocol

1. Revalidate and lock the actor user/session using the existing authorization service.
2. Claim the actor/operation-scoped PostgreSQL idempotency row. Unique constraint and
   FOR UPDATE serialize duplicates; changed canonical payloads return 409.
3. Booking obtains a shared doctor row lock, then locks the slot FOR UPDATE and
   rechecks active doctor, future/open state and non-cancelled occupancy.
4. Cancellation authorizes against immutable booking ownership before any replay,
   then locks shared doctor -> slot -> consultation. Blocking follows doctor -> slot.
   Locks on the slot serialize cancellation/rebooking and blocking/booking races.
5. Write the consultation transition, successful audit, one outbox event and encrypted
   original response on the same transaction/connection. Commit before replying.

The GiST exclusion constraint rejects overlapping [start,end) ranges for each doctor,
including blocked ranges; adjacent slots are allowed. The partial unique index
`consultations_one_occupant_per_slot` is the final authority: every status except
cancelled occupies the slot, including completed/no_show history. A new INSERT
trigger also locks/checks the slot against blocked status for direct database writers.
Existing foreign keys, immutable booking identity and historical-slot guards remain.

There is no Redis or external network I/O inside booking transactions. Only local
JSON, HMAC and encryption operations accompany PostgreSQL calls. No payment gateway,
notification call, automatic retry loop or worker side effect runs before commit.
Database/pool timeouts remain bounded. A rollback leaves the original key retryable.
A known transient/unknown response can be retried with the same key and body;
clients should use bounded exponential backoff with jitter for transport/503 errors.
Do not retry 400/403/409 by changing keys automatically. No automatic retry of
arbitrary database failures is implemented or claimed.

## Idempotency and outbox

All new writes require an 8–128 character Idempotency-Key. Scopes bind actor and
operation; resource IDs are included in fingerprints (or resource scope), preventing
cross-resource confusion. Semantically equal RFC3339 instants canonicalize to UTC.
Records retain encrypted original status/body for 24 hours. Successful retries do
not duplicate consultations, audit or events. Booking replay intentionally returns
the original scheduled DTO even if the consultation was later cancelled; it never
books it again. Authorization is checked again before every replay. Expired records
return 409 and need a fresh key; physical cleanup remains pending.

Business validation outcomes inside idempotent operations may also be retained;
for example a slot-occupied response can replay after later cancellation. A newly
intended booking needs a new key. Authorization and unexpected infrastructure
failures roll back. Overlap constraint violations roll back creation's claim.

Outbox kinds are consultation.booked and consultation.cancelled. Their unique keys
are kind:consultationId; payload contains only consultationId, not patient data,
reasons or clinical content. These events are durable records; receipt processing does not imply delivered
notifications. Phase 4 now consumes business events with fenced leases, receipts and bounded
retries; cancelled/no-show events compensate internal payments. See clinical-payments-jobs.md. External consumers must be idempotent
because delivery will be at least once; no exactly-once external delivery is claimed.

## Discovery and cache consistency

Name search uses a literal case-insensitive substring (SQL wildcards escaped),
backed by the existing pg_trgm index. Specialty is a case-insensitive exact match
using the existing lower(specialty) index. Active doctor accounts only. Supplying
both time bounds selects doctors with a whole future open, unoccupied slot inside
the inclusive bounds. Availability is never taken from Redis and is revalidated at
booking; a list result is a point-in-time hint, not a reservation.

Only directory pages without availability filters are cached: id, name, specialty,
biography, pagination. Keys contain a query SHA-256 and PostgreSQL generation UUID;
TTL 30 seconds. Database triggers update the generation transactionally on doctor
changes or account status/role/activation updates. Reads verify generation again
after Redis access. Misses use a repeatable-read DB snapshot of generation and page;
cache writes happen after the transaction. Old-generation entries cannot become
current after Redis returns from an outage; TTL removes obsolete Redis entries.
Revision table writes are restricted to a fixed-search-path trigger function.

Cache read/write waits are bounded to 100ms. Redis errors, invalid JSON and invalid
DTOs fall back to PostgreSQL. Database errors are not masked with stale cache data.
A full Redis outage still returns 503 at the existing security-rate limiter: cache
fallback does not bypass security enforcement. Tests cover both boundaries.

## Time and pagination

Input instants require explicit Z or numeric offset, seconds, and either no fractional
seconds or millisecond precision. All values normalize to UTC and use PostgreSQL
timestamptz. Optional timeZone is a validated IANA presentation hint; it does not
reinterpret the explicit instant and is not stored on slots. Offset-less wall times,
invalid dates and reversed ranges are rejected. DST repeated hours are distinguished
by explicit offsets; no server-local timezone inference is performed.

Lists use limit (1–100, default 20), offset (0–10000, default 0), and hasMore from
limit+1 rows. Doctors sort by lower(name),id; slots by startsAt,id. Ordering is stable
within a data snapshot; independent offset pages can shift during concurrent edits.
Deep/history scale and cursor pagination remain a measured future optimization.

## Audit and limits

Successful logical events: availability.created, availability.blocked,
consultation.booked, consultation.cancelled. Reblocking creates no second transition
or audit. Existing security denials are audited without request payloads. Mandatory
audit failure rolls back the mutation. Outbox/response-persistence failures do too.
Booking/cancellation operation buckets allow 120 requests/actor/minute and at least
120/IP/minute (or configured AUTH_IP_LIMIT); shared pre-auth limits still apply.
This permits 100 authorized retries to reach idempotency without disabling limits.
Availability writes retain the existing 30/actor/minute policy. Real deployment
capacity, shared-IP policy and latency targets require separate measurement.
