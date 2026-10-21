import { z } from 'zod';
import { instantSchema, paginationSchema } from '../bookings/schemas.js';
const bounded = z
  .object({ from: instantSchema, to: instantSchema })
  .refine(
    (v) => v.from < v.to && new Date(v.to).getTime() - new Date(v.from).getTime() <= 31 * 86400000,
    'Range must be ordered and at most 31 days',
  );
export const auditQuerySchema = paginationSchema
  .extend({
    from: instantSchema,
    to: instantSchema,
    actorId: z.uuid().optional(),
    resourceId: z.uuid().optional(),
    action: z
      .string()
      .regex(/^[a-z_.]{1,100}$/)
      .optional(),
    outcome: z.enum(['success', 'failure', 'denied']).optional(),
  })
  .strict()
  .refine((v) => bounded.safeParse(v).success, 'Range must be ordered and at most 31 days');
export const analyticsQuerySchema = paginationSchema
  .extend({ from: instantSchema, to: instantSchema, doctorId: z.uuid().optional() })
  .strict()
  .refine((v) => bounded.safeParse(v).success, 'Range must be ordered and at most 31 days');
export const jobsQuerySchema = paginationSchema
  .extend({
    from: instantSchema,
    to: instantSchema,
    status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(),
  })
  .strict()
  .refine((v) => bounded.safeParse(v).success, 'Range must be ordered and at most 31 days');
export type AuditQuery = z.infer<typeof auditQuerySchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
export type JobsQuery = z.infer<typeof jobsQuerySchema>;
