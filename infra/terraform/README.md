# Reviewed deployment foundation; not deployed

Terraform 1.13.5/AWS provider lock defines two-AZ networking, public HTTPS ALB,
private ECS Fargate API/worker, one-shot owner migrator, scheduled function-only
maintenance, private ECR, VPC service endpoints, private Multi-AZ RDS PostgreSQL,
replicated Valkey-compatible cache, KMS encryption, Secrets Manager references,
IAM/OIDC, backups, VPC flow logs and CloudWatch alarms. No NAT is required for the
current internal fake-adapter workflows. An actual external provider would need a
separately reviewed egress design. No resources were provisioned or plans applied.

```sh
terraform fmt -check -recursive
terraform init -backend=false -input=false -lockfile=readonly
terraform validate
```

Run from this directory. Validation is schema/configuration evidence only; it does
not prove account quotas, IAM authorization, service compatibility, DNS/TLS,
deployment health, availability or performance. Never run apply without approval.

Before deployment provide an existing encrypted/versioned S3 state backend,
certificate and DNS, verified SNS topic, account/region quotas and Secrets Manager
JSON references. Login role passwords, application keyring and pepper are created
outside Terraform; provision owner/API/worker/maintenance roles using the documented
SQL and least-privilege grants. API JSON needs signing/keyring/pepper values, AUTH_JWT_ISSUER, AUTH_JWT_AUDIENCE plus DATABASE_URL,
DATABASE_CA_CERT and REDIS_URL. Worker JSON contains only its DATABASE_URL,
DATABASE_CA_CERT and REDIS_URL. Migrator and maintenance each receive their own
DATABASE_URL and DATABASE_CA_CERT. Include URL-encoded credentials, verified RDS CA
and rediss cache authentication; never use owner credentials in runtime secrets.

Application and collector images require immutable sha256 digests. Bootstrap ECR
and mirror a reviewed AWS Distro for OpenTelemetry collector into the private
collector repository before creating tasks; private tasks have no public-registry
egress. Repository creation/image publication/task creation therefore require a
reviewed staged infrastructure rollout, not a blind first apply. No bootstrap was
executed. Existing GitHub OIDC providers may need import/reuse rather than duplicate
creation. Configure the protected `staging` environment and exact repository subject.

Cloud custom worker/backlog/pool/auth/conflict alarms and native target-health alarms are defined, with explicit EMF dimensions and counter delta conversion. Cloud metric names/dimensions, ADOT-to-X-Ray/EMF delivery, paging and failover
remain deployment smoke-test gates. Local Compose uses a separate collector,
Prometheus, Tempo and Grafana; those checks do not validate cloud telemetry.
Terraform static scanning includes a documented exception for AVD-AWS-0053:
the public HTTPS ALB is the intended edge; application/database/cache stay private.
The inline exception expires 2027-01-21 and must be reviewed. No broad scan bypass
is configured. Cache auth token remains sensitive in state; protect the backend.
