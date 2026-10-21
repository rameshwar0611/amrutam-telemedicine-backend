# Amrutam Telemedicine Backend

Express 5, strict TypeScript, constructor injection, PostgreSQL/Kysely, Redis,
Argon2id, JOSE JWTs, TOTP MFA, OpenAPI, SQL migrations, Docker and automated tests.

**Implemented:** health checks; patient registration/activation; mandatory MFA;
login/refresh/logout; own profiles and sessions; password/account lifecycle;
controlled doctor/admin provisioning; doctor-owned availability; discovery/filtering;
transactional booking/cancellation; encrypted clinical notes and prescription versions;
internal payments, compensation, durable jobs; admin audit/analytics; write idempotency.

**Infrastructure and operations:** allowlisted OpenTelemetry request/SQL/job tracing and metrics,
local Prometheus/Tempo/Grafana, alerts, restricted scheduled maintenance, backup
restore testing, performance scripts, AWS Terraform and gated OIDC staging workflows.

**Not verified:** cloud deployment, full daily capacity, availability,
PITR/regional recovery, external paging and complete key-recovery drills. Automatic
setup-email delivery remains manual through the audited operator. No production
readiness or compliance certification is claimed.

## Submission deliverables

- [Architecture document (PDF)](docs/architecture-submission.pdf)
- [OpenAPI specification](docs/openapi.json)
- [Implementation checklist](docs/implementation-checklist.md)
- [Identity and security contracts](docs/identity-security.md)
- [Observability and operations](docs/operations.md)
- [Backup and disaster recovery](docs/backup-dr.md)
- [Infrastructure as code (Terraform)](infra/terraform/)
- [Continuous integration workflow](.github/workflows/ci.yml)
- [Booking and discovery design](docs/booking-and-discovery.md)
- [Verification details](docs/phase5-verification.md)

The demo video is submitted separately with the assignment email.

## Requirements and local setup

Use Node.js 24 LTS, npm 11, Docker Engine and Docker Compose v2. PostgreSQL 17 uses
trusted `btree_gist` and `pg_trgm` extensions. There is no NestJS or frontend.

1. Run `npm ci` and copy `.env.example` to ignored `.env`.
2. Set a unique Grafana password and matching maintenance password/URL, then replace the database password placeholders and matching URLs with unique local
   credentials. URL-encode special characters. Do not print or commit credentials.
3. Run `npm run security:generate-env`. It creates owner-only ignored
   `work/security.env` with fresh signing/encryption keys and an independent pepper.
   It refuses to overwrite an existing file. Keep it to preserve local tokens/data.
4. Run `docker compose -p amrutam-telemedicine --env-file .env --env-file work/security.env up --build -d --wait`.
5. Check `http://localhost:3000/health/live`, `/health/ready` and `/openapi.json`.
6. Use the same project name (`-p amrutam-telemedicine`) and two `--env-file` arguments for Compose logs, status and shutdown.
   Stop with `down`; retain the database volume unless deliberately resetting data.

Local dev/operator scripts read `.env` and then `work/security.env`; a present
local generated key file overrides placeholder key values in `.env`. Production
entry points read injected environment variables only and do not load local files.

Do not use local/test keys in a real deployment. Worker and migration containers
receive no JWT/encryption/pepper secrets.

Compose creates restricted runtime logins on the **first** database-volume
initialization. A one-shot owner migration runs before API/worker startup. Existing
role passwords are not changed by editing `.env`; rotate them explicitly. Published
ports bind to loopback. Local DB/Redis transport is plaintext; production mode
requires verified PostgreSQL TLS and Redis TLS. No paid resources are provisioned.

Private-CA networks can build without disabling TLS verification:

```sh

docker build --secret id=npm_ca,src=/path/to/trusted-ca.pem -t amrutam-backend:local .
docker compose --env-file .env --env-file work/security.env up --no-build -d --wait

```

The CA is only mounted in dependency-install steps and is not copied into the image.

## Identity setup and API usage

All business routes use `/v1`; see `docs/openapi.json` and
[identity/security contracts](docs/identity-security.md). Mutations require a unique
`Idempotency-Key` per logical request. Send credentials in JSON bodies or the Bearer
header, never query strings. Successful registration is always generic.

Registration queues an **encrypted** activation-delivery record. No email provider
or delivery consumer is configured. For a controlled local/manual workflow, use
an operator connection with database-owner credentials and the application keys.

The operator can find the registered user ID through its trusted database access.

Bootstrap the initial administrator with:

```sh

npm run identity:operator -- bootstrap-admin --email admin@example.test --name 'Local Admin'

```

This command does not create a password, active account, or session. It refuses
subsequent bootstrap once any admin exists. Subsequent doctor/admin provisioning
uses a fully authenticated admin with recent MFA through the API.

Export a pending setup token to a protected ignored file:

```sh

npm run identity:operator -- setup-token --user-id USER_UUID --output work/activation-token.txt

```

The export is audited, refuses overwrite, is restricted to `work/`, and never prints
the token. Deliver it securely to its intended recipient; do not paste it into logs.

Activation consumes it, requires a recipient-chosen password for every account, and returns
only an enrollment challenge. Enroll TOTP using the one provisioning URI, then
confirm a code to obtain full access and one-time recovery codes. The URI contains
the seed as the explicitly approved enrollment exception. Ordinary DTOs never
include seeds or credential hashes.

