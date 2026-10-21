import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import * as OTPAuth from 'otpauth';
import { z } from 'zod';
import { createClient } from 'redis';
import { composeApi, composeIdentityCore } from '../../src/composition-root.js';
import { createDatabase } from '../../src/infrastructure/database/client.js';
import { migrate } from '../../src/infrastructure/database/migrator.js';
import { loadConfig } from '../../src/infrastructure/config/env.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';
import {
  challengeResponseSchema,
  enrollmentResponseSchema,
  tokenResponseSchema,
  userDtoSchema,
} from '../../src/modules/identity/schemas.js';
import { makeSecurityConfig, TestClock } from '../helpers/security.js';
import { JwtTokens } from '../../src/infrastructure/security/tokens.js';
import { HttpError } from '../../src/shared/http-error.js';
import { SecurityMiddleware } from '../../src/modules/identity/routes/security.middleware.js';
import { IdentityController } from '../../src/modules/identity/controllers/identity.controller.js';
import { createIdentityRouter } from '../../src/modules/identity/routes/identity.routes.js';
import { createApp } from '../../src/infrastructure/http/app.js';
import { Router } from 'express';
import { RedisRateLimiter } from '../../src/infrastructure/security/rate-limiter.js';

const url = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
if (
  !url ||
  !decodeURIComponent(new URL(url).pathname).endsWith('_test') ||
  !redisUrl ||
  new URL(redisUrl).pathname !== '/15'
)
  throw new Error(
    'Identity tests require an isolated _test database and TEST_REDIS_URL database /15; both are reset',
  );
const pool = new pg.Pool({ connectionString: url });
const database = createDatabase(new pg.Pool({ connectionString: url }));
const redis = createClient({ url: redisUrl });
const security = makeSecurityConfig({ AUTH_IP_LIMIT: 1000 });
const clock = new TestClock();
const runtimeUrl = new URL(url);
runtimeUrl.searchParams.set('options', '-c role=amrutam_api');
const appConfig = loadConfig({
  DATABASE_URL: runtimeUrl.toString(),
  REDIS_URL: redisUrl,
  NODE_ENV: 'test',
});
const application = composeApi(appConfig, createLogger('silent'), security, clock);
const core = composeIdentityCore(database, security, clock);

function write(
  method: 'post' | 'patch' | 'delete',
  path: string,
  body: object = {},
  token?: string,
  key = randomUUID(),
) {
  const test = request(application.app)[method](path).set('Idempotency-Key', key);
  if (token) test.set('Authorization', `Bearer ${token}`);
  return test.send(body);
}
const read = (path: string, token: string) =>
  request(application.app).get(path).set('Authorization', `Bearer ${token}`);
const code = (secret: string) =>
  new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30 }).generate({
    timestamp: clock.now().getTime(),
  });
