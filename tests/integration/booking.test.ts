import { RedisDirectoryCache } from '../../src/infrastructure/cache/redis-directory-cache.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import { createClient } from 'redis';
import { composeApi, composeIdentityCore, composeBookingCore } from '../../src/composition-root.js';
import { createDatabase } from '../../src/infrastructure/database/client.js';
import { migrate } from '../../src/infrastructure/database/migrator.js';
import { loadConfig } from '../../src/infrastructure/config/env.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';
import { JwtTokens } from '../../src/infrastructure/security/tokens.js';
import { makeSecurityConfig, TestClock } from '../helpers/security.js';
import {
  consultationDtoSchema,
  slotDtoSchema,
  slotPageSchema,
} from '../../src/modules/bookings/schemas.js';
import { doctorPageSchema, discoveryQuerySchema } from '../../src/modules/doctors/schemas.js';
import { DiscoveryService } from '../../src/modules/doctors/services/discovery.service.js';
import { DirectoryRepository } from '../../src/modules/doctors/repositories/directory.repository.js';
import type { Actor, Role } from '../../src/modules/identity/domain/security.js';

const url = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.TEST_REDIS_URL;
if (
  !url ||
  !decodeURIComponent(new URL(url).pathname).endsWith('_test') ||
  !redisUrl ||
  new URL(redisUrl).pathname !== '/15'
)
  throw new Error('Booking tests require isolated _test DB and Redis /15; both reset');
