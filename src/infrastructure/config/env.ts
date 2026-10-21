import { z } from 'zod';
import { isIP } from 'node:net';

const trustedProxies = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  )
  .superRefine((entries, context) => {
    for (const entry of entries) {
      const [address, prefix, extra] = entry.split('/');
      const version = address ? isIP(address) : 0;
      const bits = prefix === undefined ? (version === 4 ? 32 : 128) : Number(prefix);
      if (
        !version ||
        extra !== undefined ||
        !Number.isInteger(bits) ||
        bits < 1 ||
        bits > (version === 4 ? 32 : 128)
      )
        context.addIssue({
          code: 'custom',
          message: 'Use explicit IP addresses or bounded CIDRs; trusting all proxies is forbidden',
        });
    }
  });

const postgresUrl = z.url().superRefine((value, context) => {
  if (!URL.canParse(value)) return;
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    context.addIssue({ code: 'custom', message: 'Must be a PostgreSQL URL' });
  }
  if (
    ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'sslpassword'].some((key) =>
      url.searchParams.has(key),
    )
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Configure TLS using DATABASE_SSL_MODE and DATABASE_CA_CERT',
    });
  }
});

const positiveInteger = (fallback: number, max: number) =>
  z.coerce.number().int().positive().max(max).default(fallback);

export const databaseEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
  DATABASE_SSL_MODE: z.enum(['disable', 'verify-full']).default('disable'),
  DATABASE_CA_CERT: z.string().min(1).optional(),
  DATABASE_POOL_MAX: positiveInteger(10, 100),
  DATABASE_CONNECTION_TIMEOUT_MS: positiveInteger(5000, 60_000),
  DATABASE_STATEMENT_TIMEOUT_MS: positiveInteger(5000, 60_000),
});

export const envSchema = databaseEnvSchema
  .extend({
    OTEL_ENABLED: z.enum(['true', 'false']).default('false'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: positiveInteger(3000, 65_535),
    WORKER_POLL_MS: positiveInteger(1000, 60000),
    WORKER_LEASE_MS: z.coerce.number().int().min(1000).max(300000).default(30000),
    WORKER_HEALTH_PORT: positiveInteger(3001, 65_535),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    SHUTDOWN_TIMEOUT_MS: positiveInteger(10_000, 60_000),
    TRUST_PROXY_CIDRS: trustedProxies,
    REDIS_URL: z
      .url()
      .refine(
        (value) => URL.canParse(value) && ['redis:', 'rediss:'].includes(new URL(value).protocol),
      ),
  })
  .superRefine((value, context) => {
    if (value.NODE_ENV === 'production' && value.DATABASE_SSL_MODE !== 'verify-full') {
      context.addIssue({
        path: ['DATABASE_SSL_MODE'],
        code: 'custom',
        message: 'Production requires TLS verification',
      });
    }
    if (value.NODE_ENV === 'production' && !value.REDIS_URL.startsWith('rediss:')) {
      context.addIssue({
        path: ['REDIS_URL'],
        code: 'custom',
        message: 'Production requires Redis TLS',
      });
    }
  });

function parseEnvironment<T>(schema: z.ZodType<T>, input: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    // Do not include raw values or URLs: they may contain credentials.
    throw new Error(`Invalid environment fields: ${fields.join(', ')}`);
  }
  return result.data;
}

export type AppConfig = z.infer<typeof envSchema>;
export type DatabaseConfig = z.infer<typeof databaseEnvSchema>;
export const loadConfig = (input: NodeJS.ProcessEnv = process.env): AppConfig =>
  parseEnvironment(envSchema, input);
export const loadDatabaseConfig = (input: NodeJS.ProcessEnv = process.env): DatabaseConfig =>
  parseEnvironment(databaseEnvSchema, input);
