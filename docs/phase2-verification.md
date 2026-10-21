# Phase 2 implementation and verification report

Date: 20 October 2026. Repository: `/workspace/amrutam-telemedicine-backend`.
Scope: identity, authentication, authorization and security only. Phase 3 is not started.

## Implemented functionality

Patient registration with generic responses; single-use activation that requires
the recipient-chosen password; Argon2id; password-only challenges; mandatory TOTP;
encrypted seeds; URI-only approved enrollment disclosure; replay-safe timesteps;
recovery codes and regeneration; short-lived strict asymmetric JWTs; refresh rotation
and all-generation reuse detection; logout; own profiles/sessions; password change;
deactivation; controlled doctor/admin provisioning and status changes; one-time
operator bootstrap; owner-only setup-token file export; role/resource/recent-MFA
policies; strict inputs/DTOs/errors; shared pre-auth and endpoint-specific limits;
bounded denial audit; transactional redacted security audit and encrypted idempotency.

Migration 0006 adds activation state/time, owned MFA flows and consumed refresh
history. The eight required core tables and Phase 1 constraints remain. Migrations
0001–0005 were not edited; the real existing local database upgraded successfully.
Kysely defaulted timestamps were corrected to select `Date` values rather than
nested column wrappers without weakening strict typing or changing SQL storage.

## Exact commands and results

| Command/check                                                                                                   | Result                                                                                            |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm install argon2 jose otpauth`                                                                               | PASS; required crypto libraries installed and lockfile updated                                    |
| `npm install --package-lock-only --ignore-scripts`                                                              | PASS; package metadata synchronized                                                               |
| `npm run security:generate-env`                                                                                 | PASS; owner-only ignored key configuration, no values printed                                     |
| `npm run format`                                                                                                | PASS; final formatting check separately recorded below                                            |
| `npm run typecheck`                                                                                             | PASS; strict TypeScript                                                                           |
| `npm run lint`                                                                                                  | PASS; no errors/warnings                                                                          |
| `npm run build`                                                                                                 | PASS; also executed successfully inside the runtime image build                                   |
| `npm run openapi:generate`                                                                                      | PASS; implemented contract updated                                                                |
| `npm run openapi:check`                                                                                         | PASS; generated artifact matches source                                                           |
| `npm test`                                                                                                      | PASS: **39 tests across 5 files**, including OpenAPI validation                                   |
| `node --env-file=work/test.env node_modules/vitest/vitest.mjs run tests/integration`                            | PASS: **61 tests across 2 files**; 20 schema/foundation + 41 identity/security/operator tests     |
| `npm audit --audit-level=high --json > work/phase2-npm-audit.json`                                              | PASS: 0 known vulnerabilities at all severities                                                   |
| `docker compose --env-file work/compose.env config --quiet`                                                     | PASS                                                                                              |
| `docker build --secret id=npm_ca,src=/etc/ssl/certs/ca-certificates.crt --tag amrutam-backend:local .`          | PASS; native Argon2id works; TLS verification retained                                            |
| `docker compose --env-file work/compose.env up --no-build -d --wait`                                            | PASS; migrator exits 0 and all four long-running services healthy                                 |
| `docker compose --env-file work/compose.env run --rm --no-deps migrate node dist/entrypoints/migrate.js status` | PASS; all 6 versions applied                                                                      |
| `docker compose --env-file work/compose.env exec -T api id`                                                     | PASS; uid 1000, node                                                                              |
| Container HTTP smoke                                                                                            | PASS; readiness/OpenAPI 200, protected request/invalid login 401, final token-only activation 400 |
| Container crypto/permissions                                                                                    | PASS; native Argon2id hash/verify; DB role amrutam_api; worker has no AUTH_ variables             |
| `docker compose --env-file work/compose.env stop api worker`                                                    | PASS; both exit codes 0                                                                           |
| Final formatting, source inventory and secret exclusion                                                         | See final completion check below                                                                  |

**Total: 100 passing automated tests.** Tests use generated test keys, public RFC
vectors and isolated fixture credentials, not real users or production secrets.
The main API graph connects as restricted `amrutam_api`; fixture/fault injection
and the trusted operator CLI use the database owner. Tests reset only an explicit
`_test` database and Redis `/15`. They fail when required configuration is absent.

All Docker commands above used the explicit local daemon wrapper:

```sh
env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS \
    -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock ...