const pool = new pg.Pool({ connectionString: url, max: 20 });
const database = createDatabase(new pg.Pool({ connectionString: url, max: 20 }));
const redis = createClient({ url: redisUrl });
const clock = new TestClock();
const security = makeSecurityConfig({ AUTH_IP_LIMIT: 10000 });
const tokens = new JwtTokens(security, clock);
const restricted = new URL(url);
restricted.searchParams.set('options', '-c role=amrutam_api');
const config = loadConfig({
  DATABASE_URL: restricted.toString(),
  REDIS_URL: redisUrl,
  NODE_ENV: 'test',
  DATABASE_POOL_MAX: '20',
});
const application = composeApi(config, createLogger('silent'), security, clock);
const core = composeIdentityCore(database, security, clock);
const booking = composeBookingCore(database, core, clock);
interface Fixture {
  actor: Actor;
  token: string;
  doctorId?: string;
}
// Trusted DB fixtures represent completed activation/MFA; Phase 2 exercises the real enrollment flow.
async function account(
  role: Role = 'patient',
  name = 'Doctor Example',
  specialty = 'Ayurveda',
): Promise<Fixture> {
  const userId = randomUUID();
  const sessionId = randomUUID();
  await pool.query(
    "INSERT INTO users(id,email,password_hash,role,status,activated_at) VALUES($1,$2,$3,$4,'active',$5)",
    [userId, `${userId}@example.test`, randomBytes(32).toString('hex'), role, clock.now()],
  );
  await pool.query('INSERT INTO profiles(user_id,display_name) VALUES($1,$2)', [userId, name]);
  await pool.query(
    'INSERT INTO auth_sessions(id,user_id,refresh_token_hash,expires_at,mfa_verified_at) VALUES($1,$2,$3,$4,$5)',
    [
      sessionId,
      userId,
      randomBytes(32).toString('hex'),
      new Date(clock.now().getTime() + 86400000),
      clock.now(),
    ],
  );
  const actor: Actor = { userId, sessionId, authVersion: 1, role };
  const token = await tokens.access(actor, new Date(clock.now().getTime() + 300000));
  let doctorId: string | undefined;
  if (role === 'doctor')
    doctorId = (
      await pool.query<{ id: string }>(
        'INSERT INTO doctors(user_id,public_name,specialty) VALUES($1,$2,$3) RETURNING id',
        [userId, name, specialty],
      )
    ).rows[0]?.id;
  return { actor, token, ...(doctorId ? { doctorId } : {}) };
}
const write = (
  path: string,
  body: object,
  fixture?: Fixture,
  key = randomUUID(),
  method: 'post' | 'patch' = 'post',
) => {
  const test = request(application.app)[method](path).set('Idempotency-Key', key);
  if (fixture) test.set('Authorization', `Bearer ${fixture.token}`);
  return test.send(body);
};
const get = (path: string, fixture?: Fixture) => {
  const test = request(application.app).get(path);
  if (fixture) test.set('Authorization', `Bearer ${fixture.token}`);
  return test;
};
const slotInput = (minutes = 60) => ({
  startsAt: new Date(clock.now().getTime() + minutes * 60000).toISOString(),
  endsAt: new Date(clock.now().getTime() + (minutes + 30) * 60000).toISOString(),
  timeZone: 'UTC',
});
async function slot(doctor: Fixture, minutes = 60) {
  return slotDtoSchema.parse(
    (
      await write(`/v1/doctors/${doctor.doctorId}/availability`, slotInput(minutes), doctor).expect(
        201,
      )
    ).body,
  );
}
async function book(patient: Fixture, id: string, key = randomUUID()) {
  return consultationDtoSchema.parse(
    (await write('/v1/consultations', { slotId: id }, patient, key).expect(201)).body,
  );
}
async function count(table: 'consultations' | 'idempotency_records', where = 'true') {
  return Number(
    (await pool.query<{ count: string }>(`SELECT count(*) FROM ${table} WHERE ${where}`)).rows[0]
      ?.count,
  );
}
async function events(kind: string) {
  return Number(
    (await pool.query<{ count: string }>('SELECT count(*) FROM outbox_jobs WHERE kind=$1', [kind]))
      .rows[0]?.count,
  );
}
async function audits(action: string) {
  return Number(
    (
      await pool.query<{ count: string }>('SELECT count(*) FROM audit_logs WHERE action=$1', [
        action,
      ])
    ).rows[0]?.count,
  );
}
async function injectFailure(
  table: 'audit_logs' | 'outbox_jobs' | 'idempotency_records',
  condition: string,
) {
  await pool.query(
    `CREATE FUNCTION fail_booking_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'Injected persistence failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_booking_test BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_booking_test()`,
  );
}
async function clearFailure() {
  for (const table of ['audit_logs', 'outbox_jobs', 'idempotency_records'])
    await pool.query(`DROP TRIGGER IF EXISTS fail_booking_test ON ${table}`);
  await pool.query('DROP FUNCTION IF EXISTS fail_booking_test()');
}
beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await pool.query(
    "DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='amrutam_api') THEN CREATE ROLE amrutam_api NOLOGIN; END IF; END $$",
  );
  await migrate(pool, 'up');
  await redis.connect();
  await application.connect();
});
beforeEach(async () => {
  await pool.query('TRUNCATE users CASCADE; TRUNCATE outbox_jobs,idempotency_records,job_receipts');
  await redis.flushDb();
});
afterEach(clearFailure);
afterAll(async () => {
  await application.close();
  await redis.close();
  await database.destroy();
  await pool.end();
});