## Host development and migrations

Run `npm run dev` or `npm run dev:worker` with local dependencies. Use restricted
runtime DB credentials for API work. The owner URL in the Phase 1 example is for
local migration/operator convenience and must not be used in production runtime.
`npm run db:migrate` applies pending versions using `DATABASE_URL`; run migrations
with owner credentials, separately from runtime credentials. `db:status` validates
history. `db:rollback` reverses one version only and requires explicit
`ALLOW_DESTRUCTIVE_MIGRATIONS=true`.

Never edit applied migrations. Checksums cover SQL in both directions; one
connection holds an advisory lock, and each version is transactional. The Phase 2
upgrade adds version 0006 without modifying 0001–0005. Existing records are not
silently activated. Downgrading 0006 intentionally fails while pending-activation
rows exist; reconcile/export data first. Production changes use forward migrations.

## Current verification status

The repository is published at https://github.com/rameshwar0611/amrutam-telemedicine-backend.

GitHub Actions CI and security workflows completed successfully. The local Docker
Compose API, PostgreSQL, Redis, and worker services were healthy. All 72 unit
tests passed locally on October 21, 2026. The 147 integration tests were
previously reported passing during development; do not interpret this as a
fresh local integration run.

The architecture document and Terraform definitions are included. Cloud
deployment, sustained 100,000 consultations/day, production p95 latency and
99.95% availability, cloud recovery, and independent security certification
are not demonstrated. The five-minute demo video is a separate submission
deliverable and is not included in this repository.

## Verification

```sh

npm run typecheck
npm run lint
npm run format:check
npm run build
npm run openapi:check
npm test
npm run test:integration
npm audit --audit-level=high

```

Integration tests require `TEST_DATABASE_URL` naming an isolated database ending
in `_test` and `TEST_REDIS_URL` using Redis database `/15`. Tests **reset** the SQL
public schema and Redis DB 15, provision test roles, and exercise destructive
migration rollback. Never use shared/production data. The database user must own
it and provision roles/extensions. Test keys are generated in memory; no default
accounts or credentials are shipped in the runtime image.

Integration tests can read the two test URLs from ignored `.env`. In this managed
workspace the equivalent recorded invocation loads ignored `work/test.env`; see
`docs/phase4-verification.md`. Missing configuration fails rather than skipping tests.

Generate the contract with `npm run openapi:generate`; CI rejects stale output.

## Project structure and implementation notes

- `src/entrypoints/`: API, worker, migrator, operator, local-key generator, OpenAPI.
- `src/composition-root.ts`: explicit dependency wiring and transaction-scoped repositories.
- `src/modules/identity/`: HTTP adapters, policies/services, ports, repositories and schemas.
- `src/modules/audit/`: audit port and append-only PostgreSQL adapter.
- `src/infrastructure/`: DB/Redis, crypto, config, HTTP lifecycle and logging adapters.
- `src/shared/`: HTTP errors, JSON helpers and unit-of-work port.
- `src/modules/bookings/` and `src/modules/doctors/`: Phase 3 business layers.
\- Clinical/prescription/payment/admin modules and the durable worker are implemented in Phase 4.
- `docs/verification.md` and `docs/files-created.md` preserve Phase 1 historical evidence.
- `docs/phase2-verification.md` and `docs/phase2-files.md` preserve Phase 2 evidence.
- `docs/phase3-verification.md`, `docs/phase3-files.md` and `docs/booking-and-discovery.md` describe this phase.
- `docs/implementation-checklist.md` retains every original PDF requirement.

The CI definition includes checks, contracts, real DB tests, dependency audit,
Compose validation and image build. GitHub Actions CI and security workflows have completed successfully.

Phase 3 endpoints and policies are documented in `docs/booking-and-discovery.md`.

The two 100-request booking cases and 100-retry cancellation case run against real
PostgreSQL through the restricted-role API graph. Cache fallback never bypasses
MFA or fail-closed security rate limiting. Business outbox records are processed by the worker; setup delivery remains manual.

No real provider delivery or money transfer is claimed.

Phase 4 contracts are in `docs/clinical-payments-jobs.md`; exact verification and
file inventories are in `docs/phase4-verification.md` and `docs/phase4-files.md`.

Worker configuration uses WORKER_POLL_MS=1000 and WORKER_LEASE_MS=30000 by default.

It requires no clinical/auth keys. Payments always report internal_fake mode.

## Operations and publication

See `docs/operations.md` for the optional observability overlay, probes, maintenance,
alerts and safe migration/rollback procedures. `docs/backup-dr.md` distinguishes
local restore evidence from proposed RPO/RTO. `infra/terraform/README.md` describes
undeployed AWS prerequisites; do not run Terraform apply without approval.
`docs/phase5-verification.md` records exact checks and limitations;
`docs/phase5-files.md` lists every Phase 5 addition/modification.
`docs/github-publication.md` provides review, publication and Actions instructions.

The source repository is published on GitHub.

Cloud deployment has not been performed.

Performance scripts require an explicitly resettable isolated `_test` database and
Redis `/15`. Never run them against the application database. Read the verification
report before interpreting the short local sample as any capacity/SLO evidence.
