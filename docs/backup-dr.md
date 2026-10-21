# Backup and disaster recovery

Proposed objectives: same-region PITR RPO **5 minutes**, RTO **60 minutes**;
cross-region copied-backup RPO **24 hours**, RTO **4 hours**. These are planning
objectives, not measured achievements. Regional recovery can exceed the 99.95%
monthly availability error budget (about 21.6 minutes per 30 days).

Terraform defines encrypted Multi-AZ RDS PostgreSQL, automated backups retained
14 days, final snapshots and deletion protection. Cache replicas/TLS/snapshots
are configured, but Redis is never booking authority. Multi-AZ is not a backup.
Cross-region copies, restore automation and actual PITR are not deployed/tested.
An approved deployment must choose destination region/account, KMS grants,
copy schedules and legal residency constraints and run timed failover drills.

## Reproducible isolated local drill

```sh
bash scripts/restore-drill.sh amrutam_test
```

This accepts only a source ending `_test`, dumps without owner/ACL into ignored
owner-only `work/restore-drill.dump`, creates a unique disposable target, restores
in one transaction, reapplies `infra/postgres/restore-runtime-grants.sql`, asserts
least privilege and compares migration/user/consultation/prescription/audit/outbox
counts. It drops only the generated target on exit; the source and persistent
volume remain. The dump is still sensitive even when clinical fields are encrypted;
never publish it. This drill uses generated test data and does not demonstrate
production-scale restore time, PITR, application-key recovery or regional failover.

## Recovery sequence

1. Declare incident, freeze business writes/deployments if integrity is uncertain,
   record cutoff in UTC, preserve logs/audit evidence and nominate an incident lead.
2. Restore the selected snapshot/PITR into a new private instance with approved KMS
   keys. Keep it isolated; never overwrite the original before validation.
3. Recover signing/encryption key versions and pepper from separate approved secret
   custody. Ciphertext backups alone cannot recover clinical content. Retain old
   decrypt keys until legal retention and re-encryption procedures allow removal.
4. Validate schema migration checksums, row counts, foreign keys/occupancy guards,
   finalized immutability, audit partitions and timestamps. For logical no-ACL
   restores reapply runtime grants before runtime connections; never restore API
   ownership or grant worker clinical read privileges.
5. Validate authorized decrypt/read with synthetic fixtures and no plaintext logs.
   Verify MFA, live revocation, retry outcomes, outbox leases/receipts and payment
   reconciliation. Reconstruct Redis cache/limits; do not reconstruct slot truth
   from Redis. Force appropriate session invalidation if restore loses revocations.
6. Point secret references to recovered endpoints, deploy compatible images, run
   staging smoke, re-enable limited traffic, then reconcile post-cutoff business
   events. A future real payment provider would require provider reconciliation;
   this submission has only a deterministic fake adapter.
7. Measure actual loss/downtime, compare objectives, rotate incident-exposed secrets
   and update the runbook. Test backup access and paging on a recurring schedule.

Terraform state requires a separately managed private, versioned, KMS-encrypted
remote backend with lock support, restricted access and its own recovery policy.
Sensitive values such as the cache token reside in state despite `sensitive=true`.
Never commit tfvars, state, plans, database dumps, generated key files or log exports.
