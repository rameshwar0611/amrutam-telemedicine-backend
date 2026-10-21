# Assignment traceability — after Phase 5

Phases 1–5 are implemented to the evidence boundaries below. This is not a
production-readiness declaration. Phase 1–4 verification/file inventories remain
historical records; current operational evidence is in `phase5-verification.md`
and `phase5-files.md`. No cloud provisioning or hosted execution is implied.

## Phase 2 checklist

- [x] Patient registration, single-use activation, login/logout, own profile and lifecycle.
- [x] Controlled doctor/admin provisioning and one-time operator bootstrap.
- [x] Argon2id and strict short-lived asymmetric JWT verification.
- [x] Refresh rotation, all-generation reuse detection, revocation and own sessions.
- [x] Mandatory TOTP enrollment/confirmation/verification and single-use recovery codes.
- [x] Encrypted secrets, accepted-timestep replay protection and flow attempt caps.
- [x] Patient/doctor/admin RBAC plus resource ownership and recent-MFA checks.
- [x] Strict Zod validation, explicit DTOs and safe centralized errors.
- [x] Shared pre-auth/endpoint/account/actor limits, bounded denial audit, fail-closed Redis.
- [x] Transactional identity/auth/MFA/privileged audit and redacted logs.
- [x] PostgreSQL idempotency, canonical HMAC fingerprints and encrypted credential retries.
- [x] Security configuration, OpenAPI, container/CI definitions and security documents.
- [x] Unit, HTTP, restricted-role PostgreSQL, API, security and operator-CLI tests.
- [ ] Automatic email/setup delivery, physical retention cleanup and production operations.

Only the approved enrollment URI contains the seed. All other DTOs/logs/audits omit
seeds and credential hashes. Known limitations are documented, not marked complete.

## Phase 3 checklist and verification map

| Phase 3 requirement                            | Implementation                                                          | Verification                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1 Availability creation/listing/blocking       | Bookings controller/service/repository                                  | API creation, list visibility, blocking and audit tests               |
| 2 Doctor ownership                             | Doctor actor role + live identity and doctor.user_id checks             | Cross-doctor/patient/challenge/mass-assignment denials                |
| 3 No overlapping slots                         | Existing GiST exclusion, half-open intervals retained                   | Adjacent/overlap API and concurrent SQL regressions                   |
| 4 Patient transactional booking                | Token-derived patient identity; one unit of work                        | Role/mass-assignment tests and successful booking                     |
| 5 No double booking                            | Slot FOR UPDATE, INSERT guard, partial unique occupancy index           | 100 distinct-patient requests: exactly 1 success, 99 conflicts        |
| 6 PostgreSQL idempotency                       | Shared encrypted actor-scoped 24h records                               | Duplicate booking/cancellation and expiry tests                       |
| 7 Replay/conflicting bodies                    | Canonical fingerprint and original status/body                          | 100 identical booking and cancellation retries; changed-body 409      |
| 8 Cancellation                                 | Owner patient, assigned doctor, admin; future scheduled only            | Cross-user/doctor, reasons, state and rebooking races                 |
| 9 Doctor discovery                             | Literal name, exact specialty, whole available time range               | Filtering, wildcard escape and occupancy transitions                  |
| 10 Pagination/time                             | Bounds, deterministic order, explicit offsets, UTC output               | DST/date/range/pagination unit and API cases                          |
| 11 Redis cache/fallback                        | Public metadata only; DB revision, TTL, bounded I/O                     | Hit/invalidation/racing generation/corruption/closed-client fallback  |
| 12 Transactional outbox                        | Unique kind:consultationId; minimal pending payload                     | One logical event under retries; outbox failure rollback              |
| 13 Audit                                       | Four successful transition events, existing security denials            | Deduplication, redaction and injected audit-failure rollback          |
| 14 OpenAPI                                     | All six endpoint paths and request/response/error schemas               | SwaggerParser validation and generated consistency                    |
| 15 Tests                                       | Unit/API/real PG/concurrency/security/failure cases                     | Full Phase 1–3 regression run, not skipped tests                      |
| Atomicity / lost response / no Redis authority | One SQL transaction; replay after API restart; no external calls inside | Faults in audit/outbox/response persistence, cancellation/block races |
| Tooling / local infrastructure                 | Existing nonroot Docker, separate API/worker; migration 0007            | Format/lint/type/build/contract/audit and container health smoke      |

