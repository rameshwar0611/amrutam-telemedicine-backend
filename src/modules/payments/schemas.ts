import { z } from 'zod';
export const paymentCreateSchema = z.strictObject({
  amountMinor: z.number().int().min(0).max(1000000000000),
  currency: z.string().regex(/^[A-Z]{3}$/),
});
export const paymentTransitionSchema = z.strictObject({
  status: z.enum(['authorized', 'paid', 'failed', 'cancelled', 'refund_pending']),
});
export const paymentParams = z.strictObject({ paymentId: z.uuid() });
export const paymentDtoSchema = z.strictObject({
  id: z.uuid(),
  consultationId: z.uuid(),
  amountMinor: z.string().regex(/^\d+$/),
  currency: z.string(),
  status: z.enum([
    'pending',
    'authorized',
    'paid',
    'refund_pending',
    'refunded',
    'failed',
    'cancelled',
  ]),
  mode: z.literal('internal_fake'),
  updatedAt: z.iso.datetime(),
});
