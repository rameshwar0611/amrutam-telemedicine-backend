# Phase 5 verification — 21 October 2026

This report distinguishes local evidence, static infrastructure checks and
cloud-dependent gates. No commit, push, PR, Terraform apply or paid cloud resource
was created. Phase 6 has not started.

## Preservation and disk recovery

The resumed workspace had 8.1 GiB free on a 32 GiB filesystem (74% used). All 177
Phase 4 baseline files were present; applied migrations 0001–0008 remain byte-for-byte
unchanged. The existing `amrutam_postgres-data` volume and existing anonymous volume
were preserved. No repository reset or Docker volume pruning was used. Disposable
build cache and unused dangling application images were reclaimed after builds.
The original downloaded observability/scanner images were reused. Temporary build
disk usage was monitored; the final disk reading is recorded in the completion
message. Source, local key files, migration history and persistent database data
were retained. Integration suites reset only the dedicated `amrutam_test` database
and Redis DB 15; restore drops only its newly generated disposable target.

Branch is `work`, with no commits yet. Origin is
`https://github.com/rameshwar0611/amrutam-telemedicine-backend.git`. Submission source
is untracked, so the complete binary-capable publication diff includes all allowed
untracked paths. Generated key/env/work/provider/state/dump files remain ignored.
See `phase5-files.md` and `github-publication.md`.

## Implemented and locally checked

- Actual Express, Kysely/PostgreSQL and worker OTel spans, traceparent propagation,
  metrics and trace-correlated redacted logs. Generated process instance IDs keep
  cumulative metrics from different replicas separate without host/env collection.
- Local collector, Prometheus, Tempo, Grafana and provisioned ten-panel dashboard.
  Nine Prometheus alerts plus undeployed native/custom CloudWatch alarm definitions cover errors, read/write latency, conflicts, pool pressure,
  queue age, terminal jobs, auth abuse and telemetry availability.
- Restricted maintenance process, Compose profile, migration 0009 and hourly ECS
  scheduler definition; bounded expired-security cleanup and audit partitions.
- AWS Terraform foundation, scoped secrets/IAM, private services/endpoints,
  immutable images, Multi-AZ encrypted RDS, replicated encrypted cache, monitoring,
  backups, OIDC staging workflows, safe migration/smoke/image rollback scripts.
- Restore permissions/count drill, performance driver, security checks, runbooks,
  threat/checklist updates, four-page architecture PDF and publication procedure.

## Automated test totals

**219 passed: 72 unit tests in 10 files and 147 integration tests in 6 files.**
All 207 Phase 1–4 regression tests are retained. Phase 5 adds 12 tests: five telemetry
tests (including actual OTLP startup export) and seven PostgreSQL maintenance tests.
No database suite was skipped. The integration total includes API, concurrency,
security, worker crash/retry and full nine-version migration up/down checks.

```sh
npm test
node --env-file=work/test.env node_modules/vitest/vitest.mjs run tests/integration
```

Evidence: ignored `work/phase5-unit-final.log` and
`work/phase5-integration-final.log`. Existing 100-competing-booking and
100-identical-retry guarantees are exercised through real PostgreSQL and restricted
runtime roles. See historical phase reports for the individual business cases.

## Commands and results

