import { z } from 'zod';

export const livenessSchema = z.object({ status: z.literal('alive') });
export const readinessSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  dependencies: z.object({ postgres: z.enum(['up', 'down']), redis: z.enum(['up', 'down']) }),
});
export type Readiness = z.infer<typeof readinessSchema>;
