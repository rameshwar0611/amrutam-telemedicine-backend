import { makeSecurityConfig } from '../helpers/security.js';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { migrate } from '../../src/infrastructure/database/migrator.js';
import { createDatabase } from '../../src/infrastructure/database/client.js';
import { PostgresUnitOfWork } from '../../src/infrastructure/database/unit-of-work.js';
import { loadConfig } from '../../src/infrastructure/config/env.js';
import { composeApi, composeWorker } from '../../src/composition-root.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';

const url = process.env.TEST_DATABASE_URL;
if (!url || !decodeURIComponent(new URL(url).pathname).endsWith('_test')) {
  throw new Error(
    'Set TEST_DATABASE_URL to an isolated PostgreSQL database ending in _test; integration tests reset its public schema',
  );
}
const pool = new pg.Pool({ connectionString: url, max: 25, statement_timeout: 10_000 });
const envelope = {
  ciphertext: 'test-ciphertext',
  iv: 'test-iv',
  tag: 'test-tag',
  key_version: 'test-only',
};

function first<T>(rows: T[]): T {
  const value = rows[0];
  if (!value) throw new Error('Expected a database row');
  return value;
}

async function user(role: 'patient' | 'doctor' = 'patient'): Promise<string> {
  const id = randomUUID();
  await pool.query('INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)', [
    id,
    `${id}@example.test`,
    'schema-test-only-not-a-login-password-hash',
    role,
  ]);
  return id;
}

async function doctor(): Promise<string> {
  const userId = await user('doctor');
  return first(
    (
      await pool.query<{ id: string }>(
        'INSERT INTO doctors(user_id,public_name,specialty) VALUES($1,$2,$3) RETURNING id',
        [userId, 'Test Doctor', 'Ayurveda'],
      )
    ).rows,
  ).id;
}

async function slot(doctorId: string, offsetMinutes = 0): Promise<string> {
  const start = new Date(Date.UTC(new Date().getUTCFullYear() + 1, 0, 1, 9, offsetMinutes));
  const end = new Date(start.getTime() + 30 * 60_000);
  return first(
    (
      await pool.query<{ id: string }>(
        'INSERT INTO availability_slots(doctor_id,starts_at,ends_at) VALUES($1,$2,$3) RETURNING id',
        [doctorId, start, end],
      )
    ).rows,
  ).id;
}

let doctorId: string;
let patientId: string;
let slotId: string;