| Check                                                                                           | Result / practical boundary                                                                                                         |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci` (Docker dependency/runtime stages)                                                     | Locked install succeeds; host dependencies installed and audited; no forced/legacy peer resolution                                  |
| `npm run format:check`                                                                          | Pass                                                                                                                                |
| `npm run lint`                                                                                  | Pass, including operational scripts                                                                                                 |
| `npm run typecheck`                                                                             | Pass, strict TypeScript                                                                                                             |
| `npm run build`                                                                                 | Pass                                                                                                                                |
| `npm run openapi:check`                                                                         | Pass, existing endpoint contract retained; telemetry/maintenance add no public business endpoints                                   |
| `npm audit --audit-level=high --json`                                                           | Zero vulnerabilities after compatible patches                                                                                       |
| Graceful Compose API/worker/maintenance stop/restart                                            | All exit code 0, no OOM, successful restart                                                                                         |
| `bash -n scripts/*.sh`                                                                          | Pass; deployment script syntax only, no cloud execution                                                                             |
| `work/bin/actionlint .github/workflows/*.yml`                                                   | Pass for CI/security/deploy                                                                                                         |
| `work/bin/terraform -chdir=infra/terraform fmt -check -recursive`                               | Pass                                                                                                                                |
| `work/bin/terraform -chdir=infra/terraform init -backend=false -input=false -lockfile=readonly` | Pass, provider lock retained; no backend/state/apply                                                                                |
| `work/bin/terraform -chdir=infra/terraform validate -no-color`                                  | Pass with local provider socket access                                                                                              |
| Trivy Terraform HIGH/CRITICAL                                                                   | Zero unresolved findings with one scoped, expiring public-HTTPS-ALB exception; variables remain unset, static evaluation is limited |
| Gitleaks redacted clean publication snapshot                                                    | Zero findings; no generated secrets scanned into publication                                                                        |
| Final Docker build                                                                              | Pass; non-root runtime, no packaged npm/yarn, available perl security patch applied                                                 |
| Compose validation and startup                                                                  | Pass; nine application migrations applied; API/worker/PostgreSQL/Redis/Prometheus/Grafana healthy                                   |
| Collector and Tempo HTTP probes                                                                 | Pass; live trace export/query proves collector-to-Tempo delivery                                                                    |
| `promtool check rules`                                                                          | Nine rules valid; outbound paging not configured locally                                                                            |
| Collector `validate --config`                                                                   | Pass                                                                                                                                |
| Authenticated Grafana dashboard API                                                             | Provisioned dashboard present with 10 panels                                                                                        |
| `node scripts/staging-smoke.mjs` locally                                                        | Health/OpenAPI 200 and protected endpoints 401; cloud staging not executed                                                          |
| `bash scripts/restore-drill.sh amrutam_test`                                                    | Pass: disposable logical restore/counts/runtime grant assertions; source retained                                                   |
| `node scripts/image-policy.mjs work/phase5-image-security-hardened.json`                        | Zero fixable HIGH/CRITICAL; unfixed findings remain visible below                                                                   |

Managed Docker invocations use an explicit local daemon, preserving proxy and
credentials. Equivalent reproducible commands:

```sh
local_docker=(env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH docker --host=unix:///var/run/docker.sock)
"${local_docker[@]}" build --secret id=npm_ca,src=/etc/ssl/certs/ca-certificates.crt --tag amrutam-backend:local .
"${local_docker[@]}" compose --env-file work/compose.env -f compose.yaml -f compose.observability.yaml --profile operations config --quiet
"${local_docker[@]}" compose --env-file work/compose.env -f compose.yaml -f compose.observability.yaml --profile operations up -d --no-build
"${local_docker[@]}" run --rm --entrypoint promtool -v "$PWD/infra/observability:/config:ro" prom/prometheus:v3.7.3 check rules /config/alerts.yaml
"${local_docker[@]}" run --rm -v "$PWD/infra/observability:/config:ro" otel/opentelemetry-collector-contrib:0.139.0 validate --config=/config/collector.yaml
"${local_docker[@]}" run --rm -v "$PWD/infra/terraform:/src:ro" aquasec/trivy:0.67.2 config --exit-code 1 --severity HIGH,CRITICAL /src
# Full image findings are retained, including vendor-unfixed vulnerabilities.
"${local_docker[@]}" run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD/work:/evidence" aquasec/trivy:0.67.2 image --cache-dir /evidence/trivy-cache --skip-db-update --scanners vuln --format json --output /evidence/phase5-image-security-hardened.json amrutam-backend:local
node scripts/image-policy.mjs work/phase5-image-security-hardened.json
node scripts/repository-check.mjs --snapshot
"${local_docker[@]}" run --rm -v "$PWD/work/submission:/src:ro" zricethezav/gitleaks:v8.28.0 dir /src --redact --exit-code 1
```

The build CA is a temporary mount and is absent from image layers. Local-socket,
HTTP-listener and Terraform-plugin operations required the managed execution
permission override; their successful results are separate from sandbox failures.

## Live telemetry and redaction

```sh
node --env-file=work/test.env scripts/observability-smoke.mjs --allow-isolated-test-job
```

The script sends real HTTP to the Compose API and creates only a synthetic event
in `_test`, using a separately started restricted-role worker with no auth keys.
It verifies a single known trace across API, SQL and consumer spans in Tempo,
collector HTTP/SQL/job metrics, successful Prometheus scrape and Grafana health.
Sentinel clinical data in headers/query/body is absent from retrieved traces,
metrics and captured API/worker logs. It does not claim a full authenticated
clinical workflow over deployed AWS ingress; ownership/MFA/business workflows are
covered by existing integration tests. Raw owner/migration pg queries are not
instrumented. Local evidence stays in ignored `work/telemetry-smoke-*` files.

The live check caught meters created before SDK registration remaining no-ops;
startup now rebinds instruments and has a real receiver regression test. Health
probes initially followed inherited proxies; local-only wget probes now explicitly
avoid proxying loopback. Startup connection-refused checks were rerun after service
recreation completed. These are resolved failures, not omitted checks. A final formatter traversal failed on a scanner-created cache directory; read/traverse permissions were corrected only on disposable cache directories and formatting was rerun. PDF artifacts are explicitly marked binary so the complete review patch preserves their bytes.

## Performance evidence and limits

```sh
node --env-file=work/test.env --import tsx scripts/performance.ts --reset-isolated-test-data --writes=50 --rate=10 --historical=1000
```

Recorded local sample: 1,000 historical consultations, 50 successful bookings,
200 authenticated directory reads, zero errors, 4.939 seconds, 10.123 writes/sec;
read p95 **14.418 ms**, write p95 **19.866 ms**. Uses trusted MFA-complete synthetic
fixtures and local host HTTP. Machine-readable sample is in
`evidence/performance-local.json`. It predates final image hardening and is not a
measurement of deployed ingress, a full-day 100k run, 100k-history sustained load,
or 99.95% availability. The script supports longer, larger isolated workloads;
no target achievement is inferred from this short sample.

## Security scan findings and resolved failures

The initial dependency audit found the older transitive Jaeger propagator and
YAML issues. YAML is patched; a scoped compatible Jaeger 2.9.0 override fixes the
vulnerability while retaining the coherent OTel SDK versions. That upstream
propagator is deprecated; the application propagates W3C traceparent only. Final
npm audit is zero. The initial scanner database mirror was network-denied; its
supported GHCR source succeeded with TLS trust, with no policy bypass.

The initial image had fixable perl and package-manager dependencies. Runtime npm/
yarn removal and the available perl update resolved those. Complete hardened-image
scan: **83 LOW, 87 MEDIUM, 56 HIGH, 1 CRITICAL, 1 UNKNOWN**, zero fixable HIGH/CRITICAL.
The remaining critical is **CVE-2023-45853**, Debian `zlib1g`, vendor status
`will_not_fix`; no fixed version is reported. Findings are not dismissed as safe
without an applicability review. CI preserves the complete report and prints all
severity counts; its automated gate rejects fixable HIGH/CRITICAL only. Deployment
still requires review of unfixed findings. No vulnerability-free claim is made.

Terraform initially flagged public-edge/egress/log-encryption findings. Egress and
encryption were corrected; only the intentional public ALB uses the scoped
AVD-AWS-0053 exception expiring 2027-01-21. Scanner variable-value warnings remain
because deployment values/secrets were deliberately not supplied. Neither this
exception nor static validation establishes effective cloud security.

## Unverified gates and remaining assignment deliverables

- Hosted GitHub CI/security runs, protected environment/branch rules and publication
  are unexecuted; source must first be explicitly approved for commit/push.
- Cloud IAM/OIDC, TLS/DNS, private image bootstrap, ADOT/X-Ray/EMF, alarms/paging,
  ECS migration/rollback, RDS/cache failover and actual deployment are unverified.
- Sustained 100k/day, production p95 and 99.95% availability remain unproven targets.
- Production PITR/regional copy/restore and full key/pepper rotation/recovery drills
  remain unverified; local logical restore is narrower evidence.
- Unfixed base-image vulnerabilities require security/applicability review.
- Setup delivery remains audited manual operation; no email provider is configured.
- Clinical/audit retention, residency/legal holds and compliance certification
  require policy decisions; no destructive clinical/audit retention was invented.
- The four-page architecture PDF and Mermaid sources are prepared. Final approved
  repository publication and the mandatory five-minute demo video remain outstanding.

Stop after Phase 5 and await explicit Phase 6 approval. These gaps are preserved
in all 43 original PDF requirement mappings rather than marked complete.
