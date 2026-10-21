import { recordDatabase } from '../telemetry/runtime.js';
import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { DatabaseConfig } from '../config/env.js';
import type { Database } from './types.js';

export function createPool(config: DatabaseConfig): pg.Pool {
  return new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: config.DATABASE_POOL_MAX,
    connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 10_000,
    statement_timeout: config.DATABASE_STATEMENT_TIMEOUT_MS,
    application_name: 'amrutam-backend',
    ssl:
      config.DATABASE_SSL_MODE === 'verify-full'
        ? {
            rejectUnauthorized: true,
            ...(config.DATABASE_CA_CERT ? { ca: config.DATABASE_CA_CERT } : {}),
          }
        : false,
  });
}

export function createDatabase(pool: pg.Pool): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool }),
    log: (event) =>
      recordDatabase(event.query.sql, event.queryDurationMillis, event.level === 'error'),
  });
}
