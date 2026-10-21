import { randomUUID } from 'node:crypto';
import { beforeAll, beforeEach, afterEach, afterAll, describe, it, expect, vi } from 'vitest';
import { phase4Harness } from '../helpers/phase4.js';
import { DeterministicFakeRefundAdapter } from '../../src/infrastructure/payments/fake-refund-adapter.js';
import { JobFailure } from '../../src/modules/jobs/domain/jobs.js';
import type { JsonValue } from '../../src/shared/json.js';
const h = phase4Harness();
beforeAll(h.setup);
beforeEach(h.reset);
afterAll(h.close);
afterEach(async () => {
  for (const table of ['audit_logs', 'outbox_jobs', 'job_receipts'])
    await h.pool.query(`DROP TRIGGER IF EXISTS worker_failure ON ${table}`);
  await h.pool.query('DROP FUNCTION IF EXISTS worker_failure()');
});
async function enqueue(kind: string, payload: JsonValue, max = 3) {
  return (
    await h.pool.query<{ id: string }>(
      'INSERT INTO outbox_jobs(kind,deduplication_key,payload,max_attempts,available_at) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [kind, randomUUID(), payload, max, h.clock.now()],
    )
  ).rows[0]!.id;
}
async function refund() {
  const doctor = await h.account('doctor');
  const patient = await h.account();
  const id = await h.consultation(doctor, patient, 60);
  const payment = (
    await h.pool.query<{ id: string }>(
      "INSERT INTO payments(consultation_id,amount_minor,currency,status) VALUES($1,12500,'INR','paid') RETURNING id",
      [id],
    )
  ).rows[0]!.id;
  await h.pool.query("UPDATE payments SET status='refund_pending' WHERE id=$1", [payment]);
  const job = await enqueue('payment.refund_requested', { paymentId: payment }, 3);
  return { id, payment, job, doctor, patient };
}
async function state(id: string) {
  return (
    await h.pool.query<{
      status: string;
      attempts: number;
      last_error_code: string | null;
      available_at: Date;
    }>('SELECT status,attempts,last_error_code,available_at FROM outbox_jobs WHERE id=$1', [id])
  ).rows[0]!;
}

