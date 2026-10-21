# Phase 5 file inventory

Compared with the preserved 177-file Phase 4 baseline: 39 added, 36 modified, zero removed. All migrations 0001–0008 are byte-for-byte unchanged.

## Added

- `.github/workflows/deploy.yml`
- `.github/workflows/security.yml`
- `compose.observability.yaml`
- `docs/architecture-submission.pdf`
- `docs/backup-dr.md`
- `docs/evidence/performance-local.json`
- `docs/github-publication.md`
- `docs/operations.md`
- `docs/phase5-files.md`
- `docs/phase5-verification.md`
- `infra/observability/alerts.yaml`
- `infra/observability/aws-collector.yaml`
- `infra/observability/collector.yaml`
- `infra/observability/grafana/dashboards/operations.json`
- `infra/observability/grafana/provisioning/dashboards/default.yaml`
- `infra/observability/grafana/provisioning/datasources/default.yaml`
- `infra/observability/prometheus.yaml`
- `infra/observability/tempo.yaml`
- `infra/postgres/restore-runtime-grants.sql`
- `infra/terraform/.terraform.lock.hcl`
- `infra/terraform/README.md`
- `infra/terraform/main.tf`
- `infra/terraform/outputs.tf`
- `infra/terraform/variables.tf`
- `infra/terraform/versions.tf`
- `migrations/0009_operations.down.sql`
- `migrations/0009_operations.up.sql`
- `scripts/deploy-staging.sh`
- `scripts/image-policy.mjs`
- `scripts/observability-smoke.mjs`
- `scripts/performance.ts`
- `scripts/repository-check.mjs`
- `scripts/restore-drill.sh`
- `scripts/staging-smoke.mjs`
- `src/entrypoints/maintenance.ts`
- `src/infrastructure/telemetry/runtime.ts`
- `tests/integration/operations.test.ts`
- `tests/unit/telemetry-startup.test.ts`
- `tests/unit/telemetry.test.ts`

## Modified

- `.env.example`
- `.gitattributes`
- `.github/workflows/ci.yml`
- `.gitignore`
- `.prettierignore`
- `Dockerfile`
- `README.md`
- `compose.yaml`
- `docs/architecture.md`
- `docs/data-handling.md`
- `docs/database-design.md`
- `docs/diagrams/architecture.mmd`
- `docs/diagrams/booking-sequence.mmd`
- `docs/diagrams/er.mmd`
- `docs/implementation-checklist.md`
- `docs/security-checklist.md`
- `docs/threat-model.md`
- `eslint.config.mjs`
- `infra/postgres/init-runtime-roles.sh`
- `package-lock.json`
- `package.json`
- `src/composition-root.ts`
- `src/entrypoints/api.ts`
- `src/entrypoints/worker.ts`
- `src/infrastructure/config/env.ts`
- `src/infrastructure/database/client.ts`
- `src/infrastructure/database/types.ts`
- `src/infrastructure/http/app.ts`
- `src/infrastructure/logging/logger.ts`
- `src/modules/bookings/repositories/booking.repository.ts`
- `src/modules/consultations/repositories/event.repository.ts`
- `src/modules/jobs/domain/jobs.ts`
- `src/modules/jobs/repositories/job.repository.ts`
- `src/modules/jobs/services/outbox-worker.ts`
- `tests/integration/database.test.ts`
- `tsconfig.json`

## Preserved and excluded

All other baseline paths are unchanged. Existing PostgreSQL volumes, generated local keys and env files were retained. `work/`, `.env`, dependency trees, build output, Terraform provider downloads/state/tfvars/plans and database dumps are excluded from publication. `.terraform.lock.hcl` is included. No index/commit/push changes were made.
