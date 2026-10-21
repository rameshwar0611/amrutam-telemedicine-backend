# Phase 4 verification report

Date: 21 October 2026 (Asia/Calcutta). Repository: `/workspace/amrutam-telemedicine-backend`.
Scope stops after Phase 4; Phase 5 has not started. No production-readiness claim.

## Implemented functionality

Strict assigned-doctor consultation transitions; existing authorized cancellation;
AES-GCM clinical notes with optimistic version checks, immutable completion and
audited owner/doctor access; encrypted prescription drafts/edits/finalization/history,
linked correction versions and revocation; patient finalized-only reads; internal
payment records/state graph without a booking prerequisite; deterministic fake refund
compensation; admin bounded audit/analytics/job queries with recent MFA/access audit;
durable worker leases, fencing, receipts, retry jitter/backoff and terminal visibility.

Migration 0008 adds guards, prescription lineage/revisions/revocation metadata,
job_receipts and query indexes. Migrations 0001–0007 are unchanged. Worker privileges
exclude users, prescription contents, clinical notes and audit history. It receives
no application crypto/JWT keys. All modules retain constructor injection, domain
ports and separate controllers/services/repositories. No dependency was added.

## Exact commands and evidence

| Command/check                                                                                                   | Result                                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `npm install --package-lock-only --ignore-scripts`                                                              | PASS; version 0.4.0 metadata synchronized                                                        |
| `npm run format`                                                                                                | PASS                                                                                             |
| `npm run format:check`                                                                                          | PASS                                                                                             |
| `npm run lint`                                                                                                  | PASS, no warnings/errors                                                                         |
| `npm run typecheck`                                                                                             | PASS, strict TypeScript                                                                          |
| `npm run build`                                                                                                 | PASS                                                                                             |
| `npm run openapi:generate`                                                                                      | PASS                                                                                             |
| `npm run openapi:check`                                                                                         | PASS                                                                                             |
| `npm test`                                                                                                      | PASS: **67 tests across 8 files**, including complete OpenAPI validation                         |
| `node --env-file=work/test.env node_modules/vitest/vitest.mjs run tests/integration`                            | PASS: **140 tests across 5 files**: 20 database, 41 identity, 35 booking, 29 clinical, 15 worker |
| `npm audit --audit-level=high --json > work/phase4-npm-audit.json`                                              | PASS: zero known vulnerabilities at all severities                                               |
| `docker build --secret id=npm_ca,src=/etc/ssl/certs/ca-certificates.crt --tag amrutam-backend:local .`          | Container completion recorded below                                                              |
| `docker compose --env-file work/compose.env config --quiet`                                                     | Container completion recorded below                                                              |
| `docker compose --env-file work/compose.env up --no-build -d --wait`                                            | Container completion recorded below                                                              |
| `docker compose --env-file work/compose.env run --rm --no-deps migrate node dist/entrypoints/migrate.js status` | Container completion recorded below                                                              |
| `git diff --check`, inventory and secret exclusion                                                              | Final completion recorded below                                                                  |

**207 passing tests total**, preserving all 147 prior-phase tests and adding 60.
No database suite is skipped. Isolated TEST_DATABASE_URL must end `_test`; Redis
must use `/15`; both are reset. Main API graph uses restricted amrutam_api and
worker tests use restricted amrutam_worker, with owner-only fixture/fault setup.
Trusted fixture accounts represent completed MFA; real auth flows remain covered
by the 41-test identity suite. Exact latest integration output is in ignored
work/phase4-integration-final.log; logs/configuration are not submission source.

Managed Docker commands use the explicit local daemon wrapper:

```sh
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS \
    -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock ...
```

Socket/database tests require managed local network permission. Inherited proxy,
registry configuration and TLS verification remain enabled. CA material is mounted
only during networked build steps. Ignored local work config supplies credentials;
no values are printed or placed in source. No paid infrastructure was provisioned.

## Security, consistency and recovery checks

- Valid and invalid state/time/terminal transitions, SQL terminal rollback prevention.
- Cross-patient, cross-doctor and admin clinical-content denial; patient mutation denial.
- Notes ciphertext inspection, record-AAD substitution rejection, optimistic concurrent
  edits, safe patient visibility and mandatory read-audit failure without disclosure.
- Prescription encrypted storage, draft visibility, revisions, linked corrections,
  concurrent version allocation/finalization, immutable finalized/revoked contents,
  revoked patient denial and atomic predecessor/successor rollback.
