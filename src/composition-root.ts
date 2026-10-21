import { poolGauge, backlogGauge, oldestGauge } from './infrastructure/telemetry/runtime.js';
import { ClinicalRepository } from './modules/consultations/repositories/clinical.repository.js';
import { EventRepository } from './modules/consultations/repositories/event.repository.js';
import { ClinicalService } from './modules/consultations/services/clinical.service.js';
import { ClinicalController } from './modules/consultations/controllers/clinical.controller.js';
import { createClinicalRouter } from './modules/consultations/routes/clinical.routes.js';
import { PrescriptionRepository } from './modules/prescriptions/repositories/prescription.repository.js';
import { PrescriptionService } from './modules/prescriptions/services/prescription.service.js';
import { PrescriptionController } from './modules/prescriptions/controllers/prescription.controller.js';
import { createPrescriptionRouter } from './modules/prescriptions/routes/prescription.routes.js';
import { PaymentRepository } from './modules/payments/repositories/payment.repository.js';
import { PaymentService } from './modules/payments/services/payment.service.js';
import { PaymentController } from './modules/payments/controllers/payment.controller.js';
import { createPaymentRouter } from './modules/payments/routes/payment.routes.js';
import { AdminRepository } from './modules/analytics/repositories/admin.repository.js';
import { AdminService } from './modules/analytics/services/admin.service.js';
import { AdminController } from './modules/analytics/controllers/admin.controller.js';
import { createAdminRouter } from './modules/analytics/routes/admin.routes.js';
import { JobRepository } from './modules/jobs/repositories/job.repository.js';
import { OutboxWorker } from './modules/jobs/services/outbox-worker.js';
import { DeterministicFakeRefundAdapter } from './infrastructure/payments/fake-refund-adapter.js';
import { Router } from 'express';
import { BookingRepository } from './modules/bookings/repositories/booking.repository.js';
import { BookingService } from './modules/bookings/services/booking.service.js';
import { BookingController } from './modules/bookings/controllers/booking.controller.js';
import { createBookingRouter } from './modules/bookings/routes/booking.routes.js';
import { DirectoryRepository } from './modules/doctors/repositories/directory.repository.js';
import { RedisDirectoryCache } from './infrastructure/cache/redis-directory-cache.js';
import { DiscoveryService } from './modules/doctors/services/discovery.service.js';
import { DiscoveryController } from './modules/doctors/controllers/discovery.controller.js';
import { createDiscoveryRouter } from './modules/doctors/routes/discovery.routes.js';
import type { Logger } from 'pino';
import type { AppConfig } from './infrastructure/config/env.js';
import { createPool, createDatabase } from './infrastructure/database/client.js';
import { createRedisClient } from './infrastructure/redis/client.js';
import { DatabaseHealthRepository } from './modules/health/repositories/database-health.repository.js';
import { RedisHealthRepository } from './modules/health/repositories/redis-health.repository.js';
import { HealthService } from './modules/health/services/health.service.js';
import { HealthController } from './modules/health/controllers/health.controller.js';
import { createHealthRouter } from './modules/health/routes/health.routes.js';
import { createApp } from './infrastructure/http/app.js';
import { withTimeout } from './shared/timeout.js';
import type { SecurityConfig } from './infrastructure/config/security-env.js';
import { AesSecretBox } from './infrastructure/security/secret-box.js';
import { ArgonPasswords } from './infrastructure/security/passwords.js';
import { JwtTokens } from './infrastructure/security/tokens.js';
import { TotpProvider } from './infrastructure/security/otp.js';
import { RedisRateLimiter } from './infrastructure/security/rate-limiter.js';
import { PostgresUnitOfWork } from './infrastructure/database/unit-of-work.js';
import { IdentityRepository } from './modules/identity/repositories/identity.repository.js';
import { IdempotencyRepository } from './modules/identity/repositories/idempotency.repository.js';
import { AuditRepository } from './modules/audit/repositories/audit.repository.js';
import { AuthorizationService } from './modules/identity/services/authorization.service.js';
import { IdempotencyService } from './modules/identity/services/idempotency.service.js';
import { SessionService } from './modules/identity/services/session.service.js';
import { AccountService } from './modules/identity/services/account.service.js';
import { AuthenticationService } from './modules/identity/services/authentication.service.js';
import { MfaService } from './modules/identity/services/mfa.service.js';
import { IdentityController } from './modules/identity/controllers/identity.controller.js';
import { SecurityMiddleware } from './modules/identity/routes/security.middleware.js';
import { createIdentityRouter } from './modules/identity/routes/identity.routes.js';
import { systemClock, type Clock } from './modules/identity/domain/security.js';
import type { Kysely } from 'kysely';
import type { Database } from './infrastructure/database/types.js';