async function consultation(): Promise<string> {
  return first(
    (
      await pool.query<{ id: string }>(
        'INSERT INTO consultations(slot_id,doctor_id,patient_id) VALUES($1,$2,$3) RETURNING id',
        [slotId, doctorId, patientId],
      )
    ).rows,
  ).id;
}

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='amrutam_api') THEN CREATE ROLE amrutam_api NOLOGIN; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='amrutam_worker') THEN CREATE ROLE amrutam_worker NOLOGIN; END IF;
  END $$`);
  await migrate(pool, 'up');
});

beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE');
  await pool.query('TRUNCATE outbox_jobs, idempotency_records, job_receipts');
  doctorId = await doctor();
  patientId = await user();
  slotId = await slot(doctorId);
});

afterAll(async () => {
  await pool.end();
});

describe('schema and concurrency invariants', () => {
  it('creates all eight core and eight supporting tables', async () => {
    const tables = (
      await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'",
      )
    ).rows.map((row) => row.tablename);
    for (const table of [
      'users',
      'profiles',
      'doctors',
      'availability_slots',
      'consultations',
      'prescriptions',
      'payments',
      'audit_logs',
      'auth_sessions',
      'mfa_factors',
      'mfa_recovery_codes',
      'auth_tokens',
      'idempotency_records',
      'outbox_jobs',
      'auth_flows',
      'refresh_token_history',
    ])
      expect(tables).toContain(table);
  });
  it('rejects overlapping doctor slots while allowing adjacent slots', async () => {
    await expect(slot(doctorId, 15)).rejects.toMatchObject({ code: '23P01' });
    await expect(slot(doctorId, 30)).resolves.toBeDefined();
    await expect(slot(await doctor())).resolves.toBeDefined();
  });
  it('allows exactly one of twenty concurrent bookings for one slot', async () => {
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => consultation()));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    for (const outcome of outcomes)
      if (outcome.status === 'rejected') expect(outcome.reason).toMatchObject({ code: '23505' });
    expect(
      first(
        (
          await pool.query<{ count: string }>(
            'SELECT count(*) FROM consultations WHERE slot_id=$1',
            [slotId],
          )
        ).rows,
      ).count,
    ).toBe('1');
  });
  it('allows rebooking after an explicit cancellation', async () => {
    const id = await consultation();
    await pool.query(
      "UPDATE consultations SET status='cancelled',cancelled_at=now(),cancellation_reason='Patient request' WHERE id=$1",
      [id],
    );
    await expect(consultation()).resolves.toBeDefined();
  });
  it('keeps completed consultations occupying their slot', async () => {
    const id = await consultation();
    await pool.query("UPDATE consultations SET status='in_progress',started_at=now() WHERE id=$1", [
      id,
    ]);
    await pool.query(
      "UPDATE consultations SET status='completed',started_at=now(),completed_at=now() WHERE id=$1",
      [id],
    );
    await expect(consultation()).rejects.toMatchObject({ code: '23505' });
  });
  it('rejects a consultation whose doctor does not own the slot', async () => {
    await expect(
      pool.query('INSERT INTO consultations(slot_id,doctor_id,patient_id) VALUES($1,$2,$3)', [
        slotId,
        await doctor(),
        patientId,
      ]),
    ).rejects.toMatchObject({ code: '23503' });
  });
  it('rejects incomplete lifecycle timestamps and cancellation reasons', async () => {
    const id = await consultation();
    await expect(
      pool.query("UPDATE consultations SET status='completed',started_at=now() WHERE id=$1", [id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query("UPDATE consultations SET status='cancelled',cancelled_at=now() WHERE id=$1", [
        id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('preserves historical slot times and rejects blocking active bookings', async () => {
    await consultation();
    await expect(
      pool.query(
        "UPDATE availability_slots SET starts_at=starts_at+interval '1 minute' WHERE id=$1",
        [slotId],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query("UPDATE availability_slots SET status='blocked' WHERE id=$1", [slotId]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects reassignment of an existing consultation identity', async () => {
    const id = await consultation();
    await expect(
      pool.query('UPDATE consultations SET patient_id=$1 WHERE id=$2', [await user(), id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects plaintext clinical contents', async () => {
    const id = await consultation();
    await expect(
      pool.query('UPDATE consultations SET clinical_notes=$1 WHERE id=$2', [
        { text: 'must not be plaintext' },
        id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('enforces prescription authorship and finalized immutability', async () => {
    const id = await consultation();
    await expect(
      pool.query(
        'INSERT INTO prescriptions(consultation_id,doctor_id,version,clinical_payload) VALUES($1,$2,1,$3)',
        [id, await doctor(), envelope],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    const prescription = first(
      (
        await pool.query<{ id: string }>(
          "INSERT INTO prescriptions(consultation_id,doctor_id,version,clinical_payload,status,finalized_at) VALUES($1,$2,1,$3,'finalized',now()) RETURNING id",
          [id, doctorId, envelope],
        )
      ).rows,
    ).id;
    await expect(
      pool.query('UPDATE prescriptions SET clinical_payload=$1 WHERE id=$2', [
        { ...envelope, ciphertext: 'changed' },
        prescription,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('DELETE FROM prescriptions WHERE id=$1', [prescription]),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query("UPDATE prescriptions SET status='revoked' WHERE id=$1", [prescription]);
    await expect(
      pool.query("UPDATE prescriptions SET status='draft',finalized_at=NULL WHERE id=$1", [
        prescription,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('routes audit events to monthly partitions and fallback, and prevents edits', async () => {
    const audit = first(
      (
        await pool.query<{ id: string; partition: string }>(
          "INSERT INTO audit_logs(actor_id,action,resource_type,outcome) VALUES($1,'test.read','consultation','success') RETURNING id, tableoid::regclass::text AS partition",
          [patientId],
        )
      ).rows,
    );
    expect(audit.partition).toMatch(/^audit_logs_\d{4}_\d{2}$/);
    const fallback = first(
      (
        await pool.query<{ partition: string }>(
          "INSERT INTO audit_logs(occurred_at,action,resource_type,outcome) VALUES('2099-01-01','test.read','consultation','success') RETURNING tableoid::regclass::text AS partition",
        )
      ).rows,
    );
    expect(fallback.partition).toBe('audit_logs_default');
    await expect(
      pool.query("UPDATE audit_logs SET outcome='denied' WHERE id=$1", [audit.id]),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      pool.query('DELETE FROM audit_logs WHERE id=$1', [audit.id]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('denies audit mutation, schema creation and migration access to runtime roles', async () => {
    const client = await pool.connect();
    try {
      for (const role of ['amrutam_api', 'amrutam_worker']) {
        await client.query(`SET ROLE ${role}`);
        await expect(client.query('DELETE FROM audit_logs WHERE false')).rejects.toMatchObject({
          code: '42501',
        });
        await expect(
          client.query('CREATE TABLE runtime_must_not_create(id integer)'),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(client.query('SELECT * FROM schema_migrations')).rejects.toMatchObject({
          code: '42501',
        });
        if (role === 'amrutam_api') await client.query('SELECT 1 FROM users LIMIT 1');
        else
          await expect(client.query('SELECT 1 FROM users LIMIT 1')).rejects.toMatchObject({
            code: '42501',
          });
        if (role === 'amrutam_worker') {
          await expect(client.query('SELECT * FROM mfa_factors')).rejects.toMatchObject({
            code: '42501',
          });
          await expect(
            client.query('SELECT refresh_token_hash FROM auth_sessions'),
          ).rejects.toMatchObject({ code: '42501' });
        }
        await client.query('RESET ROLE');
      }
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });
  it('rejects negative money and duplicate payment-provider references', async () => {
    const id = await consultation();
    await expect(
      pool.query(
        "INSERT INTO payments(consultation_id,amount_minor,currency) VALUES($1,-1,'INR')",
        [id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      "INSERT INTO payments(consultation_id,amount_minor,currency,provider_reference) VALUES($1,100,'INR','test-reference')",
      [id],
    );
    await expect(
      pool.query(
        "INSERT INTO payments(consultation_id,amount_minor,currency,provider_reference) VALUES($1,100,'INR','test-reference')",
        [id],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
  it('enforces idempotency scope uniqueness and outbox deduplication', async () => {
    const parameters = [patientId, `actor:${patientId}:book`, 'test-key-123', 'a'.repeat(64)];
    const insert =
      "INSERT INTO idempotency_records(actor_id,scope,key,request_fingerprint,expires_at) VALUES($1,$2,$3,$4,now()+interval '1 day')";
    await pool.query(insert, parameters);
    await expect(pool.query(insert, parameters)).rejects.toMatchObject({ code: '23505' });
    await pool.query(
      "INSERT INTO outbox_jobs(kind,deduplication_key,payload) VALUES('test','unique-test','{}')",
    );
    await expect(
      pool.query(
        "INSERT INTO outbox_jobs(kind,deduplication_key,payload) VALUES('test','unique-test','{}')",
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });
  it('rolls back consultation, audit, outbox and idempotency writes together', async () => {
    const database = createDatabase(new pg.Pool({ connectionString: url }));
    const unitOfWork = new PostgresUnitOfWork(database, (transaction) => ({ transaction }));
    try {
      await expect(
        unitOfWork.run(async ({ transaction }) => {
          await transaction
            .insertInto('consultations')
            .values({ slot_id: slotId, doctor_id: doctorId, patient_id: patientId })
            .execute();
          await transaction
            .insertInto('audit_logs')
            .values({
              actor_id: patientId,
              action: 'test',
              resource_type: 'consultation',
              outcome: 'success',
            })
            .execute();
          await transaction
            .insertInto('outbox_jobs')
            .values({ kind: 'test', deduplication_key: 'rollback-test', payload: {} })
            .execute();
          await transaction
            .insertInto('idempotency_records')
            .values({
              actor_id: patientId,
              scope: 'test',
              key: 'rollback-key',
              request_fingerprint: 'a'.repeat(64),
              expires_at: new Date(Date.now() + 60_000),
            })
            .execute();
          throw new Error('Injected failure');
        }),
      ).rejects.toThrow('Injected failure');
      for (const table of ['consultations', 'audit_logs', 'outbox_jobs', 'idempotency_records']) {
        expect(
          first((await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`)).rows).count,
        ).toBe('0');
      }
    } finally {
      await database.destroy();
    }
  });
});