async function setupToken(userId: string): Promise<string> {
  return core.work.run(async (repositories) => {
    const setup = await repositories.identity.latestSetup(userId);
    if (!setup) throw new Error('Expected setup token');
    const payload = z
      .object({ tokenEnvelope: z.json() })
      .parse(await repositories.identity.delivery(`setup:${setup.id}`));
    return z.string().parse(core.secrets.decrypt(payload.tokenEnvelope, `activation:${setup.id}`));
  });
}
async function enroll(userId: string, password: string) {
  const activation = await write('post', '/v1/auth/activate', {
    token: await setupToken(userId),
    password,
  }).expect(200);
  const challenge = challengeResponseSchema.parse(activation.body);
  const enrollment = enrollmentResponseSchema.parse(
    (await write('post', '/v1/auth/mfa/enroll', {}, challenge.challengeToken).expect(200)).body,
  );
  const secret = z.string().parse(new URL(enrollment.provisioningUri).searchParams.get('secret'));
  const confirmationKey = randomUUID();
  const auth = tokenResponseSchema.parse(
    (
      await write(
        'post',
        '/v1/auth/mfa/confirm',
        { code: code(secret) },
        challenge.challengeToken,
        confirmationKey,
      ).expect(200)
    ).body,
  );
  return { userId, password, auth, secret, challenge: challenge.challengeToken, confirmationKey };
}
async function patient() {
  const email = `${randomUUID()}@example.test`;
  const password = 'test-only-strong-password-123';
  await write('post', '/v1/auth/register', { email, password, displayName: 'Test Patient' }).expect(
    202,
  );
  const user = await core.work.run((repositories) => repositories.identity.userByEmail(email));
  if (!user) throw new Error('Expected patient');
  return { ...(await enroll(user.id, password)), email };
}
async function admin() {
  const email = `${randomUUID()}@example.test`;
  const password = 'test-only-admin-password-123';
  const result = await core.accounts.bootstrap(
    { email, displayName: 'Test Admin', role: 'admin', timeZone: 'UTC' },
    { requestId: randomUUID() },
  );
  expect(result.status).toBe(201);
  const user = userDtoSchema.parse(result.body);
  return { ...(await enroll(user.id, password)), email };
}
async function login(email: string, password: string) {
  return challengeResponseSchema.parse(
    (await write('post', '/v1/auth/login', { email, password }).expect(200)).body,
  ).challengeToken;
}
async function count(
  table:
    'users' | 'auth_sessions' | 'auth_flows' | 'audit_logs' | 'outbox_jobs' | 'idempotency_records',
): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`);
  return Number(result.rows[0]?.count);
}

async function failAudit(action: string): Promise<void> {
  await pool.query(`CREATE FUNCTION test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action = '${action}' THEN RAISE EXCEPTION 'Injected audit persistence failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_audit_failure()`);
}
async function auditCount(action: string): Promise<number> {
  return Number(
    (
      await pool.query<{ count: string }>('SELECT count(*) FROM audit_logs WHERE action=$1', [
        action,
      ])
    ).rows[0]?.count,
  );
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='amrutam_api') THEN CREATE ROLE amrutam_api NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='amrutam_worker') THEN CREATE ROLE amrutam_worker NOLOGIN; END IF;
  END $$`);
  await migrate(pool, 'up');
  await redis.connect();
  await application.connect();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE users CASCADE; TRUNCATE outbox_jobs, idempotency_records, job_receipts',
  );
  await redis.flushDb();
});
afterEach(async () => {
  await pool.query(
    'DROP TRIGGER IF EXISTS test_audit_failure ON audit_logs; DROP FUNCTION IF EXISTS test_audit_failure()',
  );
});
afterAll(async () => {
  await application.close();
  await redis.close();
  await database.destroy();
  await pool.end();
});

describe('identity workflows with restricted runtime database permissions', () => {
  it('requires password knowledge at activation and replaces credentials chosen by a pre-registrant', async () => {
    const email = 'pre-registration@example.test';
    const original = 'pre-registrant-test-password';
    const chosen = 'recipient-chosen-test-password';
    await write('post', '/v1/auth/register', {
      email,
      password: original,
      displayName: 'Recipient',
    }).expect(202);
    const user = await core.work.run((r) => r.identity.userByEmail(email));
    if (!user) throw new Error('Expected user');
    const token = await setupToken(user.id);
    await write('post', '/v1/auth/activate', { token }).expect(400);
    expect(await count('auth_flows')).toBe(0);
    await write('post', '/v1/auth/activate', { token, password: chosen }).expect(200);
    await write('post', '/v1/auth/login', { email, password: original }).expect(401);
    await login(email, chosen);
    await write('post', '/v1/auth/activate', { token, password: original }).expect(401);
    expect(await count('auth_sessions')).toBe(0);
  });
  it('runs the operator CLI bootstrap and owner-only setup export without printing credentials', async () => {
    await mkdir(resolve('work'), { recursive: true });
    const filename = resolve(`work/operator-${randomUUID()}.txt`);
    const environment = {
      ...process.env,
      DATABASE_URL: url,
      AUTH_JWT_KEY_ID: security.AUTH_JWT_KEY_ID,
      AUTH_JWT_PRIVATE_KEY_BASE64: security.AUTH_JWT_PRIVATE_KEY_BASE64,
      AUTH_JWT_PUBLIC_KEYS: JSON.stringify(security.AUTH_JWT_PUBLIC_KEYS),
      AUTH_ENCRYPTION_KEY_ID: security.AUTH_ENCRYPTION_KEY_ID,
      AUTH_ENCRYPTION_KEYS: JSON.stringify(security.AUTH_ENCRYPTION_KEYS),
      AUTH_TOKEN_PEPPER_BASE64: security.AUTH_TOKEN_PEPPER_BASE64,
    };
    const invoke = (args: string[]) =>
      spawnSync(
        process.execPath,
        ['--import', 'tsx', 'src/entrypoints/identity-operator.ts', ...args],
        { env: environment, encoding: 'utf8', timeout: 10000 },
      );
    try {
      const initial = invoke([
        'bootstrap-admin',
        '--email',
        'operator@example.test',
        '--name',
        'Operator Test',
      ]);
      expect(initial.status).toBe(0);
      const line = z.string().parse(initial.stdout.trim().split('\n').at(-1));
      const user = userDtoSchema.parse(JSON.parse(line));
      expect(user.status).toBe('pending_activation');
      expect(
        invoke(['bootstrap-admin', '--email', 'another@example.test', '--name', 'Denied']).status,
      ).toBe(1);
      const exported = invoke(['setup-token', '--user-id', user.id, '--output', filename]);
      expect(exported.status).toBe(0);
      const token = (await readFile(filename, 'utf8')).trim();
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
      expect(exported.stdout.includes(token)).toBe(false);
      expect(initial.stdout.includes(token)).toBe(false);
      await write('post', '/v1/auth/activate', {
        token,
        password: 'operator-test-setup-password',
      }).expect(200);
      expect(
        invoke(['setup-token', '--user-id', user.id, '--output', filename + '-consumed']).status,
      ).toBe(1);
      expect(await auditCount('identity.setup_delivery_exported')).toBe(1);
    } finally {
      await rm(filename, { force: true });
      await rm(filename + '-consumed', { force: true });
    }
  });
  it('allows initial admin bootstrap once and audits rejected bootstrap attempts', async () => {
    const administrator = await admin();
    const denied = await core.accounts.bootstrap(
      {
        email: 'second-bootstrap@example.test',
        displayName: 'Denied',
        role: 'admin',
        timeZone: 'UTC',
      },
      { requestId: randomUUID() },
    );
    expect(denied.status).toBe(409);
    expect(await count('users')).toBe(1);
    expect(await auditCount('identity.bootstrap_denied')).toBe(1);
    await read('/v1/me', administrator.auth.accessToken).expect(200);
  });
  it('registers a patient, activates, enrolls MFA and returns a safe own profile', async () => {
    const user = await patient();
    const profile = userDtoSchema.parse(
      (await read('/v1/me', user.auth.accessToken).expect(200)).body,
    );
    expect(profile).toMatchObject({ id: user.userId, role: 'patient', status: 'active' });
    expect(user.auth.recoveryCodes).toHaveLength(10);
    expect((await read('/v1/me', user.auth.accessToken)).headers['cache-control']).toBe('no-store');
  });
  it('returns identical generic registration and credential errors for unknown/existing accounts', async () => {
    const user = await patient();
    const existing = await write('post', '/v1/auth/register', {
      email: user.email,
      password: user.password,
      displayName: 'Ignored',
    }).expect(202);
    const unknown = await write('post', '/v1/auth/register', {
      email: 'new@example.test',
      password: user.password,
      displayName: 'New',
    }).expect(202);
    expect(existing.body).toEqual(unknown.body);
    for (const email of [user.email, 'missing@example.test']) {
      const response = await write('post', '/v1/auth/login', {
        email,
        password: 'wrong-password',
      }).expect(401);
      expect(response.body).toMatchObject({
        error: { code: 'INVALID_AUTHENTICATION', message: 'Invalid authentication credentials' },
      });
    }
  });
  it('rejects public privileged registration and mass assignment', async () => {
    for (const role of ['doctor', 'admin'])
      await write('post', '/v1/auth/register', {
        email: 'attempt@example.test',
        password: 'strong-test-password',
        displayName: 'Attempt',
        role,
      }).expect(400);
    expect(await count('users')).toBe(0);
    const user = await patient();
    await write('patch', '/v1/me', { role: 'admin' }, user.auth.accessToken).expect(400);
    await write(
      'patch',
      '/v1/me',
      { userId: randomUUID(), password_hash: 'injected' },
      user.auth.accessToken,
    ).expect(400);
    expect(userDtoSchema.parse((await read('/v1/me', user.auth.accessToken)).body).role).toBe(
      'patient',
    );
  });
  it('requires activation and MFA before application access', async () => {
    const email = 'pending@example.test';
    const password = 'pending-test-password';
    await write('post', '/v1/auth/register', { email, password, displayName: 'Pending' }).expect(
      202,
    );
    await write('post', '/v1/auth/login', { email, password }).expect(401);
    const user = await core.work.run((r) => r.identity.userByEmail(email));
    if (!user) throw new Error('Expected user');
    const challenge = challengeResponseSchema.parse(
      (
        await write('post', '/v1/auth/activate', {
          token: await setupToken(user.id),
          password,
        }).expect(200)
      ).body,
    ).challengeToken;
    await read('/v1/me', challenge).expect(401);
    await write(
      'post',
      '/v1/admin/users',
      { email: 'admin@example.test', displayName: 'Admin', role: 'admin' },
      challenge,
    ).expect(401);
    expect(await count('auth_sessions')).toBe(0);
  });
  it('rejects cross-user profiles, session revocation and non-admin provisioning', async () => {
    const first = await patient();
    const second = await patient();
    await read(`/v1/users/${second.userId}/profile`, first.auth.accessToken).expect(403);
    await write(
      'patch',
      `/v1/users/${second.userId}/profile`,
      { displayName: 'Intruder' },
      first.auth.accessToken,
    ).expect(403);
    const sessionId = z.uuid().parse(second.auth.refreshToken.split('.')[0]);
    await write('delete', `/v1/me/sessions/${sessionId}`, {}, first.auth.accessToken).expect(404);
    await write(
      'post',
      '/v1/admin/users',
      { email: 'attempt@example.test', displayName: 'Admin', role: 'admin' },
      first.auth.accessToken,
    ).expect(403);
  });
  it('provisions doctor/admin accounts only through an authenticated recent-MFA admin', async () => {
    const administrator = await admin();
    const response = await write(
      'post',
      '/v1/admin/users',
      {
        email: 'doctor@example.test',
        displayName: 'Doctor',
        role: 'doctor',
        doctor: { publicName: 'Public Doctor', specialty: 'Ayurveda' },
      },
      administrator.auth.accessToken,
    ).expect(201);
    const doctor = userDtoSchema.parse(response.body);
    expect(doctor.status).toBe('pending_activation');
    const ready = await enroll(doctor.id, 'doctor-test-password-123');
    expect(userDtoSchema.parse((await read('/v1/me', ready.auth.accessToken)).body).role).toBe(
      'doctor',
    );
    await write(
      'post',
      '/v1/admin/users',
      { email: 'next-admin@example.test', displayName: 'Admin', role: 'admin' },
      ready.auth.accessToken,
    ).expect(403);
    const secondAdmin = userDtoSchema.parse(
      (
        await write(
          'post',
          '/v1/admin/users',
          { email: 'next-admin@example.test', displayName: 'Admin', role: 'admin' },
          administrator.auth.accessToken,
        ).expect(201)
      ).body,
    );
    const activeAdmin = await enroll(secondAdmin.id, 'next-admin-test-password');
    expect(
      userDtoSchema.parse((await read('/v1/me', activeAdmin.auth.accessToken)).body).role,
    ).toBe('admin');
  });
});

describe('MFA and session replay controls', () => {
  it('allows only one concurrent use of the same TOTP across separate challenges', async () => {
    const user = await patient();
    const firstChallenge = await login(user.email, user.password);
    const secondChallenge = await login(user.email, user.password);
    clock.advance(30);
    const value = code(user.secret);
    const results = await Promise.all([
      write('post', '/v1/auth/mfa/verify', { method: 'totp', code: value }, firstChallenge),
      write('post', '/v1/auth/mfa/verify', { method: 'totp', code: value }, secondChallenge),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 401]);
    expect(await count('auth_sessions')).toBe(2);
  });
  it('rejects TOTP reuse across login flows and accepts the next timestep', async () => {
    const user = await patient();
    const challenge = await login(user.email, user.password);
    await write(
      'post',
      '/v1/auth/mfa/verify',
      { method: 'totp', code: code(user.secret) },
      challenge,
    ).expect(401);
    clock.advance(30);
    await write(
      'post',
      '/v1/auth/mfa/verify',
      { method: 'totp', code: code(user.secret) },
      challenge,
    ).expect(200);
    const nextChallenge = await login(user.email, user.password);
    await write(
      'post',
      '/v1/auth/mfa/verify',
      { method: 'totp', code: code(user.secret) },
      nextChallenge,
    ).expect(401);
  });
  it('allows exactly one concurrent use of a recovery code', async () => {
    const user = await patient();
    const firstChallenge = await login(user.email, user.password);
    const secondChallenge = await login(user.email, user.password);
    const recovery = z.string().parse(user.auth.recoveryCodes?.[0]);
    const results = await Promise.all([
      write('post', '/v1/auth/mfa/verify', { method: 'recovery', code: recovery }, firstChallenge),
      write('post', '/v1/auth/mfa/verify', { method: 'recovery', code: recovery }, secondChallenge),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });
  it('replays an identical refresh safely, then revokes on known-token reuse', async () => {
    const user = await patient();
    const key = randomUUID();
    const first = tokenResponseSchema.parse(
      (
        await write(
          'post',
          '/v1/auth/refresh',
          { refreshToken: user.auth.refreshToken },
          undefined,
          key,
        ).expect(200)
      ).body,
    );
    const retry = tokenResponseSchema.parse(
      (
        await write(
          'post',
          '/v1/auth/refresh',
          { refreshToken: user.auth.refreshToken },
          undefined,
          key,
        ).expect(200)
      ).body,
    );
    expect(retry).toEqual(first);
    await write('post', '/v1/auth/refresh', { refreshToken: user.auth.refreshToken }).expect(401);
    await read('/v1/me', first.accessToken).expect(401);
    await write('post', '/v1/auth/refresh', { refreshToken: first.refreshToken }).expect(401);
  });
  it('revokes access on logout and safely repeats the logout operation', async () => {
    const user = await patient();
    const key = randomUUID();
    await write('post', '/v1/auth/logout', {}, user.auth.accessToken, key).expect(204);
    await write('post', '/v1/auth/logout', {}, user.auth.accessToken, key).expect(204);
    await read('/v1/me', user.auth.accessToken).expect(401);
    await write('post', '/v1/auth/refresh', { refreshToken: user.auth.refreshToken }).expect(401);
  });
});

describe('idempotency, revocation and privileged lifecycle', () => {
  it('replays successful MFA confirmation without consuming another code or session', async () => {
    const user = await patient();
    const retry = tokenResponseSchema.parse(
      (
        await write(
          'post',
          '/v1/auth/mfa/confirm',
          { code: code(user.secret) },
          user.challenge,
          user.confirmationKey,
        ).expect(200)
      ).body,
    );
    expect(retry).toEqual(user.auth);
    expect(await count('auth_sessions')).toBe(1);
    expect(await auditCount('auth.mfa_confirmed')).toBe(1);
    await write('post', '/v1/auth/mfa/confirm', { code: code(user.secret) }, user.challenge).expect(
      401,
    );
    await write('post', '/v1/auth/mfa/enroll', {}, user.challenge).expect(401);
  });
  it('returns the enrollment URI only for an authorized short-lived logical enrollment', async () => {
    const email = 'enrollment@example.test';
    const password = 'test-enrollment-password';
    await write('post', '/v1/auth/register', { email, password, displayName: 'Enrollment' }).expect(
      202,
    );
    const user = await core.work.run((r) => r.identity.userByEmail(email));
    if (!user) throw new Error('Expected user');
    const challenge = challengeResponseSchema.parse(
      (
        await write('post', '/v1/auth/activate', {
          token: await setupToken(user.id),
          password,
        }).expect(200)
      ).body,
    ).challengeToken;
    const key = randomUUID();
    const first = enrollmentResponseSchema.parse(
      (await write('post', '/v1/auth/mfa/enroll', {}, challenge, key).expect(200)).body,
    );
    expect(
      (await write('post', '/v1/auth/mfa/enroll', {}, challenge, key).expect(200)).body,
    ).toEqual(first);
    await write('post', '/v1/auth/mfa/enroll', {}, challenge).expect(409);
    const stored = await pool.query<{ response_body: unknown; response_encrypted: boolean }>(
      "SELECT response_body,response_encrypted FROM idempotency_records WHERE scope LIKE 'mfa-enroll:%'",
    );
    expect(stored.rows.every((row) => row.response_encrypted)).toBe(true);
    expect(JSON.stringify(stored.rows)).not.toContain(first.provisioningUri);
    await write('post', '/v1/auth/mfa/enroll', {}).expect(401);
  });
  it('serializes concurrent identical refresh retries into one rotation', async () => {
    const user = await patient();
    const key = randomUUID();
    const responses = await Promise.all([
      write('post', '/v1/auth/refresh', { refreshToken: user.auth.refreshToken }, undefined, key),
      write('post', '/v1/auth/refresh', { refreshToken: user.auth.refreshToken }, undefined, key),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses[0]?.body).toEqual(responses[1]?.body);
    expect(await auditCount('auth.refresh_rotated')).toBe(1);
  });
  it('detects reuse of older generations, not just the immediately previous refresh token', async () => {
    const user = await patient();
    const one = tokenResponseSchema.parse(
      (
        await write('post', '/v1/auth/refresh', { refreshToken: user.auth.refreshToken }).expect(
          200,
        )
      ).body,
    );
    const two = tokenResponseSchema.parse(
      (await write('post', '/v1/auth/refresh', { refreshToken: one.refreshToken }).expect(200))
        .body,
    );
    await write('post', '/v1/auth/refresh', { refreshToken: user.auth.refreshToken }).expect(401);
    await read('/v1/me', two.accessToken).expect(401);
    expect(await auditCount('auth.refresh_reuse_detected')).toBe(1);
  });
  it('does not let an invalid guessed refresh credential revoke the victim session', async () => {
    const user = await patient();
    const id = user.auth.refreshToken.split('.')[0];
    await write('post', '/v1/auth/refresh', {
      refreshToken: `${id}.${core.secrets.randomToken()}`,
    }).expect(401);
    await read('/v1/me', user.auth.accessToken).expect(200);
  });
  it('rejects an expired authentication retry and revokes the consumed refresh family', async () => {
    const user = await patient();
    const key = randomUUID();
    const next = tokenResponseSchema.parse(
      (
        await write(
          'post',
          '/v1/auth/refresh',
          { refreshToken: user.auth.refreshToken },
          undefined,
          key,
        ).expect(200)
      ).body,
    );
    clock.advance(31);
    await write(
      'post',
      '/v1/auth/refresh',
      { refreshToken: user.auth.refreshToken },
      undefined,
      key,
    ).expect(401);
    await read('/v1/me', next.accessToken).expect(401);
  });
  it('replays profile writes, rejects conflicting payloads, and does not duplicate audit events', async () => {
    const user = await patient();
    const key = randomUUID();
    const first = await write(
      'patch',
      '/v1/me',
      { displayName: 'Updated' },
      user.auth.accessToken,
      key,
    ).expect(200);
    const retry = await write(
      'patch',
      '/v1/me',
      { displayName: 'Updated' },
      user.auth.accessToken,
      key,
    ).expect(200);
    expect(retry.body).toEqual(first.body);
    await write('patch', '/v1/me', { displayName: 'Different' }, user.auth.accessToken, key).expect(
      409,
    );
    expect(await auditCount('identity.profile_updated')).toBe(1);
    await write('post', '/v1/auth/logout', {}, user.auth.accessToken).expect(204);
    await write('patch', '/v1/me', { displayName: 'Updated' }, user.auth.accessToken, key).expect(
      401,
    );
  });
  it('serializes duplicate patient registrations without creating duplicate delivery work', async () => {
    const body = {
      email: 'race@example.test',
      password: 'test-registration-race-password',
      displayName: 'Race',
    };
    const key = randomUUID();
    const responses = await Promise.all([
      write('post', '/v1/auth/register', body, undefined, key),
      write('post', '/v1/auth/register', body, undefined, key),
    ]);
    expect(responses.map((r) => r.status)).toEqual([202, 202]);
    expect(await count('users')).toBe(1);
    expect(await count('outbox_jobs')).toBe(1);
    expect(await auditCount('identity.registered')).toBe(1);
  });
  it('changes a password and atomically invalidates all old sessions and challenges', async () => {
    const user = await patient();
    const challenge = await login(user.email, user.password);
    await write(
      'post',
      '/v1/me/password',
      { currentPassword: user.password, newPassword: 'replacement-test-password-123' },
      user.auth.accessToken,
    ).expect(204);
    await read('/v1/me', user.auth.accessToken).expect(401);
    await write('post', '/v1/auth/refresh', { refreshToken: user.auth.refreshToken }).expect(401);
    clock.advance(30);
    await write(
      'post',
      '/v1/auth/mfa/verify',
      { method: 'totp', code: code(user.secret) },
      challenge,
    ).expect(401);
    await write('post', '/v1/auth/login', { email: user.email, password: user.password }).expect(
      401,
    );
    await login(user.email, 'replacement-test-password-123');
  });
  it('disables and re-enables an account without restoring any old session', async () => {
    const administrator = await admin();
    const user = await patient();
    await write(
      'patch',
      `/v1/admin/users/${user.userId}/status`,
      { status: 'disabled' },
      administrator.auth.accessToken,
    ).expect(204);
    await read('/v1/me', user.auth.accessToken).expect(401);
    await write('post', '/v1/auth/login', { email: user.email, password: user.password }).expect(
      401,
    );
    await write(
      'patch',
      `/v1/admin/users/${user.userId}/status`,
      { status: 'enabled' },
      administrator.auth.accessToken,
    ).expect(204);
    await read('/v1/me', user.auth.accessToken).expect(401);
    await write('post', '/v1/auth/refresh', { refreshToken: user.auth.refreshToken }).expect(401);
    await login(user.email, user.password);
  });
  it('deactivates an own patient account and prevents administrator self-disable', async () => {
    const administrator = await admin();
    const user = await patient();
    await write(
      'post',
      '/v1/me/deactivate',
      { password: user.password },
      user.auth.accessToken,
    ).expect(204);
    await read('/v1/me', user.auth.accessToken).expect(401);
    await write(
      'patch',
      `/v1/admin/users/${administrator.userId}/status`,
      { status: 'disabled' },
      administrator.auth.accessToken,
    ).expect(403);
    await write(
      'post',
      '/v1/me/deactivate',
      { password: administrator.password },
      administrator.auth.accessToken,
    ).expect(403);
    await read('/v1/me', administrator.auth.accessToken).expect(200);
  });
  it('requires recent MFA for privileged actions even after a successful refresh', async () => {
    const administrator = await admin();
    clock.advance(301);
    const next = tokenResponseSchema.parse(
      (
        await write('post', '/v1/auth/refresh', {
          refreshToken: administrator.auth.refreshToken,
        }).expect(200)
      ).body,
    );
    await write(
      'post',
      '/v1/admin/users',
      { email: 'blocked@example.test', displayName: 'Blocked', role: 'admin' },
      next.accessToken,
    ).expect(403);
    expect(await auditCount('auth.request_denied')).toBeGreaterThan(0);
  });
  it('does not trust a signed role claim that disagrees with authoritative user state', async () => {
    const user = await patient();
    const tokens = new JwtTokens(security, clock);
    const forged = await tokens.access(
      {
        userId: user.userId,
        sessionId: z.uuid().parse(user.auth.refreshToken.split('.')[0]),
        authVersion: 1,
        role: 'admin',
      },
      new Date(clock.now().getTime() + 300000),
    );
    await write(
      'post',
      '/v1/admin/users',
      { email: 'blocked@example.test', displayName: 'Blocked', role: 'admin' },
      forged,
    ).expect(401);
  });
  it('lists only own safe session DTOs and revokes a selected own session', async () => {
    const user = await patient();
    const challenge = await login(user.email, user.password);
    clock.advance(30);
    const second = tokenResponseSchema.parse(
      (
        await write(
          'post',
          '/v1/auth/mfa/verify',
          { method: 'totp', code: code(user.secret) },
          challenge,
        ).expect(200)
      ).body,
    );
    const sessions = z
      .object({
        sessions: z.array(
          z.strictObject({
            id: z.uuid(),
            createdAt: z.string(),
            expiresAt: z.string(),
            revokedAt: z.string().nullable(),
            current: z.boolean(),
          }),
        ),
      })
      .parse((await read('/v1/me/sessions', user.auth.accessToken).expect(200)).body);
    expect(sessions.sessions).toHaveLength(2);
    const secondId = z.uuid().parse(second.refreshToken.split('.')[0]);
    await write('delete', `/v1/me/sessions/${secondId}`, {}, user.auth.accessToken).expect(204);
    await read('/v1/me', second.accessToken).expect(401);
    await read('/v1/me', user.auth.accessToken).expect(200);
  });
});

describe('abuse controls, redaction and atomic failure', () => {
  it('limits anonymous protected-route traffic before authentication and bounds denial audit growth', async () => {
    const middleware = new SecurityMiddleware(
      core.authorization,
      new RedisRateLimiter(redis),
      core.secrets,
      { login: 10, ip: 1 },
    );
    const isolated = createApp(
      Router(),
      createLogger('silent'),
      false,
      createIdentityRouter(
        new IdentityController(core.accounts, core.authentication, core.mfa),
        middleware,
      ),
    );
    for (let index = 0; index < 5; index += 1) await request(isolated).get('/v1/me').expect(401);
    await request(isolated).get('/v1/me').expect(429);
    const before = await count('audit_logs');
    for (let index = 0; index < 10; index += 1) await request(isolated).get('/v1/me').expect(429);
    expect(await count('audit_logs')).toBe(before);
    expect(await auditCount('auth.rate_limited')).toBe(1);
  });
  it('does not consume a TOTP or flow when mandatory MFA audit persistence fails', async () => {
    const user = await patient();
    const challenge = await login(user.email, user.password);
    clock.advance(30);
    const key = randomUUID();
    const body = { method: 'totp', code: code(user.secret) };
    await failAudit('auth.mfa_verified');
    await write('post', '/v1/auth/mfa/verify', body, challenge, key).expect(500);
    expect(await count('auth_sessions')).toBe(1);
    await pool.query(
      'DROP TRIGGER test_audit_failure ON audit_logs; DROP FUNCTION test_audit_failure()',
    );
    await write('post', '/v1/auth/mfa/verify', body, challenge, key).expect(200);
    expect(await count('auth_sessions')).toBe(2);
    expect(await auditCount('auth.mfa_verified')).toBe(1);
  });
  it('keeps sessions valid after an incorrect current password and rejects expired access tokens', async () => {
    const user = await patient();
    await write(
      'post',
      '/v1/me/password',
      { currentPassword: 'incorrect-test-password', newPassword: 'replacement-test-password' },
      user.auth.accessToken,
    ).expect(401);
    await read('/v1/me', user.auth.accessToken).expect(200);
    clock.advance(301);
    await read('/v1/me', user.auth.accessToken).expect(401);
  });
  it('limits login attempts uniformly and ignores spoofed forwarding headers', async () => {
    for (let i = 0; i < 10; i += 1)
      await write('post', '/v1/auth/login', {
        email: 'absent@example.test',
        password: 'wrong-password',
      })
        .set('X-Forwarded-For', `192.0.2.${i + 1}`)
        .expect(401);
    const limited = await write('post', '/v1/auth/login', {
      email: 'absent@example.test',
      password: 'wrong-password',
    }).expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(await auditCount('auth.rate_limited')).toBe(1);
  });
  it('fails closed when the security rate-limit dependency is unavailable', async () => {
    const middleware = new SecurityMiddleware(
      core.authorization,
      { consume: () => Promise.reject(new HttpError(503, 'SECURITY_DEPENDENCY_UNAVAILABLE')) },
      core.secrets,
      { login: 10, ip: 60 },
    );
    const isolated = createApp(
      Router(),
      createLogger('silent'),
      false,
      createIdentityRouter(
        new IdentityController(core.accounts, core.authentication, core.mfa),
        middleware,
      ),
    );
    const response = await request(isolated)
      .post('/v1/auth/login')
      .set('Idempotency-Key', randomUUID())
      .send({ email: 'nobody@example.test', password: 'not-a-password' })
      .expect(503);
    expect(response.body).toMatchObject({ error: { code: 'SECURITY_DEPENDENCY_UNAVAILABLE' } });
    expect(await count('auth_flows')).toBe(0);
  });
  it('caps failed MFA attempts and does not reset the cap with idempotency retries', async () => {
    const user = await patient();
    const challenge = await login(user.email, user.password);
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(user.secret),
      digits: 6,
      period: 30,
    });
    let wrong = '000000';
    if (totp.validate({ token: wrong, timestamp: clock.now().getTime(), window: 1 }) !== null)
      wrong = '111111';
    const key = randomUUID();
    await write(
      'post',
      '/v1/auth/mfa/verify',
      { method: 'totp', code: wrong },
      challenge,
      key,
    ).expect(401);
    await write(
      'post',
      '/v1/auth/mfa/verify',
      { method: 'totp', code: wrong },
      challenge,
      key,
    ).expect(401);
    for (let i = 0; i < 4; i += 1)
      await write('post', '/v1/auth/mfa/verify', { method: 'totp', code: wrong }, challenge).expect(
        401,
      );
    clock.advance(30);
    await write(
      'post',
      '/v1/auth/mfa/verify',
      { method: 'totp', code: code(user.secret) },
      challenge,
    ).expect(401);
    expect(await count('auth_sessions')).toBe(1);
    expect(
      (
        await pool.query<{ attempts: number }>('SELECT attempts FROM auth_flows WHERE purpose=$1', [
          'verify',
        ])
      ).rows[0]?.attempts,
    ).toBe(5);
  });
  it('counts conflicting MFA retries against the durable budget without revoking existing sessions', async () => {
    for (const operation of ['confirm', 'verify'] as const) {
      const user = await patient();
      let challenge = user.challenge;
      let key = user.confirmationKey;
      if (operation === 'verify') {
        challenge = await login(user.email, user.password);
        key = randomUUID();
        clock.advance(30);
      }
      const valid = code(user.secret);
      const body = operation === 'confirm' ? { code: valid } : { method: 'totp', code: valid };
      await write('post', `/v1/auth/mfa/${operation}`, body, challenge, key).expect(200);
      const changed = { ...body, code: String((Number(valid) + 1) % 1000000).padStart(6, '0') };
      for (let attempt = 0; attempt < 5; attempt += 1)
        await write('post', `/v1/auth/mfa/${operation}`, changed, challenge, key).expect(409);
      await write('post', `/v1/auth/mfa/${operation}`, body, challenge, key).expect(401);
      const purpose = operation === 'confirm' ? 'enroll' : 'verify';
      const flows = await pool.query<{ attempts: number }>(
        'SELECT attempts FROM auth_flows WHERE user_id=$1 AND purpose=$2',
        [user.userId, purpose],
      );
      expect(flows.rows[0]?.attempts).toBe(5);
      await read('/v1/me', user.auth.accessToken).expect(200);
    }
  });
  it('bounds authenticated recovery-factor guesses per account', async () => {
    const user = await patient();
    const totp = new OTPAuth.TOTP({
      secret: OTPAuth.Secret.fromBase32(user.secret),
      digits: 6,
      period: 30,
    });
    let candidate = 0;
    while (
      totp.validate({
        token: String(candidate).padStart(6, '0'),
        timestamp: clock.now().getTime(),
        window: 1,
      }) !== null
    )
      candidate += 1;
    const body = { password: user.password, code: String(candidate).padStart(6, '0') };
    for (let attempt = 0; attempt < 5; attempt += 1)
      await write('post', '/v1/me/mfa/recovery-codes', body, user.auth.accessToken).expect(401);
    await write('post', '/v1/me/mfa/recovery-codes', body, user.auth.accessToken).expect(429);
  });
  it('regenerates recovery codes with fresh MFA and invalidates the old codes', async () => {
    const user = await patient();
    clock.advance(30);
    const key = randomUUID();
    const body = { password: user.password, code: code(user.secret) };
    const first = await write(
      'post',
      '/v1/me/mfa/recovery-codes',
      body,
      user.auth.accessToken,
      key,
    ).expect(200);
    expect(
      (
        await write('post', '/v1/me/mfa/recovery-codes', body, user.auth.accessToken, key).expect(
          200,
        )
      ).body,
    ).toEqual(first.body);
    const challenge = await login(user.email, user.password);
    await write(
      'post',
      '/v1/auth/mfa/verify',
      { method: 'recovery', code: z.string().parse(user.auth.recoveryCodes?.[0]) },
      challenge,
    ).expect(401);
    const newCodes = z.object({ recoveryCodes: z.array(z.string()) }).parse(first.body);
    await write(
      'post',
      '/v1/auth/mfa/verify',
      { method: 'recovery', code: z.string().parse(newCodes.recoveryCodes[0]) },
      challenge,
    ).expect(200);
  });
  it('does not leak credentials into audit metadata or persisted retry responses', async () => {
    const user = await patient();
    await write('post', '/v1/auth/login', {
      email: user.email,
      password: 'incorrect-redaction-test',
    }).expect(401);
    const audit = (await pool.query<{ metadata: unknown }>('SELECT metadata FROM audit_logs')).rows;
    const retries = (
      await pool.query<{ response_body: unknown; response_encrypted: boolean }>(
        'SELECT response_body,response_encrypted FROM idempotency_records',
      )
    ).rows;
    const factor = (
      await pool.query<{ secret_envelope: unknown }>('SELECT secret_envelope FROM mfa_factors')
    ).rows;
    const sensitive = [
      user.password,
      user.auth.accessToken,
      user.auth.refreshToken,
      user.secret,
      ...(user.auth.recoveryCodes ?? []),
    ];
    for (const value of sensitive) {
      expect(JSON.stringify(audit).includes(value)).toBe(false);
      expect(JSON.stringify(retries).includes(value)).toBe(false);
      expect(JSON.stringify(factor).includes(value)).toBe(false);
    }
    expect(retries.every((row) => row.response_encrypted)).toBe(true);
    const safe = (await read('/v1/me', user.auth.accessToken)).text;
    for (const key of [
      'password_hash',
      'refresh_token_hash',
      'secret_envelope',
      'last_accepted_step',
      'code_hash',
      'provisioningUri',
    ])
      expect(safe).not.toContain(key);
  });
  it('rolls registration, setup delivery, audit and idempotency back if audit persistence fails', async () => {
    await failAudit('identity.registered');
    await write('post', '/v1/auth/register', {
      email: 'rollback@example.test',
      password: 'rollback-test-password',
      displayName: 'Rollback',
    }).expect(500);
    for (const table of ['users', 'outbox_jobs', 'idempotency_records', 'audit_logs'] as const)
      expect(await count(table)).toBe(0);
  });
  it('rolls password changes and revocations back if their mandatory audit insert fails', async () => {
    const user = await patient();
    const before = await core.work.run((r) => r.identity.userById(user.userId));
    const key = randomUUID();
    const body = { currentPassword: user.password, newPassword: 'rollback-new-test-password' };
    await failAudit('identity.password_changed');
    await write('post', '/v1/me/password', body, user.auth.accessToken, key).expect(500);
    const after = await core.work.run((r) => r.identity.userById(user.userId));
    expect(before?.password_hash === after?.password_hash).toBe(true);
    expect(after?.auth_version).toBe(before?.auth_version);
    await read('/v1/me', user.auth.accessToken).expect(200);
    await pool.query(
      'DROP TRIGGER test_audit_failure ON audit_logs; DROP FUNCTION test_audit_failure()',
    );
    await write('post', '/v1/me/password', body, user.auth.accessToken, key).expect(204);
    await read('/v1/me', user.auth.accessToken).expect(401);
  });
  it('rejects malformed bodies, missing idempotency keys and invalid resource identifiers', async () => {
    await request(application.app)
      .post('/v1/auth/register')
      .send({ email: 'bad', password: 'short', displayName: '' })
      .set('Idempotency-Key', randomUUID())
      .expect(400);
    await request(application.app)
      .post('/v1/auth/login')
      .send({ email: 'user@example.test', password: 'test' })
      .expect(400);
    await request(application.app)
      .post('/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    const user = await patient();
    await read('/v1/users/not-a-uuid/profile', user.auth.accessToken).expect(400);
    await write('patch', '/v1/me', { timeZone: 'Not/A_Timezone' }, user.auth.accessToken).expect(
      400,
    );
  });
});