describe('durable outbox leasing, fencing and duplicate handling', () => {
  it('leases one job per worker concurrently with SKIP LOCKED', async () => {
    const first = await enqueue('consultation.booked', { consultationId: randomUUID() });
    const second = await enqueue('consultation.booked', { consultationId: randomUUID() });
    const jobs = await Promise.all([
      h.jobs.lease(h.clock.now(), 30000),
      h.jobs.lease(h.clock.now(), 30000),
    ]);
    expect(new Set(jobs.map((j) => j?.id))).toEqual(new Set([first, second]));
    expect(jobs.every((j) => j?.attempts === 1)).toBe(true);
  });
  it('recovers an expired lease after crash and fences the stale owner', async () => {
    const id = await enqueue('consultation.booked', { consultationId: randomUUID() });
    const old = (await h.jobs.lease(h.clock.now(), 30000))!;
    h.clock.advance(31);
    const current = (await h.jobs.lease(h.clock.now(), 30000))!;
    expect(current.id).toBe(id);
    expect(current.attempts).toBe(2);
    expect(current.leased_by).not.toBe(old.leased_by);
    expect(await h.jobs.complete(old, h.clock.now())).toBe(false);
    expect(await h.jobs.complete(current, h.clock.now())).toBe(true);
    expect(await h.count('job_receipts')).toBe(1);
  });
  it('returns a stable fake refund after a crash between external call and commit', async () => {
    const f = await refund();
    const adapter = new DeterministicFakeRefundAdapter();
    const calls: string[] = [];
    const spy = {
      refund: async (input: Parameters<typeof adapter.refund>[0]) => {
        const result = await adapter.refund(input);
        calls.push(result.reference);
        return result;
      },
    };
    const old = (await h.jobs.lease(h.clock.now(), 30000))!;
    const input = (await h.jobs.prepareRefund(f.payment))!;
    await spy.refund(input);
    h.clock.advance(31);
    await h.worker(spy).tick();
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(1);
    expect(await h.count('payments', "status='refunded'")).toBe(1);
    expect(await h.count('audit_logs', "action='payment.refunded'")).toBe(1);
    expect(
      await h.jobs.complete(old, h.clock.now(), { paymentId: f.payment, reference: calls[0]! }),
    ).toBe(false);
    expect(await h.count('job_receipts')).toBe(1);
  });
  it('does not duplicate refund side effects after committed work is redelivered', async () => {
    const f = await refund();
    const adapter = new DeterministicFakeRefundAdapter();
    const spy = vi.spyOn(adapter, 'refund');
    await h.worker(adapter).tick();
    await h.pool.query(
      "UPDATE outbox_jobs SET status='pending',completed_at=NULL,available_at=$2 WHERE id=$1",
      [f.job, h.clock.now()],
    );
    await h.worker(adapter).tick();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await h.count('job_receipts')).toBe(1);
    expect(await h.count('audit_logs', "action='payment.refunded'")).toBe(1);
    expect((await state(f.job)).status).toBe('completed');
  });
  it('leaves manual encrypted setup delivery pending and processes business records', async () => {
    const setup = await enqueue('identity.setup_delivery', {
      tokenEnvelope: { ciphertext: 'private' },
    });
    const business = await enqueue('consultation.booked', { consultationId: randomUUID() });
    await h.drain();
    expect((await state(setup)).status).toBe('pending');
    expect((await state(business)).status).toBe('completed');
    expect(await h.count('job_receipts')).toBe(1);
  });
  it('uses a worker database role unable to read clinical notes, prescriptions, users or audit history', async () => {
    for (const table of ['users', 'prescriptions', 'audit_logs'])
      await expect(
        h.workerDatabase
          .selectFrom(table as 'users')
          .selectAll()
          .execute(),
      ).rejects.toMatchObject({ code: '42501' });
    await expect(
      h.workerDatabase.selectFrom('consultations').select('clinical_notes').execute(),
    ).rejects.toMatchObject({ code: '42501' });
  });
});

