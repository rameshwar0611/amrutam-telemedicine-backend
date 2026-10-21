import { describe, it, expect } from 'vitest';
import { canPaymentTransition } from '../../src/modules/payments/domain/ports.js';
import { retryDelay } from '../../src/modules/jobs/domain/jobs.js';
import { DeterministicFakeRefundAdapter } from '../../src/infrastructure/payments/fake-refund-adapter.js';
import { analyticsQuerySchema, auditQuerySchema } from '../../src/modules/analytics/schemas.js';
import { notesWriteSchema } from '../../src/modules/consultations/schemas.js';
import { prescriptionCreateSchema } from '../../src/modules/prescriptions/schemas.js';

describe('payment state contract', () => {
  it.each([
    ['pending', 'authorized'],
    ['authorized', 'paid'],
    ['paid', 'refund_pending'],
    ['refund_pending', 'refunded'],
    ['pending', 'failed'],
    ['authorized', 'cancelled'],
  ])('allows %s to %s', (from, to) => expect(canPaymentTransition(from, to)).toBe(true));
  it.each([
    ['pending', 'paid'],
    ['paid', 'cancelled'],
    ['refunded', 'paid'],
    ['failed', 'authorized'],
    ['cancelled', 'pending'],
    ['paid', 'paid'],
  ])('rejects %s to %s', (from, to) => expect(canPaymentTransition(from, to)).toBe(false));
  it('bounds exponential backoff and jitter at every attempt', () => {
    expect(retryDelay(1, 0)).toBe(500);
    expect(retryDelay(1, 1)).toBe(1000);
    expect(retryDelay(2, 0.5)).toBe(1500);
    expect(retryDelay(100, 1)).toBe(60000);
    expect(retryDelay(100, 0)).toBe(30000);
  });
  it('uses deterministic fake idempotency across adapter instances with amount binding', async () => {
    const input = {
      paymentId: 'fixture-id',
      amountMinor: '100',
      currency: 'INR',
      idempotencyKey: 'refund:fixture-id',
    };
    const first = await new DeterministicFakeRefundAdapter().refund(input);
    expect(await new DeterministicFakeRefundAdapter().refund(input)).toEqual(first);
    expect(
      await new DeterministicFakeRefundAdapter().refund({ ...input, amountMinor: '101' }),
    ).not.toEqual(first);
  });
});
describe('bounded compliance and clinical inputs', () => {
  it('rejects overly broad, reversed and unknown audit/analytics filters', () => {
    for (const schema of [analyticsQuerySchema, auditQuerySchema]) {
      expect(
        schema.safeParse({ from: '2035-01-01T00:00:00Z', to: '2036-01-01T00:00:00Z' }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ from: '2035-02-01T00:00:00Z', to: '2035-01-01T00:00:00Z' }).success,
      ).toBe(false);
      expect(
        schema.safeParse({
          from: '2035-01-01T00:00:00Z',
          to: '2035-01-02T00:00:00Z',
          clinical: true,
        }).success,
      ).toBe(false);
    }
  });
  it('requires versioned bounded notes and strict prescription content', () => {
    expect(
      notesWriteSchema.safeParse({
        expectedVersion: 0,
        notes: { summary: 'x', assessment: 'x', plan: 'x' },
      }).success,
    ).toBe(false);
    expect(
      prescriptionCreateSchema.safeParse({ content: { medications: [], patientId: 'other' } })
        .success,
    ).toBe(false);
  });
});
