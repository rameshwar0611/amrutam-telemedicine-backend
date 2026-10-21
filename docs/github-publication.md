# GitHub publication procedure

No commit, push or pull request was created by the agent. Current source is on local
branch `work`; remote is `https://github.com/rameshwar0611/amrutam-telemedicine-backend.git`.
Source is initially untracked, so plain `git diff` alone cannot show the submission.
`npm run repository:check` writes a complete review patch to ignored
`work/publication.diff` including all tracked/untracked publishable paths. It does
not stage, commit, push, alter remotes or provision resources. `--snapshot` also
copies the allowed publication inventory for a redacted Gitleaks scan.

## Review before authorizing publication

```sh
git status --short
git branch --show-current
git remote -v
npm run repository:check -- --snapshot
git check-ignore .env work/compose.env work/security.env node_modules dist infra/terraform/.terraform
```

Review `work/publication.diff`, `docs/phase5-files.md`, verification results and the
original requirement traceability. Ensure `.terraform.lock.hcl`, all migrations,
OpenAPI and source from every phase are included. Never add `.env`, `work`, generated
keys, database dumps, tfvars/plans/state, dependency trees or Terraform providers.

Only after explicit approval, a human/operator can execute:

```sh
git add .
git diff --cached --check
git diff --cached --stat
# Review the full staged diff and scan the staged publication inventory again.
git commit -m "Implement Amrutam backend phases 1–5"
git push -u origin work
```

These commands are instructions, not completed actions. Review repository history
and branch policy first; do not force-push or overwrite an existing main branch.
Pushing `work` triggers `Backend CI` and `Infrastructure and security`. A reviewed
pull request can merge to main after all required checks pass. The branch protection
policy should require both workflows. Hosted runs have not been performed here.

## Run Actions without deploying

Enable Actions on the repository and check push/PR runs, or use the Actions UI:
select `Backend CI` / `Infrastructure and security`, choose the published branch,
then **Run workflow**. CI uses disposable PostgreSQL and Redis with test-only
credentials, installs locked dependencies, runs all tests/contracts/static checks,
audits dependencies, validates Compose and builds the image. Security workflow
validates Terraform/workflows/alerts, scans publication secrets and scans the image.
Hosted image availability/network differences must be resolved from actual runs.

## Optional staging only after separate infrastructure/deployment approval

Configure a protected staging environment with required reviewers, main branch
restriction, OIDC trust and variables: AWS_REGION, AWS_DEPLOY_ROLE_ARN, ECS_CLUSTER,
ECR_REPOSITORY (registry/repository without tag), PRIVATE_SUBNETS (comma-separated),
SECURITY_GROUP and STAGING_URL. No long-lived AWS keys are required. STAGING_URL
must be the reviewed HTTPS hostname matching the existing certificate.

After successful hosted security checks, reviewed migration/backup and provisioned
infrastructure, manually run `Approved staging deployment` from main and type
DEPLOY-STAGING. It reruns CI before using short-lived OIDC credentials. The script
migrates once and restores old task revisions on deployment/smoke failure. Terraform
apply is not part of this workflow. Do not execute it as part of local publication.
