import { z } from 'zod';

export const roleSchema = z.enum(['patient', 'doctor', 'admin']);
export const actorSchema = z.object({
  userId: z.uuid(),
  sessionId: z.uuid(),
  authVersion: z.number().int().positive(),
  role: roleSchema,
});
const email = z
  .email()
  .max(254)
  .transform((value) => value.trim().toLowerCase());
const password = z
  .string()
  .min(12)
  .max(128)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 512);
const timeZone = z
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
  });
const name = z.string().trim().min(1).max(200);
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,128}$/);
export const userIdParams = z.strictObject({ userId: z.uuid() });
export const sessionIdParams = z.strictObject({ sessionId: z.uuid() });
export const registerSchema = z.strictObject({
  email,
  password,
  displayName: name,
  timeZone: timeZone.default('UTC'),
});
export const activateSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password,
});
export const loginSchema = z.strictObject({ email, password: z.string().min(1).max(128) });
export const refreshSchema = z.strictObject({
  refreshToken: z.string().regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/),
});
export const emptySchema = z.strictObject({});
export const otpSchema = z.strictObject({ code: z.string().regex(/^\d{6}$/) });
export const verifyMfaSchema = z.discriminatedUnion('method', [
  z.strictObject({ method: z.literal('totp'), code: z.string().regex(/^\d{6}$/) }),
  z.strictObject({ method: z.literal('recovery'), code: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
]);
export const profilePatchSchema = z
  .strictObject({
    displayName: name.optional(),
    phone: z
      .string()
      .regex(/^\+?[0-9 ()-]{6,25}$/)
      .nullable()
      .optional(),
    timeZone: timeZone.optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
export const passwordChangeSchema = z.strictObject({
  currentPassword: z.string().min(1).max(128),
  newPassword: password,
});
export const deactivateSchema = z.strictObject({ password: z.string().min(1).max(128) });
export const recoveryRegenerateSchema = z.strictObject({
  password: z.string().min(1).max(128),
  code: z.string().regex(/^\d{6}$/),
});
export const provisionSchema = z.discriminatedUnion('role', [
  z.strictObject({
    email,
    displayName: name,
    role: z.literal('admin'),
    timeZone: timeZone.default('UTC'),
  }),
  z.strictObject({
    email,
    displayName: name,
    role: z.literal('doctor'),
    timeZone: timeZone.default('UTC'),
    doctor: z.strictObject({ publicName: name, specialty: z.string().trim().min(1).max(100) }),
  }),
]);
export const statusChangeSchema = z.strictObject({ status: z.enum(['enabled', 'disabled']) });
export const userDtoSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  role: roleSchema,
  status: z.enum(['pending_activation', 'pending_mfa', 'active', 'disabled']),
  profile: z.object({
    displayName: z.string(),
    phone: z.string().nullable(),
    timeZone: z.string(),
  }),
  createdAt: z.iso.datetime(),
});
export const challengeResponseSchema = z.object({
  challengeToken: z.string(),
  nextStep: z.enum(['enroll', 'verify']),
  expiresIn: z.number().int(),
});
export const tokenResponseSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int(),
  recoveryCodes: z.array(z.string()).optional(),
});
export const enrollmentResponseSchema = z.object({
  provisioningUri: z.string(),
  expiresIn: z.number().int(),
});
export const sessionDtoSchema = z.object({
  id: z.uuid(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  revokedAt: z.iso.datetime().nullable(),
  current: z.boolean(),
});
export const genericAcceptedSchema = z.object({ message: z.string() });

export type RegistrationInput = z.infer<typeof registerSchema>;
export type ActivationInput = z.infer<typeof activateSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ProvisionInput = z.infer<typeof provisionSchema>;
export type ProfilePatch = z.infer<typeof profilePatchSchema>;
export type MfaInput = z.infer<typeof verifyMfaSchema>;
