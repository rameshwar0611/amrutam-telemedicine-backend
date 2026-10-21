import { z } from 'zod';
import { instantSchema, paginationSchema } from '../bookings/schemas.js';
export const discoveryQuerySchema = paginationSchema
  .extend({
    name: z.string().trim().min(1).max(200).optional(),
    specialty: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .transform((value) => value.toLowerCase())
      .optional(),
    availableFrom: instantSchema.optional(),
    availableTo: instantSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      (!value.availableFrom && !value.availableTo) ||
      (!!value.availableFrom && !!value.availableTo && value.availableFrom < value.availableTo),
    'Provide an ordered, complete time range',
  );
export const doctorDtoSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  specialty: z.string(),
  biography: z.string().nullable(),
});
export const doctorPageSchema = z.strictObject({
  items: z.array(doctorDtoSchema),
  limit: z.number().int().positive().max(100),
  offset: z.number().int().nonnegative().max(10000),
  hasMore: z.boolean(),
});
export type DiscoveryQuery = z.infer<typeof discoveryQuerySchema>;
export type DoctorPage = z.infer<typeof doctorPageSchema>;
