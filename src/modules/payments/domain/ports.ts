export interface RefundAdapter {
  refund(input: {
    paymentId: string;
    amountMinor: string;
    currency: string;
    idempotencyKey: string;
  }): Promise<{ reference: string }>;
}
export const canPaymentTransition = (from: string, to: string) =>
  (
    ({
      pending: ['authorized', 'failed', 'cancelled'],
      authorized: ['paid', 'failed', 'cancelled'],
      paid: ['refund_pending'],
      refund_pending: ['refunded'],
    }) as Record<string, string[]>
  )[from]?.includes(to) ?? false;
export interface PaymentRecord {
  id: string;
  consultation_id: string;
  amount_minor: string;
  currency: string;
  status:
    'pending' | 'authorized' | 'paid' | 'refund_pending' | 'refunded' | 'failed' | 'cancelled';
  updated_at: Date;
}
export interface PaymentStore {
  get(id: string, lock?: boolean): Promise<PaymentRecord | undefined>;
  create(consultationId: string, amountMinor: number, currency: string): Promise<PaymentRecord>;
  list(id: string, limit: number, offset: number): Promise<PaymentRecord[]>;
  update(
    id: string,
    status: 'authorized' | 'paid' | 'failed' | 'cancelled' | 'refund_pending',
  ): Promise<void>;
}