describe('availability and authorization', () => {
  it('creates adjacent slots, rejects overlaps, and replays creation without duplicate audit', async () => {
    const doctor = await account('doctor');
    const key = randomUUID();
    const body = slotInput();
    const path = `/v1/doctors/${doctor.doctorId}/availability`;
    const first = await write(path, body, doctor, key).expect(201);
    expect((await write(path, body, doctor, key).expect(201)).body).toEqual(first.body);
    await write(path, slotInput(75), doctor).expect(409);
    await slot(doctor, 90);
    await write(path, slotInput(120), doctor, key).expect(409);
    expect(await audits('availability.created')).toBe(2);
  });
  it('prevents concurrent overlapping availability writes', async () => {
    const doctor = await account('doctor');
    const outcomes = await Promise.all(
      [0, 1].map(() => write(`/v1/doctors/${doctor.doctorId}/availability`, slotInput(), doctor)),
    );
    expect(outcomes.map((value) => value.status).sort()).toEqual([201, 409]);
    expect(await audits('availability.created')).toBe(1);
  });
  it('requires MFA and doctor ownership and rejects mass assignment', async () => {
    const doctor = await account('doctor');
    const other = await account('doctor');
    const patient = await account();
    const target = await slot(doctor);
    const path = `/v1/doctors/${doctor.doctorId}/availability`;
    await write(path, slotInput(120), other).expect(403);
    await write(path, slotInput(120), patient).expect(403);
    await write(path, slotInput(120)).expect(401);
    await write(`${path}/${target.id}/block`, {}, other, randomUUID(), 'patch').expect(403);
    await write(path, { ...slotInput(120), doctorId: other.doctorId }, doctor).expect(400);
    const challenge = await tokens.challenge(
      { userId: doctor.actor.userId, flowId: randomUUID(), authVersion: 1, purpose: 'verify' },
      new Date(clock.now().getTime() + 60000),
    );
    await write(path, slotInput(120), { ...doctor, token: challenge }).expect(401);
  });
  it('blocks only unoccupied future owned slots and hides them from patient listing', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const target = await slot(doctor);
    const path = `/v1/doctors/${doctor.doctorId}/availability`;
    const key = randomUUID();
    const blocked = await write(`${path}/${target.id}/block`, {}, doctor, key, 'patch').expect(200);
    expect(
      (await write(`${path}/${target.id}/block`, {}, doctor, key, 'patch').expect(200)).body,
    ).toEqual(blocked.body);
    await write(`${path}/${target.id}/block`, {}, doctor, randomUUID(), 'patch').expect(200);
    expect(await audits('availability.blocked')).toBe(1);
    expect(slotPageSchema.parse((await get(path, patient).expect(200)).body).items).toHaveLength(0);
    expect(slotPageSchema.parse((await get(path, doctor).expect(200)).body).items).toHaveLength(1);
    await write('/v1/consultations', { slotId: target.id }, patient).expect(409);
    const occupied = await slot(doctor, 120);
    await book(patient, occupied.id);
    await write(`${path}/${occupied.id}/block`, {}, doctor, randomUUID(), 'patch').expect(409);
  });
  it('rejects direct database booking into blocked slots', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const target = await slot(doctor);
    await write(
      `/v1/doctors/${doctor.doctorId}/availability/${target.id}/block`,
      {},
      doctor,
      randomUUID(),
      'patch',
    ).expect(200);
    await expect(
      pool.query('INSERT INTO consultations(slot_id,doctor_id,patient_id) VALUES($1,$2,$3)', [
        target.id,
        doctor.doctorId,
        patient.actor.userId,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rejects malformed, past and reversed times and invalid timezones', async () => {
    const doctor = await account('doctor');
    const path = `/v1/doctors/${doctor.doctorId}/availability`;
    await write(path, slotInput(-60), doctor).expect(409);
    for (const body of [
      { ...slotInput(), startsAt: '2027-03-14T02:30:00' },
      { ...slotInput(), endsAt: slotInput().startsAt },
      { ...slotInput(), timeZone: 'Invalid/Zone' },
    ])
      await write(path, body, doctor).expect(400);
    await get(`${path}?from=bad`, doctor).expect(400);
    await get(`${path}?limit=0`, doctor).expect(400);
  });
  it('normalizes explicit offsets across DST and paginates slots stably', async () => {
    const doctor = await account('doctor');
    const path = `/v1/doctors/${doctor.doctorId}/availability`;
    for (const hour of ['01:30:00-04:00', '01:30:00-05:00']) {
      const startsAt = `2035-11-04T${hour}`;
      const endsAt = new Date(new Date(startsAt).getTime() + 1800000).toISOString();
      const value = slotDtoSchema.parse(
        (await write(path, { startsAt, endsAt, timeZone: 'America/New_York' }, doctor).expect(201))
          .body,
      );
      expect(value.startsAt).toBe(new Date(startsAt).toISOString());
    }
    const first = slotPageSchema.parse((await get(`${path}?limit=1`, doctor).expect(200)).body);
    const next = slotPageSchema.parse(
      (await get(`${path}?limit=1&offset=1`, doctor).expect(200)).body,
    );
    expect(first.hasMore).toBe(true);
    expect(next.hasMore).toBe(false);
    expect(first.items[0]?.id).not.toBe(next.items[0]?.id);
  });
});

describe('booking, idempotency and cancellation concurrency', () => {
  it('allows exactly one success from 100 simultaneous distinct-patient booking attempts', async () => {
    const doctor = await account('doctor');
    const target = await slot(doctor);
    const patients = await Promise.all(Array.from({ length: 100 }, () => account()));
    const responses = await Promise.all(
      patients.map((patient) => write('/v1/consultations', { slotId: target.id }, patient)),
    );
    expect(responses.filter((value) => value.status === 201)).toHaveLength(1);
    expect(responses.filter((value) => value.status === 409)).toHaveLength(99);
    expect(await count('consultations')).toBe(1);
    expect(await events('consultation.booked')).toBe(1);
    expect(await audits('consultation.booked')).toBe(1);
  }, 30000);
  it('replays 100 identical simultaneous retries with one consultation, audit and logical outbox event', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const target = await slot(doctor);
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 100 }, () =>
        write('/v1/consultations', { slotId: target.id }, patient, key),
      ),
    );
    expect(responses.every((value) => value.status === 201)).toBe(true);
    expect(new Set(responses.map((value) => JSON.stringify(value.body))).size).toBe(1);
    expect(await count('consultations')).toBe(1);
    expect(await events('consultation.booked')).toBe(1);
    expect(await audits('consultation.booked')).toBe(1);
    expect(await count('idempotency_records', "scope LIKE 'consultation-book:%'")).toBe(1);
  }, 30000);
  it('recovers a lost response across API restart and rejects a changed booking payload', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const firstSlot = await slot(doctor);
    const secondSlot = await slot(doctor, 120);
    const key = randomUUID();
    const expected = await book(patient, firstSlot.id, key);
    const restarted = composeApi(config, createLogger('silent'), security, clock);
    await restarted.connect();
    try {
      const response = await request(restarted.app)
        .post('/v1/consultations')
        .set('Authorization', `Bearer ${patient.token}`)
        .set('Idempotency-Key', key)
        .send({ slotId: firstSlot.id })
        .expect(201);
      expect(response.body).toEqual(expected);
    } finally {
      await restarted.close();
    }
    await write('/v1/consultations', { slotId: secondSlot.id }, patient, key).expect(409);
    expect(await count('consultations')).toBe(1);
  });
  it('enforces role, token identity, active doctor and non-past slot policies', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const other = await account();
    const admin = await account('admin');
    const target = await slot(doctor);
    await write('/v1/consultations', { slotId: target.id }, doctor).expect(403);
    await write('/v1/consultations', { slotId: target.id }, admin).expect(403);
    await write('/v1/consultations', { slotId: target.id }).expect(401);
    await write(
      '/v1/consultations',
      { slotId: target.id, patientId: other.actor.userId },
      patient,
    ).expect(400);
    await pool.query('UPDATE doctors SET active=false WHERE id=$1', [doctor.doctorId]);
    await write('/v1/consultations', { slotId: target.id }, patient).expect(409);
    await pool.query('UPDATE doctors SET active=true WHERE id=$1', [doctor.doctorId]);
    await pool.query(
      "UPDATE availability_slots SET starts_at=now()-interval '2 hours',ends_at=now()-interval '1 hour' WHERE id=$1",
      [target.id],
    );
    await write('/v1/consultations', { slotId: target.id }, patient).expect(409);
    await write('/v1/consultations', { slotId: randomUUID() }, patient).expect(404);
  });
  it('cancels and rebooks with one event per transition and original successful replay', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const target = await slot(doctor);
    const key = randomUUID();
    const original = await book(patient, target.id, key);
    const cancelKey = randomUUID();
    const path = `/v1/consultations/${original.id}/cancel`;
    const cancelled = await write(path, { reason: 'patient_request' }, patient, cancelKey).expect(
      200,
    );
    expect(consultationDtoSchema.parse(cancelled.body).version).toBe(2);
    expect(
      (await write(path, { reason: 'patient_request' }, patient, cancelKey).expect(200)).body,
    ).toEqual(cancelled.body);
    await write(path, { reason: 'patient_request' }, patient).expect(409);
    await write(path, { reason: 'administrative' }, patient, cancelKey).expect(403);
    const another = await book(patient, target.id);
    expect(another.id).not.toBe(original.id);
    expect(
      (await write('/v1/consultations', { slotId: target.id }, patient, key).expect(201)).body,
    ).toEqual(original);
    expect(await events('consultation.booked')).toBe(2);
    expect(await events('consultation.cancelled')).toBe(1);
    expect(await audits('consultation.cancelled')).toBe(1);
  });
  it('prevents cross-user/cross-doctor cancellation and permits assigned doctor and admin', async () => {
    const doctor = await account('doctor');
    const otherDoctor = await account('doctor');
    const patient = await account();
    const other = await account();
    const admin = await account('admin');
    const first = await book(patient, (await slot(doctor)).id);
    const path = `/v1/consultations/${first.id}/cancel`;
    await write(path, { reason: 'patient_request' }, other).expect(403);
    await write(path, { reason: 'doctor_unavailable' }, otherDoctor).expect(403);
    await write(path, { reason: 'doctor_unavailable' }, doctor).expect(200);
    const second = await book(patient, (await slot(doctor, 120)).id);
    await write(
      `/v1/consultations/${second.id}/cancel`,
      { reason: 'administrative' },
      admin,
    ).expect(200);
  });
  it('rejects changed cancellation payloads for a reused administrator key', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const admin = await account('admin');
    const original = await book(patient, (await slot(doctor)).id);
    const key = randomUUID();
    const path = `/v1/consultations/${original.id}/cancel`;
    await write(path, { reason: 'administrative' }, admin, key).expect(200);
    await write(path, { reason: 'doctor_unavailable' }, admin, key).expect(409);
  });
  it('rejects cancellation after start and for in-progress, completed and no-show states', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    for (const [index, state] of ['in_progress', 'completed', 'no_show'].entries()) {
      const item = await book(patient, (await slot(doctor, 120 + index * 60)).id);
      if (state !== 'no_show')
        await pool.query(
          "UPDATE consultations SET status='in_progress',started_at=now() WHERE id=$1",
          [item.id],
        );
      if (state === 'completed')
        await pool.query(
          "UPDATE consultations SET status='completed',completed_at=now() WHERE id=$1",
          [item.id],
        );
      if (state === 'no_show')
        await pool.query("UPDATE consultations SET status='no_show',no_show_at=now() WHERE id=$1", [
          item.id,
        ]);
      await write(
        `/v1/consultations/${item.id}/cancel`,
        { reason: 'patient_request' },
        patient,
      ).expect(409);
    }
    const original = await book(patient, (await slot(doctor)).id);
    const path = `/v1/consultations/${original.id}/cancel`;
    clock.advance(3600);
    await write(path, { reason: 'patient_request' }, patient).expect(401); // JWT is expired, not a way around time validation.
    const refreshed = {
      ...patient,
      token: await tokens.access(patient.actor, new Date(clock.now().getTime() + 300000)),
    };
    await write(path, { reason: 'patient_request' }, refreshed).expect(409);
  });
  it('serializes cancellation and rebooking races without double occupancy', async () => {
    const doctor = await account('doctor');
    const owner = await account();
    const first = await account();
    const second = await account();
    for (let run = 0; run < 5; run += 1) {
      const target = await slot(doctor, 60 + run * 60);
      const original = await book(owner, target.id);
      const responses = await Promise.all([
        write(`/v1/consultations/${original.id}/cancel`, { reason: 'patient_request' }, owner),
        write('/v1/consultations', { slotId: target.id }, first),
        write('/v1/consultations', { slotId: target.id }, second),
      ]);
      expect(responses[0]?.status).toBe(200);
      expect(responses.slice(1).every((value) => [201, 409].includes(value.status))).toBe(true);
      const active = Number(
        (
          await pool.query<{ count: string }>(
            "SELECT count(*) FROM consultations WHERE slot_id=$1 AND status <> 'cancelled'",
            [target.id],
          )
        ).rows[0]?.count,
      );
      expect(active).toBeLessThanOrEqual(1);
      if (active === 0) await book(first, target.id);
    }
  });
  it('serializes blocking and booking races', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const target = await slot(doctor);
    const outcomes = await Promise.all([
      write(
        `/v1/doctors/${doctor.doctorId}/availability/${target.id}/block`,
        {},
        doctor,
        randomUUID(),
        'patch',
      ),
      write('/v1/consultations', { slotId: target.id }, patient),
    ]);
    const state = (
      await pool.query<{ status: string }>('SELECT status FROM availability_slots WHERE id=$1', [
        target.id,
      ])
    ).rows[0]?.status;
    if (state === 'blocked') {
      expect(outcomes[0]?.status).toBe(200);
      expect(outcomes[1]?.status).toBe(409);
      expect(await count('consultations')).toBe(0);
    } else {
      expect(outcomes[0]?.status).toBe(409);
      expect(outcomes[1]?.status).toBe(201);
      expect(await count('consultations')).toBe(1);
    }
  });
  it('replays 100 identical concurrent cancellations with one logical cancellation event', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const original = await book(patient, (await slot(doctor)).id);
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        write(
          `/v1/consultations/${original.id}/cancel`,
          { reason: 'patient_request' },
          patient,
          key,
        ),
      ),
    );
    expect(results.every((value) => value.status === 200)).toBe(true);
    expect(new Set(results.map((value) => JSON.stringify(value.body))).size).toBe(1);
    expect(await events('consultation.cancelled')).toBe(1);
    expect(await audits('consultation.cancelled')).toBe(1);
    expect(await count('consultations', "status='cancelled'")).toBe(1);
  }, 30000);
  it('does not recreate a booking when its idempotency record has expired', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const target = await slot(doctor);
    const key = randomUUID();
    await book(patient, target.id, key);
    await pool.query(
      "UPDATE idempotency_records SET expires_at=created_at+interval '1 second' WHERE scope=$1 AND key=$2",
      [`consultation-book:${patient.actor.userId}`, key],
    );
    clock.advance(2);
    await write('/v1/consultations', { slotId: target.id }, patient, key).expect(409);
    expect(await count('consultations')).toBe(1);
    expect(await events('consultation.booked')).toBe(1);
  });
  it('denies successful idempotency replay after session revocation', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const target = await slot(doctor);
    const key = randomUUID();
    await book(patient, target.id, key);
    await pool.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1', [
      patient.actor.sessionId,
    ]);
    await write('/v1/consultations', { slotId: target.id }, patient, key).expect(401);
    expect(await count('consultations')).toBe(1);
  });
});