describe('bounded retries and terminal visibility', () => {
  it('retries transient fake failures with backoff, then completes once', async () => {
    const f = await refund();
    const adapter = new DeterministicFakeRefundAdapter();
    let calls = 0;
    const failing = {
      refund: (input: Parameters<typeof adapter.refund>[0]) => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new JobFailure('REFUND_TEMPORARY_FAILURE'))
          : adapter.refund(input);
      },
    };
    const runner = h.worker(failing);
    await runner.tick();
    const first = await state(f.job);
    expect(first.status).toBe('pending');
    expect(first.attempts).toBe(1);
    expect(first.last_error_code).toBe('REFUND_TEMPORARY_FAILURE');
    expect(first.available_at.getTime() - h.clock.now().getTime()).toBe(750);
    expect(await runner.tick()).toBe(false);
    h.clock.advance(1);
    await runner.tick();
    expect((await state(f.job)).status).toBe('completed');
    expect(calls).toBe(2);
  });
  it('marks exhausted retries failed without recording raw provider errors or refunding', async () => {
    const f = await refund();
    await h.pool.query('UPDATE outbox_jobs SET max_attempts=2 WHERE id=$1', [f.job]);
    const adapter = { refund: () => Promise.reject(new Error('sensitive provider token=secret')) };
    const runner = h.worker(adapter);
    await runner.tick();
    h.clock.advance(2);
    await runner.tick();
    const job = await state(f.job);
    expect(job.status).toBe('failed');
    expect(job.attempts).toBe(2);
    expect(job.last_error_code).toBe('HANDLER_UNAVAILABLE');
    expect(await h.count('payments', "status='refund_pending'")).toBe(1);
    expect(await h.count('job_receipts')).toBe(0);
    expect(await h.count('audit_logs', "action='outbox.failed'")).toBe(1);
    const admin = await h.account('admin');
    const result = await h.get(`/v1/admin/jobs?${h.range()}&status=failed`, admin).expect(200);
    expect(result.text).toContain('HANDLER_UNAVAILABLE');
    expect(result.text).not.toContain('sensitive provider');
    expect(result.text).not.toContain('payload');
  });
  it('marks a crash-exhausted final lease failed instead of leaving a stuck processing job', async () => {
    const id = await enqueue('consultation.booked', { consultationId: randomUUID() }, 1);
    await h.jobs.lease(h.clock.now(), 1000);
    h.clock.advance(2);
    expect(await h.worker().tick()).toBe(false);
    expect((await state(id)).status).toBe('failed');
    expect((await state(id)).last_error_code).toBe('LEASE_EXHAUSTED');
  });
  it.each([
    ['unsupported.kind', { id: 'private' }],
    ['consultation.booked', { consultationId: 'bad' }],
  ])('permanently rejects %s without leaking payload', async (kind, payload) => {
    const id = await enqueue(kind, payload);
    await h.worker().tick();
    expect((await state(id)).status).toBe('failed');
    expect(await h.count('job_receipts')).toBe(0);
  });
  it('keeps compensation, audit, receipt and acknowledgement atomic when audit fails', async () => {
    const f = await refund();
    await h.pool.query(
      "CREATE FUNCTION worker_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='payment.refunded' THEN RAISE EXCEPTION 'Injected failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER worker_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION worker_failure()",
    );
    await h.worker().tick();
    expect(await h.count('payments', "status='refund_pending'")).toBe(1);
    expect(await h.count('job_receipts')).toBe(0);
    expect((await state(f.job)).status).toBe('pending');
    await h.pool.query('DROP TRIGGER worker_failure ON audit_logs; DROP FUNCTION worker_failure()');
    h.clock.advance(2);
    await h.worker().tick();
    expect(await h.count('payments', "status='refunded'")).toBe(1);
    expect(await h.count('job_receipts')).toBe(1);
  });
  it.each(['job_receipts', 'outbox_jobs'] as const)(
    'rolls refund/audit/receipt/ack back when %s completion fails',
    async (table) => {
      const f = await refund();
      const condition = table === 'outbox_jobs' ? "NEW.status='completed'" : 'true';
      await h.pool.query(
        `CREATE FUNCTION worker_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF ${condition} THEN RAISE EXCEPTION 'Injected failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER worker_failure BEFORE INSERT OR UPDATE ON ${table} FOR EACH ROW EXECUTE FUNCTION worker_failure()`,
      );
      await h.worker().tick();
      expect(await h.count('payments', "status='refund_pending'")).toBe(1);
      expect(await h.count('job_receipts')).toBe(0);
      expect(await h.count('audit_logs', "action='payment.refunded'")).toBe(0);
      expect((await state(f.job)).status).toBe('pending');
      await h.pool.query(`DROP TRIGGER worker_failure ON ${table}; DROP FUNCTION worker_failure()`);
      h.clock.advance(2);
      await h.worker().tick();
      expect(await h.count('payments', "status='refunded'")).toBe(1);
      expect(await h.count('job_receipts')).toBe(1);
    },
  );
  it('does not call an adapter while a database transaction holds locks', async () => {
    const f = await refund();
    const adapter = new DeterministicFakeRefundAdapter();
    const boundary = {
      refund: async (input: Parameters<typeof adapter.refund>[0]) => {
        const active = await h.pool.query<{ count: string }>(
          "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND state='idle in transaction'",
        );
        expect(Number(active.rows[0]?.count)).toBe(0);
        const client = await h.pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT id FROM payments WHERE id=$1 FOR UPDATE NOWAIT', [f.payment]);
          await client.query('ROLLBACK');
        } finally {
          client.release();
        }
        return adapter.refund(input);
      },
    };
    await h.worker(boundary).tick();
    expect((await state(f.job)).status).toBe('completed');
  });
});