describe('runtime dependency wiring', () => {
  it('connects the API and worker to actual PostgreSQL and Redis', async () => {
    if (!process.env.TEST_REDIS_URL)
      throw new Error('TEST_REDIS_URL is required for dependency integration tests');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      REDIS_URL: process.env.TEST_REDIS_URL,
    });
    for (const application of [
      composeApi(config, createLogger('silent'), makeSecurityConfig()),
      composeWorker(config, createLogger('silent')),
    ]) {
      try {
        await application.connect();
        await request(application.app).get('/health/ready').expect(200);
      } finally {
        await application.close();
      }
    }
  });
});

describe('migration reliability', () => {
  it('serializes concurrent runners and is repeatable', async () => {
    const [firstRun, secondRun] = await Promise.all([migrate(pool, 'up'), migrate(pool, 'up')]);
    expect(firstRun).toEqual(secondRun);
    expect(firstRun).toHaveLength(9);
    expect(firstRun.every((migration) => migration.applied)).toBe(true);
  });
  it('rejects changed migration history and atomically rolls back failed migrations', async () => {
    await mkdir(resolve('work'), { recursive: true });
    const temporary = await mkdtemp(resolve('work/migrations-'));
    try {
      await cp(resolve('migrations'), temporary, { recursive: true });
      await writeFile(resolve(temporary, '0001_extensions.up.sql'), 'SELECT 1;');
      await expect(migrate(pool, 'up', temporary)).rejects.toThrow('Migration history differs');
      await cp(resolve('migrations'), temporary, { recursive: true });
      await writeFile(
        resolve(temporary, '0010_failure.up.sql'),
        'CREATE TABLE must_rollback(id integer); SELECT missing_test_function();',
      );
      await writeFile(resolve(temporary, '0010_failure.down.sql'), 'DROP TABLE must_rollback;');
      await expect(migrate(pool, 'up', temporary)).rejects.toMatchObject({ code: '42883' });
      expect(
        first(
          (
            await pool.query<{ result: string | null }>(
              "SELECT to_regclass('must_rollback')::text AS result",
            )
          ).rows,
        ).result,
      ).toBeNull();
      expect((await migrate(pool, 'status')).every((migration) => migration.applied)).toBe(true);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
  it('rolls all nine migrations down and reapplies from a clean schema', async () => {
    await pool.query(
      'TRUNCATE users CASCADE; TRUNCATE outbox_jobs, idempotency_records, job_receipts',
    );
    for (let index = 0; index < 9; index += 1) await migrate(pool, 'down');
    expect((await migrate(pool, 'status')).every((migration) => !migration.applied)).toBe(true);
    expect((await migrate(pool, 'up')).every((migration) => migration.applied)).toBe(true);
  });
});
