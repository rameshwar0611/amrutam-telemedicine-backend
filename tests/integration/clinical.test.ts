import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect } from 'vitest';
import { z } from 'zod';
import { phase4Harness, notes, content } from '../helpers/phase4.js';
import { consultationDtoSchema } from '../../src/modules/bookings/schemas.js';
import { notesDtoSchema, noteSavedSchema } from '../../src/modules/consultations/schemas.js';
import { prescriptionDtoSchema } from '../../src/modules/prescriptions/schemas.js';
import { paymentDtoSchema } from '../../src/modules/payments/schemas.js';
import { analyticsDtoSchema } from '../../src/infrastructure/openapi/clinical.js';
const h = phase4Harness();
beforeAll(h.setup);
beforeEach(h.reset);
afterAll(h.close);
afterEach(async () => {
  for (const t of ['audit_logs', 'outbox_jobs', 'idempotency_records'])
    await h.pool.query(`DROP TRIGGER IF EXISTS phase4_failure ON ${t}`);
  await h.pool.query('DROP FUNCTION IF EXISTS phase4_failure()');
});
async function fixture(start = -1) {
  const doctor = await h.account('doctor');
  const patient = await h.account();
  const id = await h.consultation(doctor, patient, start);
  return { doctor, patient, id };
}
async function start() {
  const f = await fixture();
  await h
    .write(`/v1/consultations/${f.id}/transitions`, { status: 'in_progress' }, f.doctor)
    .expect(200);
  return f;
}
async function draft() {
  const f = await start();
  const rx = prescriptionDtoSchema.parse(
    (await h.write(`/v1/consultations/${f.id}/prescriptions`, { content }, f.doctor).expect(201))
      .body,
  );
  return { ...f, rx };
}
async function payment(
  f: Awaited<ReturnType<typeof fixture>>,
  status: 'pending' | 'authorized' | 'paid' = 'pending',
) {
  const admin = await h.account('admin');
  let p = paymentDtoSchema.parse(
    (
      await h
        .write(`/v1/consultations/${f.id}/payments`, { amountMinor: 12500, currency: 'INR' }, admin)
        .expect(201)
    ).body,
  );
  for (const s of status === 'paid'
    ? ['authorized', 'paid']
    : status === 'authorized'
      ? ['authorized']
      : [])
    p = paymentDtoSchema.parse(
      (await h.write(`/v1/payments/${p.id}/transitions`, { status: s }, admin).expect(200)).body,
    );
  return { admin, p };
}
async function fault(
  table: 'audit_logs' | 'outbox_jobs' | 'idempotency_records',
  condition: string,
) {
  await h.pool.query(
    `CREATE FUNCTION phase4_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'Injected failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER phase4_failure BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION phase4_failure()`,
  );
}

