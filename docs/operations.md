# Phase 5 operations and observability

Local verification is distinct from cloud deployment. No AWS resources have been
provisioned. See `phase5-verification.md` for measured evidence and open gates.

## Start safely

Preserve the existing PostgreSQL volume and application keys. Never run `down -v`,
volume pruning, or test suites against the application database. Follow README
setup and set unique `MAINTENANCE_DB_PASSWORD`, matching `MAINTENANCE_DATABASE_URL`,
and `GRAFANA_ADMIN_PASSWORD` in ignored environment files.

```sh
docker compose --env-file .env --env-file work/security.env up -d --wait
docker compose --env-file .env --env-file work/security.env -f compose.yaml -f compose.observability.yaml up -d
docker compose --env-file .env --env-file work/security.env --profile operations up -d maintenance
```

Fresh PostgreSQL initialization provisions the maintenance login. For an existing
volume, migration 0009 creates a NOLOGIN role if absent. A trusted owner must set
LOGIN and its separately supplied password using psql variables before starting
maintenance; never interpolate passwords into SQL or logs. This does not require
reinitializing the volume. Runtime identities never receive owner credentials.

Loopback endpoints: API 3000, Grafana 3002, Tempo 3200, collector OTLP/health/metrics
4318/13133/8889, Prometheus 9090. PostgreSQL/Redis ports are also loopback-only.
These are development endpoints; no public observability ingress is configured.
Grafana requires the operator password and provisions Prometheus/Tempo data sources
and the Amrutam dashboard. Tempo runs as root only to initialize its local named
volume; cloud collector runs separately. Proxy settings remain inherited; internal
service names extend NO_PROXY. Retention: Prometheus 7 days, Tempo 24 hours locally.

## Telemetry contract

`OTEL_ENABLED=false` by default. When enabled, API and worker export OTLP HTTP to
a validated bare origin. `OTEL_SAMPLE_RATIO` defaults to 0.1 (local overlay: 1).
Manual instrumentation records actual Express requests, completed Kysely queries
and leased job handlers. HTTP spans use route templates, method and status. SQL
spans record only an allowlisted operation, duration and error status. Worker spans
allowlist event kinds; traceparent is propagated in transactional outbox records.
A generated service.instance.id separates replica counters without collecting host metadata. Logs include request IDs and active trace/span IDs. Collector drops legacy raw SQL,
URL/query and exception attributes as defense in depth.

Never collect bodies, headers, cookies, tokens, SQL text/parameters, raw URLs,
clinical values, user/resource IDs, exception messages, baggage or process env.
Raw pg owner/migration/maintenance SQL is outside Kysely tracing. The API keyring
is absent from worker/maintenance. Telemetry failure must not decide booking truth.
No ALB access logging is enabled because raw request targets can contain sensitive
query data. CloudWatch task logs contain only redacted application events.

Metrics include HTTP/SQL duration histograms, booking conflicts, auth denials,
worker outcomes, pool used/idle/waiting/limit, business backlog and oldest pending
age. Setup delivery is excluded from business backlog because delivery is manual.
Dashboard panels and alert rules are in `infra/observability/`. Prometheus exposes
active alerts; outbound paging is not configured locally. Before production,
connect on-call routing, tune baselines and exercise every notification. Cloud
native ALB/RDS alarms reference an existing SNS topic; custom ADOT/EMF routing
must be verified after a separately approved deployment.

## Incident actions

| Signal                             | Investigation and bounded response                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API 5xx >1% / target down          | Check readiness, task restarts, PG/Redis connectivity and recent release; roll back compatible image if release-related. Never disable MFA/limits.                        |
| Read p95 >200ms / write p95 >500ms | Compare request count, route histograms, DB timings and pool waiters; inspect indexes with synthetic parameters; tune only after measurement.                             |
| Booking conflicts >5/s             | Confirm legitimate same-slot contention versus repeated clients; investigate key reuse and limits; never remove occupancy constraints.                                    |
| Sustained pool waiters / RDS CPU   | Bound API/worker replicas and connection budget before scaling. Default 10 connections/process; reserve owner/maintenance headroom. Cancel only reviewed runaway queries. |
| Oldest business job >60s           | Check worker readiness, lease expiries, attempt counts and dependencies. Restarting a worker preserves leases/receipts; do not manually mark jobs complete.               |
| Terminal job count >0              | Use recent-MFA admin job view, correlate safe event IDs, investigate root cause and reconcile payment state. No blind replay of refunds.                                  |
| Elevated auth denials              | Check bounded denial reasons, limiter availability and trusted proxy configuration. Protect evidence; do not log supplied passwords/tokens or weaken mandatory MFA.       |
| Audit partition fallback conflict  | Preserve rows. Owner reviews an explicit transactional detach/move/attach procedure under a maintenance window; automatic maintenance never deletes audit history.        |

## Probes, shutdown and maintenance

API and worker `/health/live` show process liveness; `/health/ready` verifies
dependencies and returns unavailable during drain. SIGTERM stops acceptance,
drains HTTP and the current worker handler, closes pools/Redis, and flushes OTel.
The application deadline is bounded; Compose/ECS stop grace exceeds it. Crashed
worker jobs are reclaimed only after lease expiry and fenced against stale owners.

The separate maintenance identity can execute two SECURITY DEFINER functions with
fixed search_path/UTC and advisory locks, and cannot directly read security or
clinical tables. Hourly runs create current/next-three-month audit partitions and
delete bounded expired security rows only after a 7-day grace. Batches are at most
1000 per category. Enrollment-referenced flows, users, all clinical/prescription/
payment history, business outbox receipts and all audits remain. Cleanup appends
count-only audit evidence. Audit retention/deletion requires a jurisdiction/legal
hold policy; no automatic audit or clinical deletion is implemented.

## Migration and deployment safety

Use the owner migrator once, before rolling API/worker, with advisory locking and
checksum checks. Review lock/DDL duration and take a recoverable backup first.
Use expand/contract schema changes so old and new task revisions coexist. Do not
edit applied SQL or run destructive down migrations as an automatic rollback.
The staging script waits for a successful one-shot migration, deploys immutable
image digests, waits for stable ECS services and runs health/OpenAPI/auth-denial
smoke checks. Its failure trap restores prior API/worker task revisions only;
database rollback is a reviewed forward fix or restore, never an automatic down.
`deploy.yml` is manual, main-only and uses protected staging plus OIDC. Its existence
does not constitute deployment authorization or successful hosted execution.
