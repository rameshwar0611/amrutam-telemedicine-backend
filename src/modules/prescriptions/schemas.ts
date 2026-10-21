import { z } from 'zod';
export const prescriptionContentSchema = z.strictObject({
  medications: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(100),
        dosage: z.string().trim().min(1).max(100),
        instructions: z.string().trim().min(1).max(1000),
      }),
    )
    .min(1)
    .max(20),
  instructions: z.string().trim().max(2000).default(''),
});
export const prescriptionCreateSchema = z.strictObject({
  content: prescriptionContentSchema,
  correctionOf: z.uuid().optional(),
});
export const prescriptionEditSchema = z.strictObject({
  expectedRevision: z.number().int().positive(),
  content: prescriptionContentSchema,
});
export const prescriptionRevokeSchema = z.strictObject({
  reason: z.enum(['clinical_correction', 'issued_in_error']),
});
export const prescriptionParams = z.strictObject({ prescriptionId: z.uuid() });
export const prescriptionDtoSchema = z.strictObject({
  id: z.uuid(),
  consultationId: z.uuid(),
  doctorId: z.uuid(),
  version: z.number().int(),
  revision: z.number().int(),
  status: z.enum(['draft', 'finalized', 'revoked']),
  correctionOf: z.uuid().nullable(),
  finalizedAt: z.iso.datetime().nullable(),
  revokedAt: z.iso.datetime().nullable(),
  revocationReason: z.string().nullable(),
  content: prescriptionContentSchema,
});
export type PrescriptionContent = z.infer<typeof prescriptionContentSchema>;