describe('consultation lifecycle and clinical encryption', () => {
  it('starts, writes encrypted notes, completes, and audits authorized patient access', async () => {
    const f = await start();
    const row = consultationDtoSchema.parse(
      (await h.get(`/v1/consultations/${f.id}`, f.patient).expect(200)).body,
    );
    const saved = noteSavedSchema.parse(
      (
        await h
          .write(
            `/v1/consultations/${f.id}/notes`,
            { expectedVersion: row.version, notes },
            f.doctor,
            randomUUID(),
            'put',
          )
          .expect(200)
      ).body,
    );
    expect(saved.version).toBe(row.version + 1);
    const ciphertext = (
      await h.pool.query<{ clinical_notes: unknown }>(
        'SELECT clinical_notes FROM consultations WHERE id=$1',
        [f.id],
      )
    ).rows[0]?.clinical_notes;
    expect(JSON.stringify(ciphertext)).not.toContain(notes.summary);
    await h.get(`/v1/consultations/${f.id}/notes`, f.patient).expect(403);
    expect(
      notesDtoSchema.parse(
        (await h.get(`/v1/consultations/${f.id}/notes`, f.doctor).expect(200)).body,
      ).notes,
    ).toEqual(notes);
    const completed = await h
      .write(`/v1/consultations/${f.id}/transitions`, { status: 'completed' }, f.doctor)
      .expect(200);
    expect(consultationDtoSchema.parse(completed.body).status).toBe('completed');
    expect(
      notesDtoSchema.parse(
        (await h.get(`/v1/consultations/${f.id}/notes`, f.patient).expect(200)).body,
      ).notes,
    ).toEqual(notes);
    await h
      .write(
        `/v1/consultations/${f.id}/notes`,
        { expectedVersion: saved.version, notes },
        f.doctor,
        randomUUID(),
        'put',
      )
      .expect(409);
    await expect(
      h.pool.query('UPDATE consultations SET clinical_notes=$2 WHERE id=$1', [
        f.id,
        ciphertext
          ? { ...z.record(z.string(), z.unknown()).parse(ciphertext), ciphertext: 'overwrite' }
          : null,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('denies cross-patient/cross-doctor/admin clinical access and patient transitions', async () => {
    const f = await start();
    const other = await h.account();
    const doctor = await h.account('doctor');
    const admin = await h.account('admin');
    for (const actor of [other, doctor, admin]) {
      await h.get(`/v1/consultations/${f.id}/notes`, actor).expect(403);
      await h
        .write(`/v1/consultations/${f.id}/transitions`, { status: 'completed' }, actor)
        .expect(403);
    }
    await h
      .write(`/v1/consultations/${f.id}/transitions`, { status: 'completed' }, f.patient)
      .expect(403);
    await h.get(`/v1/consultations/${f.id}/notes`).expect(401);
  });
  it('enforces all transition and time boundaries including terminal immutability', async () => {
    const f = await fixture(60);
    await h
      .write(`/v1/consultations/${f.id}/transitions`, { status: 'in_progress' }, f.doctor)
      .expect(409);
    await h
      .write(`/v1/consultations/${f.id}/transitions`, { status: 'completed' }, f.doctor)
      .expect(409);
    await h
      .write(`/v1/consultations/${f.id}/transitions`, { status: 'no_show' }, f.doctor)
      .expect(409);
    const ended = await fixture(-60);
    await h
      .write(`/v1/consultations/${ended.id}/transitions`, { status: 'no_show' }, ended.doctor)
      .expect(200);
    await h
      .write(`/v1/consultations/${ended.id}/transitions`, { status: 'in_progress' }, ended.doctor)
      .expect(409);
    await expect(
      h.pool.query("UPDATE consultations SET status='scheduled',no_show_at=NULL WHERE id=$1", [
        ended.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
    const active = await start();
    await h
      .write(`/v1/consultations/${active.id}/transitions`, { status: 'no_show' }, active.doctor)
      .expect(409);
    await h
      .write(`/v1/consultations/${active.id}/transitions`, { status: 'completed' }, active.doctor)
      .expect(200);
    await h
      .write(`/v1/consultations/${active.id}/transitions`, { status: 'in_progress' }, active.doctor)
      .expect(409);
  });
  it('prevents concurrent note edits using expectedVersion and safely replays successful writes', async () => {
    const f = await start();
    const key = randomUUID();
    const body = { expectedVersion: 2, notes };
    const first = await h
      .write(`/v1/consultations/${f.id}/notes`, body, f.doctor, key, 'put')
      .expect(200);
    expect(
      (await h.write(`/v1/consultations/${f.id}/notes`, body, f.doctor, key, 'put').expect(200))
        .body,
    ).toEqual(first.body);
    await h
      .write(
        `/v1/consultations/${f.id}/notes`,
        { ...body, notes: { ...notes, plan: 'different' } },
        f.doctor,
        key,
        'put',
      )
      .expect(409);
    const results = await Promise.all(
      ['one', 'two'].map((plan) =>
        h.write(
          `/v1/consultations/${f.id}/notes`,
          { expectedVersion: 3, notes: { ...notes, plan } },
          f.doctor,
          randomUUID(),
          'put',
        ),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  it('rejects mass assignment and malformed clinical content', async () => {
    const f = await start();
    await h
      .write(
        `/v1/consultations/${f.id}/notes`,
        { expectedVersion: 2, notes: { ...notes, patientId: randomUUID() } },
        f.doctor,
        randomUUID(),
        'put',
      )
      .expect(400);
    await h
      .write(`/v1/consultations/${f.id}/transitions`, { status: 'cancelled' }, f.doctor)
      .expect(400);
  });
  it('binds encrypted clinical notes to their consultation so ciphertext swapping fails closed', async () => {
    const first = await start();
    const second = await start();
    await h
      .write(
        `/v1/consultations/${first.id}/notes`,
        { expectedVersion: 2, notes },
        first.doctor,
        randomUUID(),
        'put',
      )
      .expect(200);
    await h.pool.query(
      'UPDATE consultations SET clinical_notes=(SELECT clinical_notes FROM consultations WHERE id=$2) WHERE id=$1',
      [second.id, first.id],
    );
    const response = await h.get(`/v1/consultations/${second.id}/notes`, second.doctor).expect(500);
    expect(response.text).not.toContain(notes.summary);
  });
  it('does not return decrypted notes if access auditing fails', async () => {
    const f = await start();
    await fault('audit_logs', "NEW.action='clinical.notes_accessed'");
    const r = await h.get(`/v1/consultations/${f.id}/notes`, f.doctor).expect(500);
    expect(r.text).not.toContain(notes.summary);
  });
  it.each(['audit_logs', 'outbox_jobs', 'idempotency_records'] as const)(
    'rolls lifecycle changes back on %s failure',
    async (table) => {
      const f = await fixture();
      const condition =
        table === 'audit_logs'
          ? "NEW.action='consultation.in_progress'"
          : table === 'outbox_jobs'
            ? "NEW.kind='consultation.in_progress'"
            : "NEW.scope LIKE 'clinical-transition:%' AND NEW.status='completed'";
      await fault(table, condition);
      await h
        .write(`/v1/consultations/${f.id}/transitions`, { status: 'in_progress' }, f.doctor)
        .expect(500);
      expect(await h.count('consultations', "status='scheduled'")).toBe(1);
      expect(await h.count('outbox_jobs')).toBe(0);
    },
  );
});

describe('prescription authorship, versions and immutability', () => {
  it('creates, edits and finalizes drafts with replay and patient-safe visibility', async () => {
    const f = await draft();
    await h.get(`/v1/prescriptions/${f.rx.id}`, f.patient).expect(404);
    const changed = { ...content, instructions: 'Updated private instruction' };
    await h
      .write(
        `/v1/prescriptions/${f.rx.id}`,
        { expectedRevision: 1, content: changed },
        f.doctor,
        randomUUID(),
        'patch',
      )
      .expect(200);
    await h
      .write(
        `/v1/prescriptions/${f.rx.id}`,
        { expectedRevision: 1, content },
        f.doctor,
        randomUUID(),
        'patch',
      )
      .expect(409);
    const key = randomUUID();
    const final = await h
      .write(`/v1/prescriptions/${f.rx.id}/finalize`, {}, f.doctor, key)
      .expect(200);
    expect(
      (await h.write(`/v1/prescriptions/${f.rx.id}/finalize`, {}, f.doctor, key).expect(200)).body,
    ).toEqual(final.body);
    expect(
      prescriptionDtoSchema.parse(
        (await h.get(`/v1/prescriptions/${f.rx.id}`, f.patient).expect(200)).body,
      ).content,
    ).toEqual(changed);
    await h
      .write(
        `/v1/prescriptions/${f.rx.id}`,
        { expectedRevision: 2, content },
        f.doctor,
        randomUUID(),
        'patch',
      )
      .expect(409);
  });
  it('creates linked correction versions and preserves immutable predecessor contents', async () => {
    const f = await draft();
    await h.write(`/v1/prescriptions/${f.rx.id}/finalize`, {}, f.doctor).expect(200);
    await h.write(`/v1/consultations/${f.id}/prescriptions`, { content }, f.doctor).expect(409);
    const next = prescriptionDtoSchema.parse(
      (
        await h
          .write(
            `/v1/consultations/${f.id}/prescriptions`,
            { content: { ...content, instructions: 'Corrected' }, correctionOf: f.rx.id },
            f.doctor,
          )
          .expect(201)
      ).body,
    );
    expect(next.version).toBe(2);
    await h.write(`/v1/prescriptions/${next.id}/finalize`, {}, f.doctor).expect(200);
    await h.get(`/v1/prescriptions/${f.rx.id}`, f.patient).expect(404);
    const previous = prescriptionDtoSchema.parse(
      (await h.get(`/v1/prescriptions/${f.rx.id}`, f.doctor).expect(200)).body,
    );
    expect(previous.status).toBe('revoked');
    expect(previous.content).toEqual(content);
    expect(await h.count('prescriptions', "status='finalized'")).toBe(1);
  });
  it('denies cross-user/doctor/admin retrieval, editing and correction links', async () => {
    const f = await draft();
    const other = await h.account('doctor');
    const patient = await h.account();
    const admin = await h.account('admin');
    for (const actor of [other, patient, admin])
      await h.get(`/v1/prescriptions/${f.rx.id}`, actor).expect(403);
    await h
      .write(
        `/v1/prescriptions/${f.rx.id}`,
        { expectedRevision: 1, content },
        other,
        randomUUID(),
        'patch',
      )
      .expect(403);
    await h
      .write(
        `/v1/consultations/${f.id}/prescriptions`,
        { content, correctionOf: randomUUID() },
        f.doctor,
      )
      .expect(409);
  });
  it('serializes simultaneous version creation and conflicting finalization', async () => {
    const f = await start();
    const results = await Promise.all(
      [0, 1].map(() => h.write(`/v1/consultations/${f.id}/prescriptions`, { content }, f.doctor)),
    );
    const drafts = results.map((r) => prescriptionDtoSchema.parse(r.body));
    expect(drafts.map((r) => r.version).sort()).toEqual([1, 2]);
    const final = await Promise.all(
      drafts.map((r) => h.write(`/v1/prescriptions/${r.id}/finalize`, {}, f.doctor)),
    );
    expect(final.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await h.count('prescriptions', "status='finalized'")).toBe(1);
  });
  it('revokes finalized contents with a coded reason and hides them from patient history', async () => {
    const f = await draft();
    await h.write(`/v1/prescriptions/${f.rx.id}/finalize`, {}, f.doctor).expect(200);
    await h
      .write(`/v1/prescriptions/${f.rx.id}/revoke`, { reason: 'issued_in_error' }, f.doctor)
      .expect(200);
    const body = z
      .object({ items: z.array(prescriptionDtoSchema) })
      .parse((await h.get(`/v1/consultations/${f.id}/prescriptions`, f.patient).expect(200)).body);
    expect(body.items).toHaveLength(0);
    await expect(
      h.pool.query('UPDATE prescriptions SET clinical_payload=$2 WHERE id=$1', [
        f.rx.id,
        { ciphertext: 'new', iv: 'iv', tag: 'tag', key_version: 'v' },
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('rolls correction revocation and finalization back together when outbox fails', async () => {
    const f = await draft();
    await h.write(`/v1/prescriptions/${f.rx.id}/finalize`, {}, f.doctor).expect(200);
    const next = prescriptionDtoSchema.parse(
      (
        await h
          .write(
            `/v1/consultations/${f.id}/prescriptions`,
            { content, correctionOf: f.rx.id },
            f.doctor,
          )
          .expect(201)
      ).body,
    );
    await fault('outbox_jobs', "NEW.kind='prescription.finalized'");
    await h.write(`/v1/prescriptions/${next.id}/finalize`, {}, f.doctor).expect(500);
    expect(
      (
        await h.pool.query<{ status: string }>('SELECT status FROM prescriptions WHERE id=$1', [
          f.rx.id,
        ])
      ).rows[0]?.status,
    ).toBe('finalized');
    expect(
      (
        await h.pool.query<{ status: string }>('SELECT status FROM prescriptions WHERE id=$1', [
          next.id,
        ])
      ).rows[0]?.status,
    ).toBe('draft');
  });
  it('keeps clinical plaintext out of ciphertext, audit metadata, retry records and directory caches', async () => {
    const f = await draft();
    await h
      .write(
        `/v1/consultations/${f.id}/notes`,
        { expectedVersion: 2, notes },
        f.doctor,
        randomUUID(),
        'put',
      )
      .expect(200);
    const persisted = (
      await h.pool.query<{ value: unknown }>(
        'SELECT clinical_payload AS value FROM prescriptions UNION ALL SELECT metadata FROM audit_logs UNION ALL SELECT response_body FROM idempotency_records UNION ALL SELECT payload FROM outbox_jobs',
      )
    ).rows;
    for (const row of persisted) {
      expect(JSON.stringify(row)).not.toContain(notes.summary);
      expect(JSON.stringify(row)).not.toContain(content.instructions);
    }
    await h.get('/v1/doctors', f.patient).expect(200);
    for (const key of await h.redis.keys('directory:*')) {
      const value = await h.redis.get(key);
      expect(value).not.toContain(notes.summary);
      expect(value).not.toContain(content.instructions);
    }
  });
});

describe('internal payments and compensation', () => {
  it('enforces payment state graph and never requires payment before booking', async () => {
    const f = await fixture(60);
    expect(await h.count('payments')).toBe(0);
    const { admin, p } = await payment(f);
    await h.write(`/v1/payments/${p.id}/transitions`, { status: 'paid' }, admin).expect(409);
    await h.write(`/v1/payments/${p.id}/transitions`, { status: 'authorized' }, admin).expect(200);
    await h.write(`/v1/payments/${p.id}/transitions`, { status: 'paid' }, admin).expect(200);
    await h.write(`/v1/payments/${p.id}/transitions`, { status: 'cancelled' }, admin).expect(409);
    await h.write(`/v1/payments/${p.id}/transitions`, { status: 'refunded' }, admin).expect(400);
    await h
      .write(`/v1/payments/${p.id}/transitions`, { status: 'refund_pending' }, admin)
      .expect(200);
    await h.drain();
    expect(await h.count('payments', "status='refunded'")).toBe(1);
  });
  it.each(['pending', 'authorized', 'paid'] as const)(
    'compensates %s payment after cancellation through the durable worker',
    async (state) => {
      const f = await fixture(60);
      await payment(f, state);
      await h
        .write(`/v1/consultations/${f.id}/cancel`, { reason: 'patient_request' }, f.patient)
        .expect(200);
      await h.drain();
      expect(
        await h.count('payments', `status='${state === 'paid' ? 'refunded' : 'cancelled'}'`),
      ).toBe(1);
    },
  );
  it('compensates no-show and prevents capture after cancellation/no-show', async () => {
    const f = await fixture(-60);
    const { admin, p } = await payment(f, 'authorized');
    await h
      .write(`/v1/consultations/${f.id}/transitions`, { status: 'no_show' }, f.doctor)
      .expect(200);
    await h.write(`/v1/payments/${p.id}/transitions`, { status: 'paid' }, admin).expect(409);
    await h.drain();
    expect(await h.count('payments', "status='cancelled'")).toBe(1);
  });
  it('denies patient/doctor payment writes and cross-patient payment reads', async () => {
    const f = await fixture();
    const { p } = await payment(f);
    const other = await h.account();
    for (const actor of [f.patient, f.doctor])
      await h
        .write(`/v1/payments/${p.id}/transitions`, { status: 'authorized' }, actor)
        .expect(403);
    await h.get(`/v1/consultations/${f.id}/payments`, other).expect(403);
    await h.get(`/v1/consultations/${f.id}/payments`, f.patient).expect(200);
  });
  it('replays payment creation and rejects conflicting money amounts and stale admin MFA', async () => {
    const f = await fixture();
    const admin = await h.account('admin');
    const key = randomUUID();
    const path = `/v1/consultations/${f.id}/payments`;
    const input = { amountMinor: 100, currency: 'INR' };
    const first = await h.write(path, input, admin, key).expect(201);
    expect((await h.write(path, input, admin, key).expect(201)).body).toEqual(first.body);
    await h.write(path, { ...input, amountMinor: 101 }, admin, key).expect(409);
    h.clock.advance(301);
    await h.renew(admin);
    await h.write(path, input, admin).expect(403);
    expect(await h.count('payments')).toBe(1);
  });
  it('rolls payment changes back when audit persistence fails', async () => {
    const f = await fixture();
    const { admin, p } = await payment(f);
    await fault('audit_logs', "NEW.action='payment.state_changed'");
    await h.write(`/v1/payments/${p.id}/transitions`, { status: 'authorized' }, admin).expect(500);
    expect(await h.count('payments', "status='pending'")).toBe(1);
  });
});

describe('compliance audit and admin analytics', () => {
  it('restricts audit and analytics to recent-MFA admins with bounded filters', async () => {
    const patient = await h.account();
    const doctor = await h.account('doctor');
    for (const path of ['audit-logs', 'analytics', 'jobs'])
      for (const actor of [patient, doctor])
        await h.get(`/v1/admin/${path}?${h.range()}`, actor).expect(403);
    const admin = await h.account('admin');
    await h.get('/v1/admin/audit-logs?from=bad', admin).expect(400);
    await h
      .get('/v1/admin/analytics?from=2035-01-01T00:00:00Z&to=2036-01-01T00:00:00Z', admin)
      .expect(400);
    await h.get(`/v1/admin/audit-logs?${h.range()}&action=bad%27sql`, admin).expect(400);
  });
  it('audits sensitive audit queries and preserves append-only integrity with safe DTOs', async () => {
    const f = await start();
    await h.get(`/v1/consultations/${f.id}`, f.patient).expect(200);
    const admin = await h.account('admin');
    const path = `/v1/admin/audit-logs?${h.range()}&action=consultation.accessed&limit=1`;
    const result = z
      .object({
        items: z.array(z.object({ action: z.string(), actor_id: z.uuid(), resource_id: z.uuid() })),
        hasMore: z.boolean(),
      })
      .parse((await h.get(path, admin).expect(200)).body);
    expect(result.items[0]?.actor_id).toBe(f.patient.actor.userId);
    expect(await h.count('audit_logs', "action='admin.audit_accessed'")).toBe(1);
    const raw = await h.get(path, admin).expect(200);
    expect(raw.text).not.toContain('metadata');
    await expect(h.pool.query("UPDATE audit_logs SET action='changed'")).rejects.toMatchObject({
      code: '23514',
    });
  });
  it('calculates counts and utilization from a known fixture with an authoritative freshness timestamp', async () => {
    const admin = await h.account('admin');
    const doctor = await h.account('doctor');
    const patient = await h.account();
    for (const [index, state] of ['scheduled', 'completed', 'cancelled', 'no_show'].entries()) {
      const id = await h.consultation(doctor, patient, index * 60 - 180);
      if (state === 'completed') {
        await h.pool.query(
          "UPDATE consultations SET status='in_progress',started_at=now() WHERE id=$1",
          [id],
        );
        await h.pool.query(
          "UPDATE consultations SET status='completed',completed_at=now() WHERE id=$1",
          [id],
        );
      }
      if (state === 'cancelled')
        await h.pool.query(
          "UPDATE consultations SET status='cancelled',cancelled_at=now(),cancellation_reason='patient_request' WHERE id=$1",
          [id],
        );
      if (state === 'no_show')
        await h.pool.query(
          "UPDATE consultations SET status='no_show',no_show_at=now() WHERE id=$1",
          [id],
        );
    }
    const empty = await h.account('doctor');
    const result = analyticsDtoSchema.parse(
      (await h.get(`/v1/admin/analytics?${h.range()}`, admin).expect(200)).body,
    );
    expect(result.totals).toEqual({ bookings: 4, completed: 1, cancellations: 1, noShows: 1 });
    const utilization = result.doctors.find((row) => row.doctorId === doctor.doctorId);
    expect(utilization).toMatchObject({
      offeredSeconds: 7200,
      bookedSeconds: 5400,
      utilization: 0.75,
    });
    expect(result.doctors.find((row) => row.doctorId === empty.doctorId)?.offeredSeconds).toBe(0);
    expect(Number.isFinite(Date.parse(result.asOf))).toBe(true);
  });
  it('does not disclose audit data if mandatory access auditing fails', async () => {
    const admin = await h.account('admin');
    await fault('audit_logs', "NEW.action='admin.audit_accessed'");
    await h.get(`/v1/admin/audit-logs?${h.range()}`, admin).expect(500);
  });
});