- Internal payment state table, immutable money identity, recent-MFA writes, ownership,
  idempotency conflicts/replay and no payment-dependent booking requirement.
- Cancellation/no_show compensates pending/authorized/paid records; capture denied
  after terminal consultation state; fake refunds are deterministic across restarts.
- Admin audit role/range/filter controls, append-only integrity and audit-failure
  non-disclosure; known analytics fixture yields four bookings, one completion,
  cancellation and no-show, 7200 offered seconds, 5400 booked seconds and 75% usage.
- Two workers lease distinct rows; expired leases reclaim; stale owner cannot complete;
  crash after fake call repeats safely; committed redelivery does not repeat refund.
- Transient backoff/jitter, immediate permanent failures, max-attempt exhaustion and
  abandoned-final-lease failure; safe admin terminal visibility with no payload/raw error.
- Faults in refund audit, receipt and acknowledgement roll back state/audit/receipt/ack;
  later retry completes. Fake adapter executes with no SQL transaction/locks held.
- All prior 100-patient booking, 100 identical booking retries, 100 cancellation retries,
  MFA/recovery/refresh/security/rollback/permission and complete migration regressions pass.

## Resolved findings

The restricted worker initially attempted a consultation row lock, which requires
write privileges. Compensation now reads SQL-enforced terminal state without that
lock and locks only payment rows; no clinical write permission was granted.

The full regression run exposed frozen fixture-clock drift against PostgreSQL
wall-clock timestamp defaults, producing enrollment failures. The test clock now
starts ahead of database wall time; production auth code/configuration is unchanged.
Full identity regressions pass. Earlier schema imports/optional-type/lint issues were
corrected while preserving strict rules. No final assertion was weakened to hide a
failure. Prior fixtures now traverse valid consultation transitions and cleanup
includes receipts; the worker permission assertion was strengthened to expect denial.

## Limitations and remaining PDF requirements

- Fake/internal payments only: no real provider, transfer, financial reconciliation
  deployment or provider-side exactly-once claim. Adapter calls may repeat safely.
- Business event receipts are internal processing evidence, not delivered notifications.
  Encrypted setup delivery remains manual; no email provider is configured.
- No finalized-note correction API, manual failed-job replay API or automatic financial
  recovery override. Prescription correction is implemented with immutable history.
- Retention deletion, job/receipt archival, partition maintenance and full signing/pepper/
  encryption rotation/recovery drills remain unimplemented or operationally unverified.
- Analytics are live, uncached current-state/start-cohort counts, not an event warehouse.
  Offset pages may shift between requests. Semantics and freshness are documented.
- No representative 100k/day load, p95 latency/99.95% availability proof, failover or
  backup/DR evidence, independent pentest, regulatory certification or image scan.
- Hosted GitHub Actions, production deployment/IaC/CD, full metrics/traces/alerts,
  final paginated architecture submission and five-minute demo remain outstanding.

No NestJS, frontend, video calling, real gateway or unrelated product feature was
added. Original PDF requirements remain mapped in implementation-checklist.md.

## Final container and source verification

The existing seven-version local database upgraded to 0008 successfully. API
liveness/readiness/OpenAPI return 200; clinical/admin endpoints without a full
MFA-authenticated token return 401. Contract version is 0.4.0 and includes the new
clinical/admin paths. API runs as uid 1000 and amrutam_api. Worker runs as uid 1000
and amrutam_worker, readiness is 200, no AUTH_ variables exist, and attempts to read
users, clinical notes, prescriptions or audit history fail with 42501.

The live worker process consumed a temporary ID-only consultation.booked smoke
event and committed exactly one receipt. The temporary event/receipt were removed;
no external notification or payment was performed. API/worker then stopped cleanly
with exit codes 0; local PostgreSQL/Redis remain running.

Content-hash inventory versus phase start: 40 created, 31 modified and 16 removed
empty placeholders; 177 current authored files. See phase4-files.md for every path.
Migrations 0001–0007 are byte-for-byte unchanged. Generated dependencies/build/work
files are excluded. Locally generated secrets were checked against authored files
with no matches; no .env exists or is tracked. No commit, push or external message.
Final format/contract/whitespace/ignore/inventory checks pass. No executed check has
an unresolved failure. Unverified production/submission requirements remain listed
above; Phase 5 is not started and requires explicit approval.