```

The inherited proxy/registry configuration was preserved. The provided combined
CA bundle was mounted only for networked build steps; TLS was not disabled. Ignored
`work/compose.env`, `work/security.env` and `work/test.env` supply generated local
credentials; no credential values are included in this report.

## Explicit security evidence

- Unknown, incorrect, inactive and disabled credential cases use safe public errors;
  registration does not distinguish existing accounts or expose setup tokens.
- Activation requires a password before any enrollment challenge. A pre-registrant's
  earlier password fails after recipient activation; a consumed token cannot reset it.
- Public doctor/admin registration, privileged profile fields and unknown writable
  properties are rejected; no default or automatically activated admin exists.
- Challenge tokens cannot authorize protected application APIs. JWT wrong issuer,
  audience, key, algorithm, type, age/lifetime, missing expiry, expiry, future iat
  and signature tampering are rejected. A signed stale role cannot override DB state.
- TOTP reuse is blocked sequentially and concurrently across challenges. Recovery
  consumption is single-use under concurrency. Failure caps survive retries.
  Changed retries against completed MFA responses spend the same five-attempt
  budget for both confirmation and verification without revoking existing sessions.
- Recovery regeneration invalidates old codes and requires password/fresh factor;
  per-account limits bound distributed factor guessing.
- Refresh lost-response retries return the same current result. Independent reuse,
  older-generation reuse and expired retry reuse revoke the family. Guessed invalid
  credentials cannot force victim-session revocation.
- Logout, selected-session revocation, password changes, deactivation and admin
  status changes invalidate access as specified. Refresh does not renew recent MFA.
- Cross-user profile/session access, cross-role provisioning and administrative
  self-disable attempts are denied. Current status/version is authoritative.
- Rate limits return 429/Retry-After uniformly. Redis enforcement failure returns 503. Pre-authentication limits block anonymous protected-route floods; continued
  blocked traffic does not produce unbounded DB audit growth. Forwarding spoofing
  and invalid blanket proxy trust configuration are checked.
- Duplicate/concurrent writes and conflicting bodies are tested; successful replay
  does not duplicate the logical audit event. Revoked actors cannot replay data.
- Audit/HTTP logging and persisted ciphertext are inspected for credential leakage.
  Ordinary DTOs omit password/refresh/recovery hashes and seed envelopes.
- Injected mandatory audit failures roll back registration/profile/setup/outbox/
  idempotency writes, password/session changes and MFA timestep/flow/session state.
- Real operator CLI bootstrap is one-time, setup export writes mode 0600 without
  printing the token, and consumed setup credentials cannot be exported again.
- Phase 1 overlapping slots, concurrent occupancy, cancellation rebooking,
  historical/prescription/audit guards, runtime privileges, atomic rollback and
  migration checksum/concurrent runner/up/down/reapply regressions still pass.

## Resolved findings

Strict types exposed Phase 1's unused nested default-timestamp wrappers; corrected
types now match pg runtime `Date` values. An Argon2 test assumed parameter ordering;
it now checks the actual work factors independently of encoding order. Review found
and fixed pre-auth guard ordering/audit amplification and token-only activation's
missing password-knowledge guarantee. Final review also fixed an MFA conflict
retry guess-budget gap and added an account bucket to recovery-factor proofs.
Regression tests cover these fixes.

No unresolved code/test failure is known from the checks above. This is engineering
test evidence, not an independent security audit or proof of constant-time behavior.

## Known limitations and unverified requirements

- No email/provider delivery consumer: encrypted setup delivery uses the audited
  controlled operator/manual path. No messages were sent to third parties.
- Expired encrypted responses/flows/session history/setup records are not physically
  purged automatically. Replay expiry is enforced; retention jobs remain outstanding.
- Email changes, emailed password recovery and lost-all-factor administrative reset
  are not implemented. No insecure fallback/bypass was added.
- Session listing is bounded to the latest 100 records. Signing/encryption key-ring
  compatibility is tested, but full key/pepper rotation and recovery drills are not.
- GitHub Actions is defined but was not pushed or executed on GitHub in this session.
  No production infrastructure/CD, image vulnerability scan or independent pentest
  was performed; no paid cloud resources were provisioned.
- No 100k/day load proof, latency/availability SLO proof, production TLS/storage/key
  custody proof, full telemetry or backup/DR exercise is claimed.
- Booking, clinical workflows, search, admin analytics, job consumers and all other
  remaining PDF deliverables are retained in `implementation-checklist.md`.

No NestJS, frontend or unrelated product feature was added. Existing repository
remote/configuration is preserved; nothing was committed or pushed. Phase 3 has
not started and requires explicit approval.

## Final completion checks

Final source passes formatting, strict typing, lint, build, OpenAPI consistency,
39 unit/HTTP/crypto tests and 61 PostgreSQL/API/security tests. The final image was
rebuilt and its API/worker health, protected-route rejection, activation password
requirement, restricted database role and nonroot identity were rechecked.

The complete authored tree matches `phase2-files.md`: 40 created, 25 modified and
5 removed placeholders, 139 current files. Generated local secrets were checked
against source/configuration/documentation; no matches or tracked `.env` files
were found. `work/`, dependencies and build output remain ignored. `git diff
--check` and Compose configuration validation pass.
