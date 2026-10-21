# Phase 3 implementation and verification report

Date: 21 October 2026 (Asia/Calcutta). Repository: `/workspace/amrutam-telemedicine-backend`.
Scope: doctor availability, booking/cancellation, concurrency, idempotency and
public doctor discovery. Phase 4 is not started. This is not a production-readiness claim.

## Implemented

- Doctor-owned future availability creation, listing and blocking; active-doctor gates.
- Existing half-open overlap exclusion and partial unique occupancy index retained.
- Migration 0007 adds blocked-slot INSERT locking/guard and transactional directory revision.
- Patient-token-derived booking identity; row-level slot locking; future/open/occupancy checks.
- Cancellation for owning patient, assigned doctor or admin; reason/state/time policy.
- PostgreSQL actor-scoped idempotency, encrypted original results and 24h replay windows.
- Booking/cancellation transition, audit, outbox and idempotency response in one transaction.
- Literal name, exact specialty, live available-range search; bounded deterministic pagination.
- Explicit-offset instants normalized to UTC; validated IANA hint, no local-time inference.
- Public-only Redis directory pages with DB generation invalidation and bounded fallback.
- All endpoints use existing MFA/live authorization, shared ingress and operation limits.
- OpenAPI, architecture/sequence/ER, security/data documents and original-PDF checklist updated.

No runtime dependency was added. Package/lock metadata is version 0.3.0. No NestJS,
frontend, live payment gateway, external notification call or paid cloud provisioning.
Existing repository remote is preserved; no commit/push was performed.

## Commands and results

| Exact command/check                                                                                             | Result                                                                                          |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `npm install --package-lock-only --ignore-scripts`                                                              | PASS; metadata synchronized                                                                     |
| `npm run format`                                                                                                | PASS                                                                                            |
| `npm run format:check`                                                                                          | PASS                                                                                            |
| `npm run typecheck`                                                                                             | PASS; strict TypeScript                                                                         |
| `npm run lint`                                                                                                  | PASS; no warnings/errors                                                                        |
| `npm run build`                                                                                                 | PASS                                                                                            |
| `npm run openapi:generate`                                                                                      | PASS                                                                                            |
| `npm run openapi:check`                                                                                         | PASS; generated artifact current                                                                |
| `npm test`                                                                                                      | PASS: **51 tests in 7 files**, including complete SwaggerParser OpenAPI validation              |
| `node --env-file=work/test.env node_modules/vitest/vitest.mjs run tests/integration`                            | PASS: **96 tests in 3 files**: 20 foundation/schema, 41 identity/security, 35 booking/discovery |
| `npm audit --audit-level=high --json > work/phase3-npm-audit.json`                                              | PASS; zero known vulnerabilities at every severity                                              |
| `docker build --secret id=npm_ca,src=/etc/ssl/certs/ca-certificates.crt --tag amrutam-backend:local .`          | Final container verification recorded below                                                     |
| `docker compose --env-file work/compose.env config --quiet`                                                     | Final container verification recorded below                                                     |
| `docker compose --env-file work/compose.env up --no-build -d --wait`                                            | Final container verification recorded below                                                     |
| `docker compose --env-file work/compose.env run --rm --no-deps migrate node dist/entrypoints/migrate.js status` | Final container verification recorded below                                                     |
| `git diff --check` and source/secret inventory                                                                  | Final completion check recorded below                                                           |

**147 tests pass across 10 files.** All 100 pre-existing Phase 1/2 tests remain;
47 new Phase 3 tests are added. The migration suite now checks seven versions,
including complete clean down/up, checksum rejection and failed-migration rollback.
No required database test was skipped. Test database name must end `_test` and
Redis test database must be `/15`; both are reset. Test fixtures represent trusted
completed activation/MFA state; real enrollment/login cryptography is exercised
in the preserved Phase 2 suite. Main API operations use the restricted `amrutam_api`
role; fixture preparation and fault injection use only the isolated database owner.

All Docker invocations use the explicit local daemon wrapper:

```sh
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS \
    -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock ...
```

HTTP socket tests and local database/Docker commands require local network/socket
access in this managed environment. Configured proxy/registry settings are retained;
build CA is mounted only during networked steps and TLS verification remains on.
Ignored owner-only work/security.env, work/compose.env and work/test.env supply
local configuration. Their values are never included in source or this report.

## Required concurrency and recovery evidence

