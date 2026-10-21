import { z } from 'zod';
export const clinicalNotesSchema = z.strictObject({
  summary: z.string().trim().min(1).max(4000),
  assessment: z.string().trim().min(1).max(4000),
  plan: z.string().trim().min(1).max(4000),
});
export const notesWriteSchema = z.strictObject({
  expectedVersion: z.number().int().positive(),
  notes: clinicalNotesSchema,
});
export const transitionSchema = z.strictObject({
  status: z.enum(['in_progress', 'completed', 'no_show']),
});
export const clinicalParams = z.strictObject({ consultationId: z.uuid() });
export const notesDtoSchema = z.strictObject({
  consultationId: z.uuid(),
  version: z.number().int().positive(),
  notes: clinicalNotesSchema.nullable(),
});
export const noteSavedSchema = z.strictObject({
  consultationId: z.uuid(),
  version: z.number().int().positive(),
});
export type ClinicalNotes = z.infer<typeof clinicalNotesSchema>;