describe('atomic failure recovery', () => {
  it.each(['audit_logs', 'outbox_jobs', 'idempotency_records'] as const)(
    'rolls booking back if %s persistence fails and permits same-key recovery',
    async (table) => {
      const doctor = await account('doctor');
      const patient = await account();
      const target = await slot(doctor);
      const key = randomUUID();
      const condition =
        table === 'audit_logs'
          ? "NEW.action='consultation.booked'"
          : table === 'outbox_jobs'
            ? "NEW.kind='consultation.booked'"
            : "NEW.scope LIKE 'consultation-book:%' AND NEW.status='completed'";
      await injectFailure(table, condition);
      await write('/v1/consultations', { slotId: target.id }, patient, key).expect(500);
      expect(await count('consultations')).toBe(0);
      expect(await events('consultation.booked')).toBe(0);
      expect(await audits('consultation.booked')).toBe(0);
      expect(await count('idempotency_records', "scope LIKE 'consultation-book:%'")).toBe(0);
      await clearFailure();
      await book(patient, target.id, key);
      expect(await events('consultation.booked')).toBe(1);
    },
  );
  it.each(['audit_logs', 'outbox_jobs', 'idempotency_records'] as const)(
    'rolls cancellation back if %s persistence fails and permits same-key recovery',
    async (table) => {
      const doctor = await account('doctor');
      const patient = await account();
      const original = await book(patient, (await slot(doctor)).id);
      const key = randomUUID();
      const path = `/v1/consultations/${original.id}/cancel`;
      const condition =
        table === 'audit_logs'
          ? "NEW.action='consultation.cancelled'"
          : table === 'outbox_jobs'
            ? "NEW.kind='consultation.cancelled'"
            : "NEW.scope LIKE 'consultation-cancel:%' AND NEW.status='completed'";
      await injectFailure(table, condition);
      await write(path, { reason: 'patient_request' }, patient, key).expect(500);
      expect(await count('consultations', "status='scheduled'")).toBe(1);
      expect(await events('consultation.cancelled')).toBe(0);
      expect(await audits('consultation.cancelled')).toBe(0);
      expect(await count('idempotency_records', "scope LIKE 'consultation-cancel:%'")).toBe(0);
      await clearFailure();
      await write(path, { reason: 'patient_request' }, patient, key).expect(200);
      expect(await events('consultation.cancelled')).toBe(1);
    },
  );
  it('rolls blocking back when audit persistence fails', async () => {
    const doctor = await account('doctor');
    const target = await slot(doctor);
    const key = randomUUID();
    const path = `/v1/doctors/${doctor.doctorId}/availability/${target.id}/block`;
    await injectFailure('audit_logs', "NEW.action='availability.blocked'");
    await write(path, {}, doctor, key, 'patch').expect(500);
    expect(
      (
        await pool.query<{ status: string }>('SELECT status FROM availability_slots WHERE id=$1', [
          target.id,
        ])
      ).rows[0]?.status,
    ).toBe('open');
    expect(await audits('availability.blocked')).toBe(0);
    await clearFailure();
    await write(path, {}, doctor, key, 'patch').expect(200);
  });
  it('rolls availability creation back when audit persistence fails', async () => {
    const doctor = await account('doctor');
    await injectFailure('audit_logs', "NEW.action='availability.created'");
    const key = randomUUID();
    const path = `/v1/doctors/${doctor.doctorId}/availability`;
    await write(path, slotInput(), doctor, key).expect(500);
    expect(slotPageSchema.parse((await get(path, doctor).expect(200)).body).items).toHaveLength(0);
    await clearFailure();
    await write(path, slotInput(), doctor, key).expect(201);
  });
});

