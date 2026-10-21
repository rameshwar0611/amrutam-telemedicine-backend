import { jobSpan, workerJobs } from '../../../infrastructure/telemetry/runtime.js';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import type { Logger } from 'pino';
import type { Clock } from '../../identity/domain/security.js';
import { JobFailure, retryDelay, type JobStore, type RefundAdapter } from '../domain/jobs.js';
const consultationEvent = z.strictObject({ consultationId: z.uuid() });
const prescriptionEvent = z.strictObject({ prescriptionId: z.uuid() });
const paymentEvent = z.strictObject({ paymentId: z.uuid() });
export class OutboxWorker {
  private loop: Promise<void> | undefined;
  private abort = new AbortController();
  constructor(
    private readonly store: JobStore,
    private readonly refund: RefundAdapter,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly options: { pollMs: number; leaseMs: number },
    private readonly random: () => number = Math.random,
  ) {}
  async tick(): Promise<boolean> {
    const job = await this.store.lease(this.clock.now(), this.options.leaseMs);
    if (!job) return false;
    return jobSpan(job.kind, job.trace_parent, async () => {
      try {
        let refund: { paymentId: string; reference: string } | undefined;
        if (
          [
            'consultation.booked',
            'consultation.cancelled',
            'consultation.in_progress',
            'consultation.completed',
            'consultation.no_show',
          ].includes(job.kind)
        )
          consultationEvent.parse(job.payload);
        else if (['prescription.finalized', 'prescription.revoked'].includes(job.kind))
          prescriptionEvent.parse(job.payload);
        else if (
          [
            'payment.created',
            'payment.authorized',
            'payment.paid',
            'payment.failed',
            'payment.cancelled',
            'payment.refund_requested',
          ].includes(job.kind)
        ) {
          const { paymentId } = paymentEvent.parse(job.payload);
          if (job.kind === 'payment.refund_requested') {
            const input = await this.store.prepareRefund(paymentId);
            // SQL preparation finishes before calling the adapter; no transaction spans this call.
            if (input) refund = { paymentId, ...(await this.refund.refund(input)) };
          }
        } else throw new JobFailure('UNSUPPORTED_JOB', true);
        const completed = await this.store.complete(job, this.clock.now(), refund);
        workerJobs.add(1, { outcome: completed ? 'completed' : 'fenced' });
      } catch (error) {
        workerJobs.add(1, { outcome: 'failed' });
        const invalid = error instanceof z.ZodError;
        await this.store.fail(
          job,
          this.clock.now(),
          invalid
            ? 'INVALID_PAYLOAD'
            : error instanceof JobFailure
              ? error.code
              : 'HANDLER_UNAVAILABLE',
          invalid || (error instanceof JobFailure && error.permanent),
          retryDelay(job.attempts, this.random()),
        );
        this.logger.warn(
          { event: 'outbox_attempt_failed', jobId: job.id },
          'Outbox attempt failed',
        );
      }
      return true;
    });
  }
  start() {
    if (this.loop) throw new Error('Worker already started');
    this.loop = (async () => {
      while (!this.abort.signal.aborted) {
        let worked = false;
        try {
          worked = await this.tick();
        } catch {
          this.logger.error({ event: 'outbox_poll_failed' }, 'Outbox poll failed');
        }
        if (!worked)
          try {
            await delay(this.options.pollMs, undefined, { signal: this.abort.signal });
          } catch {
            if (!this.abort.signal.aborted) throw new Error('Worker delay failed');
          }
      }
    })();
  }
  async stop() {
    this.abort.abort();
    await this.loop;
  }
}
