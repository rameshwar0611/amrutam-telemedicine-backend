import type { JsonValue } from '../../../shared/json.js';
import type { RefundAdapter } from '../../payments/domain/ports.js';
export interface LeasedJob {
  trace_parent?: string | null;
  id: string;
  kind: string;
  payload: JsonValue;
  attempts: number;
  max_attempts: number;
  leased_by: string | null;
  lease_until: Date | null;
}
export class JobFailure extends Error {
  constructor(
    readonly code: 'INVALID_PAYLOAD' | 'UNSUPPORTED_JOB' | 'REFUND_TEMPORARY_FAILURE',
    readonly permanent = false,
  ) {
    super(code);
  }
}
export interface JobStore {
  lease(now: Date, leaseMs: number): Promise<LeasedJob | undefined>;
  prepareRefund(
    paymentId: string,
  ): Promise<
    { paymentId: string; amountMinor: string; currency: string; idempotencyKey: string } | undefined
  >;
  complete(
    job: LeasedJob,
    now: Date,
    refund?: { paymentId: string; reference: string },
  ): Promise<boolean>;
  fail(job: LeasedJob, now: Date, code: string, permanent: boolean, delayMs: number): Promise<void>;
}
export type { RefundAdapter };
export function retryDelay(attempt: number, random: number): number {
  return Math.floor(
    Math.min(60000, 1000 * 2 ** Math.min(16, Math.max(0, attempt - 1))) *
      (0.5 + Math.min(1, Math.max(0, random)) * 0.5),
  );
}
