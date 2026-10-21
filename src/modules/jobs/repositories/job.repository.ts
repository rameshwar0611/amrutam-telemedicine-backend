import { traceParent } from '../../../infrastructure/telemetry/runtime.js';
import { randomUUID } from 'node:crypto';
import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { JobStore, LeasedJob } from '../domain/jobs.js';
import { AuditRepository } from '../../audit/repositories/audit.repository.js';
import { z } from 'zod';

export class JobRepository implements JobStore {
  constructor(private readonly db: Kysely<Database>) {}
  async lease(now: Date, leaseMs: number) {
    return this.db.transaction().execute(async (tx) => {
      await tx
        .updateTable('outbox_jobs')
        .set({
          status: 'failed',
          leased_by: null,
          lease_until: null,
          last_error_code: 'LEASE_EXHAUSTED',
        })
        .where('status', '=', 'processing')
        .where('lease_until', '<=', now)
        .whereRef('attempts', '>=', 'max_attempts')
        .execute();
      const row = await tx
        .selectFrom('outbox_jobs')
        .selectAll()
        .where('kind', '!=', 'identity.setup_delivery')
        .whereRef('attempts', '<', 'max_attempts')
        .where((eb) =>
          eb.or([
            eb.and([eb('status', '=', 'pending'), eb('available_at', '<=', now)]),
            eb.and([eb('status', '=', 'processing'), eb('lease_until', '<=', now)]),
          ]),
        )
        .orderBy('available_at')
        .orderBy('id')
        .forUpdate()
        .skipLocked()
        .limit(1)
        .executeTakeFirst();
      if (!row) return undefined;
      return tx
        .updateTable('outbox_jobs')
        .set({
          status: 'processing',
          attempts: sql`attempts+1`,
          leased_by: randomUUID(),
          lease_until: new Date(now.getTime() + leaseMs),
          last_error_code: null,
        })
        .where('id', '=', row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
    });
  }
  async prepareRefund(paymentId: string) {
    const row = await this.db
      .selectFrom('payments')
      .selectAll()
      .where('id', '=', paymentId)
      .executeTakeFirst();
    if (!row || row.status !== 'refund_pending') return undefined;
    return {
      paymentId,
      amountMinor: row.amount_minor,
      currency: row.currency,
      idempotencyKey: `refund:${paymentId}`,
    };
  }
  private async owned(tx: Transaction<Database>, job: LeasedJob, now: Date) {
    const row = await tx
      .selectFrom('outbox_jobs')
      .select('id')
      .where('id', '=', job.id)
      .where('status', '=', 'processing')
      .where('leased_by', '=', job.leased_by)
      .where('attempts', '=', job.attempts)
      .where('lease_until', '>', now)
      .forUpdate()
      .executeTakeFirst();
    return !!row;
  }
  async complete(job: LeasedJob, now: Date, refund?: { paymentId: string; reference: string }) {
    return this.db.transaction().execute(async (tx) => {
      if (!(await this.owned(tx, job, now))) return false;
      const previous = await tx
        .selectFrom('job_receipts')
        .select('job_id')
        .where('job_id', '=', job.id)
        .executeTakeFirst();
      if (!previous) {
        const audit = new AuditRepository(tx);
        if (job.kind === 'consultation.cancelled' || job.kind === 'consultation.no_show') {
          const { consultationId } = z.object({ consultationId: z.uuid() }).parse(job.payload);
          const consultation = await tx
            .selectFrom('consultations')
            .select(['id', 'status'])
            .where('id', '=', consultationId)
            .executeTakeFirst();
          if (!consultation || !['cancelled', 'no_show'].includes(consultation.status))
            throw new Error('Compensation state unavailable');
          const payments = await tx
            .selectFrom('payments')
            .selectAll()
            .where('consultation_id', '=', consultationId)
            .orderBy('id')
            .forUpdate()
            .execute();
          for (const payment of payments) {
            const status =
              payment.status === 'paid'
                ? 'refund_pending'
                : ['pending', 'authorized'].includes(payment.status)
                  ? 'cancelled'
                  : null;
            if (!status) continue;
            await tx.updateTable('payments').set({ status }).where('id', '=', payment.id).execute();
            await audit.append({
              actorId: null,
              action: 'payment.compensated',
              resourceType: 'payment',
              resourceId: payment.id,
              outcome: 'success',
              requestId: job.id,
              metadata: { from: payment.status, to: status },
            });
            if (status === 'refund_pending')
              await tx
                .insertInto('outbox_jobs')
                .values({
                  kind: 'payment.refund_requested',
                  trace_parent: traceParent(),
                  deduplication_key: `payment.refund_requested:${payment.id}`,
                  payload: { paymentId: payment.id },
                })
                .onConflict((c) => c.column('deduplication_key').doNothing())
                .execute();
          }
        }
        if (job.kind === 'payment.refund_requested') {
          const { paymentId } = z.object({ paymentId: z.uuid() }).parse(job.payload);
          const payment = await tx
            .selectFrom('payments')
            .selectAll()
            .where('id', '=', paymentId)
            .forUpdate()
            .executeTakeFirst();
          if (!payment) throw new Error('Payment unavailable');
          if (payment.status === 'refund_pending') {
            if (!refund || refund.paymentId !== paymentId) throw new Error('Missing refund result');
            await tx
              .updateTable('payments')
              .set({ status: 'refunded', provider_reference: refund.reference })
              .where('id', '=', paymentId)
              .execute();
            await audit.append({
              actorId: null,
              action: 'payment.refunded',
              resourceType: 'payment',
              resourceId: paymentId,
              outcome: 'success',
              requestId: job.id,
            });
          } else if (payment.status !== 'refunded') throw new Error('Invalid refund state');
        }
        await tx.insertInto('job_receipts').values({ job_id: job.id, kind: job.kind }).execute();
      }
      await tx
        .updateTable('outbox_jobs')
        .set({
          status: 'completed',
          completed_at: now,
          leased_by: null,
          lease_until: null,
          last_error_code: null,
        })
        .where('id', '=', job.id)
        .execute();
      return true;
    });
  }
  async fail(job: LeasedJob, now: Date, code: string, permanent: boolean, delayMs: number) {
    await this.db.transaction().execute(async (tx) => {
      if (!(await this.owned(tx, job, now))) return;
      const terminal = permanent || job.attempts >= job.max_attempts;
      await tx
        .updateTable('outbox_jobs')
        .set({
          status: terminal ? 'failed' : 'pending',
          leased_by: null,
          lease_until: null,
          last_error_code: code,
          available_at: new Date(now.getTime() + delayMs),
        })
        .where('id', '=', job.id)
        .execute();
      if (terminal)
        await new AuditRepository(tx).append({
          actorId: null,
          action: 'outbox.failed',
          resourceType: 'outbox_job',
          resourceId: job.id,
          outcome: 'failure',
          requestId: job.id,
          metadata: { code },
        });
    });
  }
}