export function composeIdentityCore(
  database: Kysely<Database>,
  config: SecurityConfig,
  clock: Clock = systemClock,
) {
  const work = new PostgresUnitOfWork(database, (transaction) => ({
    identity: new IdentityRepository(transaction),
    audit: new AuditRepository(transaction),
    idempotency: new IdempotencyRepository(transaction),
  }));
  const secrets = new AesSecretBox(
    config.AUTH_ENCRYPTION_KEYS,
    config.AUTH_ENCRYPTION_KEY_ID,
    config.AUTH_TOKEN_PEPPER_BASE64,
  );
  const passwords = new ArgonPasswords();
  const tokens = new JwtTokens(config, clock);
  const otp = new TotpProvider(clock);
  const settings = {
    accessTtl: config.AUTH_ACCESS_TTL_SECONDS,
    challengeTtl: config.AUTH_CHALLENGE_TTL_SECONDS,
    refreshTtl: config.AUTH_REFRESH_TTL_SECONDS,
    setupTtl: config.AUTH_SETUP_TTL_SECONDS,
    retryTtl: config.AUTH_RETRY_TTL_SECONDS,
  };
  const idempotency = new IdempotencyService(secrets, clock);
  const authorization = new AuthorizationService(work, tokens, clock);
  const sessions = new SessionService(secrets, tokens, clock, settings);
  const accounts = new AccountService(
    work,
    passwords,
    secrets,
    tokens,
    idempotency,
    authorization,
    clock,
    settings,
  );
  const authentication = new AuthenticationService(
    work,
    passwords,
    secrets,
    tokens,
    idempotency,
    authorization,
    sessions,
    clock,
    settings,
  );
  const mfa = new MfaService(
    work,
    secrets,
    passwords,
    tokens,
    otp,
    idempotency,
    authorization,
    sessions,
    clock,
    settings,
  );
  return { accounts, authentication, mfa, authorization, secrets, work, idempotency };
}

export function composeBookingCore(
  database: Kysely<Database>,
  identity: ReturnType<typeof composeIdentityCore>,
  clock: Clock = systemClock,
) {
  const work = new PostgresUnitOfWork(database, (transaction) => ({
    identity: new IdentityRepository(transaction),
    audit: new AuditRepository(transaction),
    idempotency: new IdempotencyRepository(transaction),
    booking: new BookingRepository(transaction),
  }));
  return {
    work,
    bookings: new BookingService(work, identity.authorization, identity.idempotency, clock),
  };
}

export function composeClinicalCore(
  database: Kysely<Database>,
  identity: ReturnType<typeof composeIdentityCore>,
  clock: Clock = systemClock,
) {
  const work = new PostgresUnitOfWork(database, (transaction) => ({
    identity: new IdentityRepository(transaction),
    audit: new AuditRepository(transaction),
    idempotency: new IdempotencyRepository(transaction),
    clinical: new ClinicalRepository(transaction),
    events: new EventRepository(transaction),
    prescriptions: new PrescriptionRepository(transaction),
    payments: new PaymentRepository(transaction),
    admin: new AdminRepository(transaction),
  }));
  return {
    work,
    clinical: new ClinicalService(
      work,
      identity.authorization,
      identity.idempotency,
      identity.secrets,
      clock,
    ),
    prescriptions: new PrescriptionService(
      work,
      identity.authorization,
      identity.idempotency,
      identity.secrets,
      clock,
    ),
    payments: new PaymentService(work, identity.authorization, identity.idempotency),
    admin: new AdminService(work, identity.authorization),
  };
}