- [x] Phase 3 implementation and local checks above.
- [x] Phase 4 added business outbox consumers; real provider delivery remains unimplemented.
- [ ] Production deployment, SLO/load/DR evidence and independent review remain outstanding.

## Phase 4 implementation and verification map

| Requirement               | Implementation                                                                         | Verification                                                                           |
| ------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1 Strict lifecycle        | Assigned-doctor start/complete/no_show; existing cancellation; SQL transition guard    | Valid/invalid/time/terminal API and SQL cases                                          |
| 2 Ownership               | Live identity/session, doctor authorship and patient ownership                         | Cross-patient/cross-doctor/admin clinical denials                                      |
| 3 Clinical notes          | AES-GCM/AAD, expectedVersion, immutable completion, no-store DTO and read audit        | Ciphertext inspection, swap failure, concurrent edits, audited reads                   |
| 4 Prescription workflow   | Draft/edit/finalize/retrieve/history/revoke/correction                                 | Complete API workflow, version allocation and replay                                   |
| 5 Authorship/immutability | Consult doctor FK, SQL immutable contents/lineage, patient finalized-only              | SQL overwrite/delete guards, current-final uniqueness and access denials               |
| 6 Internal payments       | Admin records, amount/currency immutable, state graph; booking independent             | State table tests, no payment prerequisite and ownership checks                        |
| 7 Compensation boundary   | Cancellation/no_show worker compensation and deterministic fake refund                 | Crash after adapter before commit, stable key/reference, lock-free adapter call        |
| 8 Audit queries           | Recent-MFA admin, bounded filters/page, metadata omitted, access audit                 | Role/query/append-only tests and audit-failure non-disclosure                          |
| 9 Analytics               | Single snapshot, <=31-day start cohort, counts/utilization and asOf                    | Known fixture counts, 75% utilization, zero capacity and range tests                   |
| 10 Durable consumers      | SKIP LOCKED leases, UUID/attempt/expiry fencing, receipts, jitter/backoff/max attempts | Parallel lease, crash/duplicate/exhaustion/permanent-failure/terminal visibility tests |
| 11 Audit coverage         | Clinical access/transitions, prescription, payment and privileged query events         | Redaction and persistence-failure rollback tests                                       |
| 12 Schema/API/env/docs    | Migration 0008, indices, OpenAPI, worker configuration, diagrams and security docs     | Full eight-version migration lifecycle, OpenAPI/static/Docker checks                   |
| 13 Tests/regressions      | 67 unit + 140 integration, retaining all 147 prior tests                               | Full 207-test suite; no DB suite skipped                                               |

- [x] Implemented Phase 4 scope and local correctness verification.
- [x] Physical expired-security cleanup and partition maintenance (Phase 5).
- [ ] Automatic setup-email provider/consumer (manual audited delivery exists).
- [x] Local telemetry, infrastructure/workflow definitions, scans, limited load and logical restore evidence (Phase 5).
- [ ] Hosted CI/CD, deployed infrastructure, sustained capacity, SLO and cloud DR evidence.

## Phase 5 implementation and verification map

