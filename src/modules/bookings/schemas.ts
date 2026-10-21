import { z } from 'zod';

// An offset is mandatory: ambiguous/nonexistent local DST wall times are never guessed.
export const instantSchema = z.iso
  .datetime({ offset: true, precision: 3 })
  .or(z.iso.datetime({ offset: true, precision: 0 }))
  .transform((value) => new Date(value).toISOString());
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA timezone');
export const slotCreateSchema = z
  .strictObject({
    startsAt: instantSchema,
    endsAt: instantSchema,
    timeZone: timeZoneSchema.default('UTC'),
  })
  .refine((value) => value.endsAt > value.startsAt, 'End must follow start');
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});
export const availabilityQuerySchema = paginationSchema
  .extend({
    from: instantSchema.optional(),
    to: instantSchema.optional(),
  })
  .strict()
  .refine((value) => !value.from || !value.to || value.from < value.to, 'Invalid range');
export const doctorParams = z.strictObject({ doctorId: z.uuid() });
export const slotParams = z.strictObject({ doctorId: z.uuid(), slotId: z.uuid() });
export const consultationParams = z.strictObject({ consultationId: z.uuid() });
export const bookingCreateSchema = z.strictObject({ slotId: z.uuid() });
// Coded reason avoids persisting free-text clinical information in this workflow.
export const cancellationSchema = z.strictObject({
  reason: z.enum(['patient_request', 'doctor_unavailable', 'administrative']),
});
export const slotDtoSchema = z.strictObject({
  id: z.uuid(),
  doctorId: z.uuid(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  status: z.enum(['open', 'blocked']),
  bookable: z.boolean(),
});
export const consultationDtoSchema = z.strictObject({
  id: z.uuid(),
  slotId: z.uuid(),
  doctorId: z.uuid(),
  patientId: z.uuid(),
  status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled', 'no_show']),
  version: z.number().int().positive(),
  startsAt: z.iso.datetime(),
  endsAt: z.iso.datetime(),
  cancelledAt: z.iso.datetime().nullable(),
  cancellationReason: z.string().nullable(),
});
export const slotPageSchema = z.strictObject({
  items: z.array(slotDtoSchema),
  limit: z.number(),
  offset: z.number(),
  hasMore: z.boolean(),
});
export type SlotInput = z.infer<typeof slotCreateSchema>;
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;
