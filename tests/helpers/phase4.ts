import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import request from 'supertest';
import { createClient } from 'redis';
import {
  composeApi,
  composeIdentityCore,
  composeClinicalCore,
} from '../../src/composition-root.js';
import { createDatabase } from '../../src/infrastructure/database/client.js';
import { migrate } from '../../src/infrastructure/database/migrator.js';
import { loadConfig } from '../../src/infrastructure/config/env.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';
import { JwtTokens } from '../../src/infrastructure/security/tokens.js';
import { JobRepository } from '../../src/modules/jobs/repositories/job.repository.js';
import { OutboxWorker } from '../../src/modules/jobs/services/outbox-worker.js';
import { DeterministicFakeRefundAdapter } from '../../src/infrastructure/payments/fake-refund-adapter.js';
import { makeSecurityConfig, TestClock } from './security.js';
import type { Actor, Role } from '../../src/modules/identity/domain/security.js';
import type { RefundAdapter } from '../../src/modules/payments/domain/ports.js';
export interface Fixture {
  actor: Actor;
  token: string;
  doctorId?: string;
}
export function phase4Harness() {
  const url = process.env.TEST_DATABASE_URL;
  const redisUrl = process.env.TEST_REDIS_URL;
  if (
    !url ||
    !decodeURIComponent(new URL(url).pathname).endsWith('_test') ||
    !redisUrl ||
    new URL(redisUrl).pathname !== '/15'
  )
    throw new Error('Phase 4 tests require isolated _test and Redis /15; both reset');
  const pool = new pg.Pool({ connectionString: url, max: 20 });
  const database = createDatabase(new pg.Pool({ connectionString: url }));
  const workerUrl = new URL(url);
  workerUrl.searchParams.set('options', '-c role=amrutam_worker');
  const workerDatabase = createDatabase(
    new pg.Pool({ connectionString: workerUrl.toString(), max: 10 }),
  );
  const apiUrl = new URL(url);
  apiUrl.searchParams.set('options', '-c role=amrutam_api');
  const apiDatabase = createDatabase(new pg.Pool({ connectionString: apiUrl.toString() }));
  const redis = createClient({ url: redisUrl });
  const clock = new TestClock();
  clock.advance(30);
  const security = makeSecurityConfig({ AUTH_IP_LIMIT: 10000 });
  const tokens = new JwtTokens(security, clock);
  const config = loadConfig({
    DATABASE_URL: apiUrl.toString(),
    REDIS_URL: redisUrl,
    NODE_ENV: 'test',
    DATABASE_POOL_MAX: '20',
  });
  const application = composeApi(config, createLogger('silent'), security, clock);
  const identity = composeIdentityCore(apiDatabase, security, clock);
  const core = composeClinicalCore(apiDatabase, identity, clock);
  const jobs = new JobRepository(workerDatabase);
  const worker = (adapter: RefundAdapter = new DeterministicFakeRefundAdapter()) =>
    new OutboxWorker(
      jobs,
      adapter,
      clock,
      createLogger('silent'),
      { pollMs: 10, leaseMs: 30000 },
      () => 0.5,
    );
  async function setup() {
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await pool.query(
      "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='amrutam_api') THEN CREATE ROLE amrutam_api NOLOGIN; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='amrutam_worker') THEN CREATE ROLE amrutam_worker NOLOGIN; END IF; END $$",
    );
    await migrate(pool, 'up');
    await redis.connect();
    await application.connect();
  }
  async function reset() {
    await pool.query(
      'TRUNCATE users CASCADE; TRUNCATE outbox_jobs,idempotency_records,job_receipts',
    );
    await redis.flushDb();
  }
  async function close() {
    await application.close();
    await redis.close();
    await apiDatabase.destroy();
    await database.destroy();
    await workerDatabase.destroy();
    await pool.end();
  }
  async function account(role: Role = 'patient'): Promise<Fixture> {
    const userId = randomUUID();
    const sessionId = randomUUID();
    await pool.query(
      "INSERT INTO users(id,email,password_hash,role,status,activated_at) VALUES($1,$2,$3,$4,'active',$5)",
      [userId, `${userId}@example.test`, randomBytes(32).toString('hex'), role, clock.now()],
    );
    await pool.query('INSERT INTO profiles(user_id,display_name) VALUES($1,$2)', [
      userId,
      'Fixture User',
    ]);
    await pool.query(
      'INSERT INTO auth_sessions(id,user_id,refresh_token_hash,expires_at,mfa_verified_at) VALUES($1,$2,$3,$4,$5)',
      [
        sessionId,
        userId,
        randomBytes(32).toString('hex'),
        new Date(clock.now().getTime() + 7 * 86400000),
        clock.now(),
      ],
    );
    const actor: Actor = { userId, sessionId, authVersion: 1, role };
    let doctorId: string | undefined;
    if (role === 'doctor')
      doctorId = (
        await pool.query<{ id: string }>(
          'INSERT INTO doctors(user_id,public_name,specialty) VALUES($1,$2,$3) RETURNING id',
          [userId, 'Fixture Doctor', 'Ayurveda'],
        )
      ).rows[0]?.id;
    return {
      actor,
      token: await tokens.access(actor, new Date(clock.now().getTime() + 300000)),
      ...(doctorId ? { doctorId } : {}),
    };
  }
  async function consultation(doctor: Fixture, patient: Fixture, startMinutes = -1) {
    const starts = new Date(clock.now().getTime() + startMinutes * 60000);
    const ends = new Date(starts.getTime() + 1800000);
    const slot = (
      await pool.query<{ id: string }>(
        'INSERT INTO availability_slots(doctor_id,starts_at,ends_at) VALUES($1,$2,$3) RETURNING id',
        [doctor.doctorId, starts, ends],
      )
    ).rows[0]!;
    return (
      await pool.query<{ id: string }>(
        'INSERT INTO consultations(slot_id,doctor_id,patient_id) VALUES($1,$2,$3) RETURNING id',
        [slot.id, doctor.doctorId, patient.actor.userId],
      )
    ).rows[0]!.id;
  }
  const write = (
    path: string,
    body: object,
    actor?: Fixture,
    key = randomUUID(),
    method: 'post' | 'put' | 'patch' = 'post',
  ) => {
    const r = request(application.app)[method](path).set('Idempotency-Key', key);
    if (actor) r.set('Authorization', `Bearer ${actor.token}`);
    return r.send(body);
  };
  const get = (path: string, actor?: Fixture) => {
    const r = request(application.app).get(path);
    if (actor) r.set('Authorization', `Bearer ${actor.token}`);
    return r;
  };
  async function renew(actor: Fixture, recent = false) {
    actor.token = await tokens.access(actor.actor, new Date(clock.now().getTime() + 300000));
    if (recent)
      await pool.query('UPDATE auth_sessions SET mfa_verified_at=$2 WHERE id=$1', [
        actor.actor.sessionId,
        clock.now(),
      ]);
  }
  const range = () =>
    new URLSearchParams({
      from: new Date(clock.now().getTime() - 86400000).toISOString(),
      to: new Date(clock.now().getTime() + 86400000).toISOString(),
    }).toString();
  async function count(
    table:
      | 'consultations'
      | 'prescriptions'
      | 'payments'
      | 'outbox_jobs'
      | 'job_receipts'
      | 'audit_logs',
    where = 'true',
  ) {
    return Number(
      (await pool.query<{ count: string }>(`SELECT count(*) FROM ${table} WHERE ${where}`)).rows[0]
        ?.count,
    );
  }
  async function drain(runner = worker()) {
    for (let i = 0; i < 100; i++) {
      if (!(await runner.tick())) return;
    }
    throw new Error('Worker did not drain');
  }
  return {
    pool,
    database,
    apiDatabase,
    workerDatabase,
    redis,
    clock,
    security,
    tokens,
    application,
    identity,
    core,
    jobs,
    worker,
    setup,
    reset,
    close,
    account,
    consultation,
    write,
    get,
    renew,
    range,
    count,
    drain,
  };
}
export const notes = {
  summary: 'Private clinical summary',
  assessment: 'Private assessment',
  plan: 'Private plan',
};
export const content = {
  medications: [
    {
      name: 'Fixture medication',
      dosage: 'Fixture dose',
      instructions: 'Private clinical instructions',
    },
  ],
  instructions: 'Private prescription instruction',
};