| Requirement           | Implementation                                                        | Verification and limits                                                            |
| --------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1 HTTP/PG/worker OTel | Manual allowlisted instrumentation + traceparent outbox               | Unit startup/privacy tests and live API/SQL/isolated-worker trace                  |
| 2 Metrics/logs/traces | OTLP metrics, redacted Pino trace IDs, template spans                 | Real collector metrics/Tempo lookup; no marker leaks                               |
| 3 Local observability | Compose collector/Prometheus/Tempo/Grafana + dashboard                | Local health, scrape target and authenticated dashboard provisioning               |
| 4 Alerts              | Nine Prometheus rules plus native cloud ALB/RDS alarms                | promtool validates nine rules; outbound paging/cloud alarms unverified             |
| 5 Operations          | Probes/drain, bounded pools/exporters, incident runbook               | Compose health, process stop/restart, worker crash regressions                     |
| 6 AWS IaC             | VPC/endpoints/IAM/ECS/ECR/ALB/RDS/cache/KMS/secrets/backups           | fmt/init/validate + Trivy; no plan/apply/deployment                                |
| 7 CI/CD               | Locked build/check workflows + environment-restricted OIDC            | Local actionlint; hosted credential/deployment execution unverified                |
| 8 Deploy safety       | Checksum/advisory migrator, migrate-before-roll, smoke/image rollback | Nine-version migration suite; shell syntax/actionlint; cloud deployment unexecuted |
| 9 Maintenance         | Restricted functions + hourly process/scheduler                       | Seven SQL integration tests + real Compose maintenance run                         |
| 10 Backup/DR          | Logical restore/grants script + RPO/RTO/PITR runbook                  | Disposable target restored/counts/privileges verified; cloud/key drills open       |
| 11 Performance        | Isolated history/rate/burst benchmark and JSON evidence               | 50 writes + 200 reads, 1000 historical; full target remains unproven               |
| 12 Security scans     | npm/Gitleaks/Trivy config and image checks                            | Evidence includes fixes, exception and unresolved vendor findings                  |
| 13 Docs/traceability  | Security/threat/operations/DR/diagrams and all 43 PDF mappings        | Documentation review; four-page PDF prepared; demo video/publication pending       |
| 14 GitHub readiness   | Complete untracked-aware diff/inventory/secret exclusions/procedure   | Branch/remote/status checked, no commit/push/PR; hosted runs open                  |

- [x] Phase 1–4 source preserved and old migrations unchanged.
- [x] Phase 5 local implementation, checks and honest verification inventory.
- [ ] Cloud deployment, hosted CI/CD, sustained performance/availability and cloud DR measurements.
- [ ] Submission packaging, five-minute demo video and approved publication.

## Every original PDF requirement

