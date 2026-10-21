import { z } from 'zod';

function jsonObject(
  value: string,
  context: z.RefinementCtx,
): Record<string, string> | typeof z.NEVER {
  try {
    return z
      .record(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), z.string().min(1))
      .parse(JSON.parse(value));
  } catch {
    context.addIssue({ code: 'custom', message: 'Must be a JSON key map' });
    return z.NEVER;
  }
}

const seconds = (value: number, minimum: number, maximum: number) =>
  z.coerce.number().int().min(minimum).max(maximum).default(value);
const keyMap = z.string().transform(jsonObject);
const bytes32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);

export const securityEnvSchema = z
  .object({
    AUTH_JWT_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    AUTH_JWT_PRIVATE_KEY_BASE64: z.string().min(32),
    AUTH_JWT_PUBLIC_KEYS: keyMap,
    AUTH_ENCRYPTION_KEY_ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    AUTH_ENCRYPTION_KEYS: keyMap.superRefine((keys, context) => {
      if (
        !Object.keys(keys).length ||
        Object.values(keys).some((value) => !bytes32.safeParse(value).success)
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Encryption keys must be base64 32-byte keys',
        });
      }
    }),
    AUTH_TOKEN_PEPPER_BASE64: bytes32,
    AUTH_JWT_ISSUER: z.url().default('https://amrutam.local'),
    AUTH_JWT_AUDIENCE: z.string().min(1).default('amrutam-api'),
    AUTH_ACCESS_TTL_SECONDS: seconds(300, 60, 900),
    AUTH_CHALLENGE_TTL_SECONDS: seconds(300, 60, 600),
    AUTH_REFRESH_TTL_SECONDS: seconds(604800, 3600, 2592000),
    AUTH_SETUP_TTL_SECONDS: seconds(3600, 300, 86400),
    AUTH_RETRY_TTL_SECONDS: seconds(30, 5, 60),
    AUTH_LOGIN_LIMIT: seconds(10, 1, 100),
    AUTH_IP_LIMIT: seconds(60, 1, 1000),
  })
  .superRefine((value, context) => {
    if (!Object.hasOwn(value.AUTH_ENCRYPTION_KEYS, value.AUTH_ENCRYPTION_KEY_ID))
      context.addIssue({
        path: ['AUTH_ENCRYPTION_KEYS'],
        code: 'custom',
        message: 'Current key missing',
      });
    if (!Object.hasOwn(value.AUTH_JWT_PUBLIC_KEYS, value.AUTH_JWT_KEY_ID))
      context.addIssue({
        path: ['AUTH_JWT_PUBLIC_KEYS'],
        code: 'custom',
        message: 'Current key missing',
      });
    if (Object.values(value.AUTH_ENCRYPTION_KEYS).includes(value.AUTH_TOKEN_PEPPER_BASE64))
      context.addIssue({
        path: ['AUTH_TOKEN_PEPPER_BASE64'],
        code: 'custom',
        message: 'Use an independent pepper',
      });
  });

export type SecurityConfig = z.infer<typeof securityEnvSchema>;
export function loadSecurityConfig(environment: NodeJS.ProcessEnv = process.env): SecurityConfig {
  const parsed = securityEnvSchema.safeParse(environment);
  if (!parsed.success)
    throw new Error(
      `Invalid security configuration fields: ${[...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))].join(', ')}`,
    );
  return parsed.data;
}