function createDependencies(config: AppConfig, logger: Logger) {
  const pool = createPool(config);
  pool.on('error', () =>
    logger.error({ event: 'database_pool_error' }, 'Database connection unavailable'),
  );
  const database = createDatabase(pool);
  let observationTimer: ReturnType<typeof setInterval> | undefined;
  const observe = async () => {
    poolGauge.record(pool.totalCount - pool.idleCount, { state: 'used' });
    poolGauge.record(pool.idleCount, { state: 'idle' });
    poolGauge.record(pool.waitingCount, { state: 'waiting' });
    poolGauge.record(config.DATABASE_POOL_MAX, { state: 'limit' });
    const { rows } = await pool.query<{ status: string; count: string; age: number }>(
      "SELECT status,count(*)::text AS count,COALESCE(EXTRACT(EPOCH FROM now()-min(created_at)),0)::float8 AS age FROM outbox_jobs WHERE kind<>'identity.setup_delivery' AND status IN ('pending','processing','failed') GROUP BY status",
    );
    for (const state of ['pending', 'processing', 'failed']) {
      const row = rows.find((r) => r.status === state);
      backlogGauge.record(Number(row?.count ?? 0), { state });
      if (state === 'pending') oldestGauge.record(row?.age ?? 0);
    }
  };
  const redis = createRedisClient(config.REDIS_URL, logger);
  const postgresProbe = new DatabaseHealthRepository(database);
  const redisProbe = new RedisHealthRepository(redis);
  const healthService = new HealthService(postgresProbe, redisProbe);
  const healthController = new HealthController(healthService);
  return {
    database,
    redis,
    healthService,
    healthRouter: createHealthRouter(healthController),
    async connect(): Promise<void> {
      const results = await Promise.allSettled([
        postgresProbe.ping(),
        withTimeout(redis.connect(), 5000, () => {
          if (redis.isOpen) redis.destroy();
        }),
      ]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Dependencies unavailable');
      if (config.OTEL_ENABLED === 'true') {
        await observe();
        observationTimer = setInterval(() => {
          void observe().catch(() =>
            logger.warn(
              { event: 'telemetry_observation_failed' },
              'Telemetry observation unavailable',
            ),
          );
        }, 5000);
        observationTimer.unref();
      }
    },
    async close(): Promise<void> {
      clearInterval(observationTimer);
      const results = await Promise.allSettled([
        database.destroy(),
        redis.isOpen ? redis.close() : Promise.resolve(),
      ]);
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Dependency shutdown failed');
    },
  };
}

export function composeApi(
  config: AppConfig,
  logger: Logger,
  securityConfig: SecurityConfig,
  clock: Clock = systemClock,
) {
  const { database, redis, ...dependencies } = createDependencies(config, logger);
  const core = composeIdentityCore(database, securityConfig, clock);
  const controller = new IdentityController(core.accounts, core.authentication, core.mfa);
  const security = new SecurityMiddleware(
    core.authorization,
    new RedisRateLimiter(redis),
    core.secrets,
    { login: securityConfig.AUTH_LOGIN_LIMIT, ip: securityConfig.AUTH_IP_LIMIT },
  );
  const booking = composeBookingCore(database, core, clock);
  const discovery = new DiscoveryService(
    core.work,
    core.authorization,
    new DirectoryRepository(database),
    new RedisDirectoryCache(redis),
    clock,
    logger,
  );
  // Identity router supplies shared ingress before all /v1 route matching.
  const routes = Router();
  routes.use(createIdentityRouter(controller, security));
  routes.use(createBookingRouter(new BookingController(booking.bookings), security));
  routes.use(createDiscoveryRouter(new DiscoveryController(discovery), security));
  const clinical = composeClinicalCore(database, core, clock);
  routes.use(createClinicalRouter(new ClinicalController(clinical.clinical), security));
  routes.use(
    createPrescriptionRouter(new PrescriptionController(clinical.prescriptions), security),
  );
  routes.use(createPaymentRouter(new PaymentController(clinical.payments), security));
  routes.use(createAdminRouter(new AdminController(clinical.admin), security));
  return {
    ...dependencies,
    app: createApp(dependencies.healthRouter, logger, true, routes, config.TRUST_PROXY_CIDRS),
  };
}

export function composeWorker(config: AppConfig, logger: Logger) {
  const dependencies = createDependencies(config, logger);
  const runner = new OutboxWorker(
    new JobRepository(dependencies.database),
    new DeterministicFakeRefundAdapter(),
    systemClock,
    logger,
    { pollMs: config.WORKER_POLL_MS, leaseMs: config.WORKER_LEASE_MS },
  );
  return {
    healthService: dependencies.healthService,
    async connect() {
      await dependencies.connect();
      runner.start();
    },
    async close() {
      await runner.stop();
      await dependencies.close();
    },
    app: createApp(dependencies.healthRouter, logger, false),
  };
}