| ID  | Original requirement                                               | Current evidence and remaining work                                                                                                            |
| --- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| R01 | Production-grade scalability, reliability, security, observability | Workflows and local operational controls implemented; production capacity/reliability certification remains open                               |
| R02 | Git code and infrastructure repository                             | Full source + Terraform + workflows in existing repo; review patch prepared; no commit/push authorized                                         |
| R03 | README with setup                                                  | Current local setup, key generation, operator workflow and checks                                                                              |
| R04 | OpenAPI/GraphQL schema and API architecture task                   | REST OpenAPI for all implemented identity/business/clinical/payment/admin routes                                                               |
| R05 | Architecture document, 2–4 pages                                   | Updated architecture Markdown and Mermaid; four-page architecture-submission.pdf generated and text-checked                                    |
| R06 | Automated tests and CI                                             | 219 tests (72 unit + 147 integration), local workflow validation; hosted execution unverified                                                  |
| R07 | Observability setup                                                | Local OTel collector, Prometheus, Tempo, Grafana, dashboards and nine operational alerts; live smoke evidence                                  |
| R08 | Security checklist and threat model                                | Updated security checklist/threat model/data handling and operational assumptions; independent review pending                                  |
| R09 | User lifecycle/auth/roles                                          | Implemented current identity scope; external delivery not configured                                                                           |
| R10 | Doctor availability and booking                                    | Implemented owned availability, transactional booking/cancellation, locks, outbox and replay; concurrency tests pass                           |
| R11 | Consultation lifecycle and prescriptions                           | Implemented lifecycle, encrypted notes, prescription drafts/versions/finalization/correction, access auditing                                  |
| R12 | Search and filtering                                               | Doctor name/specialty/available-range queries, bounded pagination and public directory caching implemented                                     |
| R13 | Compliance and audit trails                                        | Append-only audited access, partition maintenance and bounded security cleanup; legal retention/holds remain policy work                       |
| R14 | Admin analytics                                                    | Live bounded-date counts/utilization with asOf and secure admin API; no production SLO proof                                                   |
| R15 | 100k consultations/day                                             | Reproducible historical-fixture/rate script; short 50-write/200-read local sample only, not sustained 100k/day proof                           |
| R16 | p95 reads <200ms, writes <500ms                                    | Local sample read p95 14.42ms/write p95 19.87ms; production ingress and sustained target unverified                                            |
| R17 | 99.95% availability                                                | Multi-AZ/redundant tasks/autoscaling defined; no cloud deployment or availability achievement measured                                         |
| R18 | Encryption                                                         | Application AEAD and verified production transport; IaC KMS/storage/backup encryption defined, cloud custody unverified                        |
| R19 | MFA                                                                | TOTP/recovery implementation, bypass/replay/concurrency tests                                                                                  |
| R20 | RBAC                                                               | Identity/business/clinical/payment/admin role/ownership/recent-MFA gates implemented                                                           |
| R21 | Metrics, logs and traces                                           | Allowlisted HTTP/Kysely/worker OTel spans + Prometheus metrics + trace-correlated redacted logs; live local checks                             |
| R22 | CI/CD and containers                                               | Non-root hardened container, manual OIDC staging workflow, safe migrator/rollback/smoke; hosted CD unverified                                  |
| R23 | High-level architecture and data flow                              | Updated component/data/telemetry/deployment boundaries and cloud diagram; cloud marked undeployed                                              |
| R24 | Booking sequence diagram                                           | Booking lock/audit/idempotency/outbox sequence with propagated worker trace and compensation boundary                                          |
| R25 | ER diagram                                                         | Core/support/lineage/receipt ER diagram includes optional outbox trace_parent                                                                  |
| R26 | Retry and backoff strategies                                       | Safe authentication retries; worker bounded exponential backoff/jitter and crash recovery; generic DB retry not invented                       |
| R27 | Data partitioning                                                  | Monthly audit maintenance current + next three months, safe fallback conflict reporting; no clinical partitioning without measurements         |
| R28 | Caching and concurrency                                            | Redis limits/public directory cache; DB revision invalidation and slot locking; concurrency/fallback tests pass                                |
| R29 | Transactions and sagas                                             | Transaction-bound business/audit/outbox/receipts; tested deterministic fake compensation outside SQL transactions                              |
| R30 | Backup and DR                                                      | RPO/RTO proposals, encrypted backup IaC and reproducible isolated logical restore/count/grant drill; PITR/regional/key recovery unverified     |
| R31 | Allowed language, PostgreSQL, REST/GraphQL                         | Node.js + TypeScript + Express + PostgreSQL + REST                                                                                             |
| R32 | Modular services and DI                                            | Constructor injection, explicit roots, ports and layer boundaries                                                                              |
| R33 | Idempotency for writes                                             | Identity, availability, booking, clinical, prescription and payment writes use transactional idempotency                                       |
| R34 | Async heavy tasks                                                  | Durable business consumers and separate scheduled retention/partition maintenance; setup delivery remains audited manual operation             |
| R35 | Rate limiting and validation                                       | Pre-auth/endpoint/account/actor limits and strict Zod for all implemented APIs                                                                 |
| R36 | Secrets through env                                                | Validated env/ignored local generation + cloud secret ARN selectors; state/keys never published                                                |
| R37 | OWASP mitigation and attack surface                                | Ownership/MFA/replay/rate/redaction/concurrency tests, operational threat model and scans; independent review outstanding                      |
| R38 | Classification, encryption, key rotation                           | Data classification/AAD/key versions and recovery runbook; full key/pepper rotation/recovery drills unverified                                 |
| R39 | Audit and dependency scanning                                      | Dependency audit, Gitleaks, Trivy image/IaC scans with exact residual findings in Phase 5 evidence                                             |
| R40 | Eight named core tables                                            | users, profiles, doctors, availability_slots, consultations, prescriptions, payments, audit_logs; all retained                                 |
| R41 | Four-to-five-day expectation                                       | Original timebox retained; no mandatory requirement removed to meet it                                                                         |
| R42 | Repo, docs, five-minute demo                                       | Source/docs/publication procedure prepared; four-page architecture PDF prepared; approved GitHub publication and five-minute video outstanding |
| R43 | Fail if critical security/idempotency absent                       | Existing critical security/idempotency regression retained; final hosted/cloud/operational and submission gates remain open                    |

Rubric: Architecture 20, Core Flows 20, Code Quality 15, Security 10,
Observability 10, Scalability 10, Infra/CI 10; listed base weights sum to 95.
Bonus +10 is unspecified; no unrelated bonus features are invented.

## Approval gate

Stop after Phase 5. Phase 6 requires explicit user approval. Original operational,
submission and evidence requirements above remain outstanding; provisional phase
approval is not production certification. No frontend, NestJS, real gateway, video
calling or paid cloud resources were added.