| Scenario                                                     | Observed result                                                                                     |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 100 simultaneous patients, different booking keys, same slot | Exactly **1 HTTP 201**, **99 HTTP 409**; 1 consultation, audit and booking outbox event             |
| 100 simultaneous identical booking retries                   | **100 HTTP 201**, identical bodies; 1 consultation, audit, idempotency row and logical outbox event |
| 100 simultaneous identical cancellation retries              | **100 HTTP 200**, identical bodies; 1 cancellation transition/audit/outbox event                    |
| Lost booking response/API process replacement                | Fresh API graph replays original result from PostgreSQL; no second booking                          |
| Changed booking/cancellation payload                         | 409 for same actor/operation key and changed authorized payload                                     |
| Expired key or revoked session                               | 409 or 401; no recreated booking or event                                                           |
| Cancellation/rebooking and blocking/booking races            | Slot lock serializes transitions; never more than one non-cancelled occupant                        |
| Audit, outbox or idempotency-completion failure              | Booking/cancellation fully rolls back; same key succeeds after failure is removed                   |
| Availability audit failure                                   | Creation/blocking rolls back; same-key recovery succeeds                                            |
| Redis cache failure/corruption                               | Real closed cache connection and malformed entry fall back to live PostgreSQL                       |
| Cache generation changes during hit                          | Cached page is discarded; fresh snapshot returned                                                   |
| Redis security enforcement failure                           | Preserved Phase 2 tests reject with 503; fallback does not bypass MFA/rate limits                   |

These are local correctness/concurrency checks, not a load test or SLO measurement.
The distinct-patient test uses 100 parallel HTTP requests with a 20-connection API
pool; PostgreSQL queues contend for one slot lock. Same-key retries are additionally
serialized by actor/session and idempotency locks. No Redis ownership key exists.

## Security and data checks

Cross-doctor writes and cancellation, cross-patient cancellation, doctor/admin booking,
challenge-token availability access, unauthenticated access and patientId mass
assignment are rejected. Live account/version/revocation checks remain authoritative.
Time/state checks reject past slots and late/in-progress/completed/no-show cancellation.
Coded reasons avoid free-text clinical data in this flow. Public directory and booking
DTOs omit credentials and clinical fields. Outbox payloads contain only consultationId;
audit metadata omits patient/clinical/reason payloads. SQL is parameterized and name
wildcards are escaped. Strict filter/body schemas reject unknown fields and arrays.

## Findings resolved during implementation

Initial type/lint passes caught Date operand types, missing test schema imports and
untyped response assertions; these were corrected without weakening rules. Complete
OpenAPI validation found a reference to Empty instead of the existing EmptyRequest;
it is fixed and validated. An initial restricted-sandbox unit invocation could not
bind HTTP sockets (EPERM); the same suite passed with approved local socket access.
No source workaround, disabled security control or reduced test assertion was used.

## Known limitations and outstanding assignment work

- Outbox records are pending; worker delivery/leases/backoff/idempotent consumers and
  automated setup email remain unimplemented. No external delivery was attempted.
- Replay expiry is enforced but physical security/idempotency retention cleanup is pending.
- Availability has no recurrence, unblock, move or delete API; none was requested.
  UTC/offset instants are authoritative; IANA timezone is a validated hint, not stored.
- Offset pagination can shift across independent requests during concurrent edits;
  deep-scale cursor evolution remains a measured future choice.
- No new patient-overlap or cross-slot scheduling rule was invented. The mandatory
  guarantee is one non-cancelled occupant per slot plus no overlapping doctor slots.
- Directory caching still queries PostgreSQL for its generation. It deliberately
  fails rather than serves stale metadata if the authoritative database is down.
- Full Redis outage blocks API security enforcement with 503 despite cache fallback.
  Shared-IP thresholds, pool limits and timeout defaults need production tuning.
- GitHub Actions is defined and discovers all tests, but hosted execution is unverified.
  No production release, image vulnerability scan or independent penetration test.
- Clinical lifecycle/prescriptions, analytics, consumers, full telemetry, production
  infrastructure/CD, load/latency/availability and backup/DR proof remain outstanding.
- Previous Phase 2 recovery/email/retention/operational limitations still apply.

The original PDF traceability remains in implementation-checklist.md. Phase 3 stops
here; Phase 4 requires explicit approval. No production readiness is claimed.

## Final container and source checks

The existing local database upgraded from six to seven migrations without editing
applied files. Final API liveness/readiness/OpenAPI return 200; discovery, availability
and booking without authentication return 401. The runtime contract is version
0.3.0 and contains the new paths. API runs as uid 1000 with database role
amrutam_api. It can read directory generation but cannot update it directly (42501).
Worker readiness returns 200, uid is 1000, and no AUTH_ variables are present.
API/worker then stop gracefully with exit codes 0; PostgreSQL/Redis remain running.

The source inventory contains 153 authored files: 22 created, 21 modified and 8
removed empty placeholders versus Phase 2. Generated dependencies/build output and
ignored work files are excluded. Local generated credentials/key material were
checked against authored source/config/docs with no matches. No .env file exists
or is tracked. No commits, pushes or external messages were made.

`npm run format:check`, `npm run openapi:check`, `git diff --check`, ignore rules and
complete inventory checks pass. No executed check has an unresolved failure. Hosted
CI, image vulnerability scanning, production deployment and SLO evidence remain
unverified as listed above. See phase3-files.md for every created/modified/removed path.