describe('doctor discovery and Redis resilience', () => {
  it('filters name/specialty literally and paginates deterministically without private fields', async () => {
    const patient = await account();
    await account('doctor', 'Alice Ayurveda', 'Ayurveda');
    await account('doctor', 'Bob Ayurveda', 'Ayurveda');
    await account('doctor', 'Alice Skin', 'Dermatology');
    const first = doctorPageSchema.parse(
      (await get('/v1/doctors?specialty=AYURVEDA&limit=1', patient).expect(200)).body,
    );
    const second = doctorPageSchema.parse(
      (await get('/v1/doctors?specialty=ayurveda&limit=1&offset=1', patient).expect(200)).body,
    );
    expect(first.items[0]?.name).toBe('Alice Ayurveda');
    expect(first.hasMore).toBe(true);
    expect(second.items[0]?.name).toBe('Bob Ayurveda');
    expect(second.hasMore).toBe(false);
    expect(
      doctorPageSchema.parse(
        (await get('/v1/doctors?name=alice&specialty=ayurveda', patient).expect(200)).body,
      ).items,
    ).toHaveLength(1);
    expect(
      doctorPageSchema.parse((await get('/v1/doctors?name=%25', patient).expect(200)).body).items,
    ).toHaveLength(0);
    expect(Object.keys(first.items[0]!).sort()).toEqual(['biography', 'id', 'name', 'specialty']);
    await get('/v1/doctors', undefined).expect(401);
  });
  it('bypasses cache for availability and immediately reflects booking, cancellation and blocking', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const target = await slot(doctor);
    const range = new URLSearchParams({
      availableFrom: target.startsAt,
      availableTo: target.endsAt,
    }).toString();
    const path = `/v1/doctors?${range}`;
    expect(doctorPageSchema.parse((await get(path, patient).expect(200)).body).items).toHaveLength(
      1,
    );
    const consultation = await book(patient, target.id);
    expect(doctorPageSchema.parse((await get(path, patient).expect(200)).body).items).toHaveLength(
      0,
    );
    await write(
      `/v1/consultations/${consultation.id}/cancel`,
      { reason: 'patient_request' },
      patient,
    ).expect(200);
    expect(doctorPageSchema.parse((await get(path, patient).expect(200)).body).items).toHaveLength(
      1,
    );
    await write(
      `/v1/doctors/${doctor.doctorId}/availability/${target.id}/block`,
      {},
      doctor,
      randomUUID(),
      'patch',
    ).expect(200);
    expect(doctorPageSchema.parse((await get(path, patient).expect(200)).body).items).toHaveLength(
      0,
    );
  });
  it('invalidates cached public directory results on doctor edits and account disable', async () => {
    const doctor = await account('doctor', 'Initial Name');
    const patient = await account();
    expect(
      doctorPageSchema.parse((await get('/v1/doctors', patient).expect(200)).body).items[0]?.name,
    ).toBe('Initial Name');
    expect((await redis.keys('directory:v1:*')).length).toBeGreaterThan(0);
    await pool.query('UPDATE doctors SET public_name=$2 WHERE id=$1', [
      doctor.doctorId,
      'Updated Name',
    ]);
    expect(
      doctorPageSchema.parse((await get('/v1/doctors', patient).expect(200)).body).items[0]?.name,
    ).toBe('Updated Name');
    await pool.query("UPDATE users SET status='disabled' WHERE id=$1", [doctor.actor.userId]);
    expect(
      doctorPageSchema.parse((await get('/v1/doctors', patient).expect(200)).body).items,
    ).toHaveLength(0);
  });
  it('falls back on unavailable/corrupt cache and does not resurrect stale generations after recovery', async () => {
    const doctor = await account('doctor', 'Before Outage');
    const patient = await account();
    await get('/v1/doctors', patient).expect(200);
    const closedCache = createClient({ url: redisUrl });
    await closedCache.connect();
    await closedCache.close();
    const failing = new DiscoveryService(
      core.work,
      core.authorization,
      new DirectoryRepository(database),
      new RedisDirectoryCache(closedCache),
      clock,
      createLogger('silent'),
    );
    await pool.query('UPDATE doctors SET public_name=$2 WHERE id=$1', [
      doctor.doctorId,
      'During Outage',
    ]);
    expect(
      (await failing.search(patient.actor, discoveryQuerySchema.parse({}))).items[0]?.name,
    ).toBe('During Outage');
    expect(
      doctorPageSchema.parse((await get('/v1/doctors', patient).expect(200)).body).items[0]?.name,
    ).toBe('During Outage');
    for (const key of await redis.keys('directory:v1:*')) await redis.set(key, '{broken-json');
    expect(
      doctorPageSchema.parse((await get('/v1/doctors', patient).expect(200)).body).items[0]?.name,
    ).toBe('During Outage');
  });
  it('rejects malformed range, unsupported filters and unbounded pagination', async () => {
    const patient = await account();
    for (const query of [
      'limit=101',
      'offset=10001',
      'limit=1.5',
      'name=x&name=y',
      'patientId=bad',
      'availableFrom=2035-01-01T00%3A00%3A00Z',
      'availableFrom=2035-02-01T00%3A00%3A00Z&availableTo=2035-01-01T00%3A00%3A00Z',
    ])
      await get(`/v1/doctors?${query}`, patient).expect(400);
  });
  it('does not expose patient data or cancellation reasons in side-effect payloads/audit', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const consultation = await book(patient, (await slot(doctor)).id);
    await write(
      `/v1/consultations/${consultation.id}/cancel`,
      { reason: 'patient_request' },
      patient,
    ).expect(200);
    const jobs = (await pool.query<{ payload: unknown }>('SELECT payload FROM outbox_jobs')).rows;
    for (const job of jobs) expect(job.payload).toEqual({ consultationId: consultation.id });
    const audit = (
      await pool.query<{ metadata: unknown }>(
        "SELECT metadata FROM audit_logs WHERE action LIKE 'consultation.%'",
      )
    ).rows;
    expect(audit.every((row) => JSON.stringify(row.metadata) === '{}')).toBe(true);
  });
  it('enforces the existing authorization check when a service is called outside HTTP', async () => {
    const doctor = await account('doctor');
    const patient = await account();
    const target = await slot(doctor);
    await expect(
      booking.bookings.book(doctor.actor, target.id, randomUUID(), { requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 403 });
    await pool.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [
      patient.actor.userId,
    ]);
    await expect(
      booking.bookings.book(patient.actor, target.id, randomUUID(), { requestId: randomUUID() }),
    ).rejects.toMatchObject({ status: 401 });
  });
});
