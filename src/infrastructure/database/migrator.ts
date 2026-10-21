import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Pool, PoolClient } from 'pg';

interface Migration {
  version: string;
  up: string;
  down: string;
  checksum: string;
}
interface AppliedMigration {
  version: string;
  checksum: string;
}
export interface MigrationStatus {
  version: string;
  applied: boolean;
}
export type MigrationDirection = 'up' | 'down' | 'status';

export async function readMigrations(directory: string): Promise<Migration[]> {
  const files = await readdir(directory);
  const upFiles = files.filter((name) => /^\d{4}_[a-z0-9_]+\.up\.sql$/.test(name)).sort();
  const migrations: Migration[] = [];
  for (const filename of upFiles) {
    const version = filename.replace('.up.sql', '');
    const [up, down] = await Promise.all([
      readFile(resolve(directory, filename), 'utf8'),
      readFile(resolve(directory, `${version}.down.sql`), 'utf8'),
    ]);
    migrations.push({
      version,
      up,
      down,
      checksum: createHash('sha256').update(`${up}\0${down}`).digest('hex'),
    });
  }
  if (migrations.length === 0) throw new Error('No migration files found');
  const numbers = migrations.map((migration) => migration.version.slice(0, 4));
  if (new Set(numbers).size !== numbers.length) throw new Error('Duplicate migration version');
  if (files.filter((name) => name.endsWith('.down.sql')).length !== migrations.length) {
    throw new Error('Migration up/down files must be paired');
  }
  return migrations;
}

async function applyMigration(
  client: PoolClient,
  migration: Migration,
  direction: 'up' | 'down',
): Promise<void> {
  await client.query('BEGIN');
  try {
    await client.query(direction === 'up' ? migration.up : migration.down);
    if (direction === 'up') {
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        migration.version,
        migration.checksum,
      ]);
    } else {
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** One dedicated connection holds the advisory lock across all migration transactions. */
export async function migrate(
  pool: Pool,
  direction: MigrationDirection,
  directory = resolve(process.cwd(), 'migrations'),
): Promise<MigrationStatus[]> {
  const migrations = await readMigrations(directory);
  const client = await pool.connect();
  try {
    await client.query("SET lock_timeout = '10s'");
    await client.query('SELECT pg_advisory_lock(174230, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const result = await client.query<AppliedMigration>(
      'SELECT version, checksum FROM schema_migrations ORDER BY version',
    );
    for (const [index, applied] of result.rows.entries()) {
      const source = migrations[index];
      if (!source || source.version !== applied.version || source.checksum !== applied.checksum) {
        throw new Error('Migration history differs from source; do not edit applied migrations');
      }
    }
    if (direction === 'up') {
      for (const migration of migrations.slice(result.rows.length))
        await applyMigration(client, migration, 'up');
    } else if (direction === 'down') {
      const lastApplied = migrations[result.rows.length - 1];
      if (lastApplied) await applyMigration(client, lastApplied, 'down');
    }
    const applied = await client.query<AppliedMigration>(
      'SELECT version, checksum FROM schema_migrations',
    );
    const versions = new Set(applied.rows.map((row) => row.version));
    return migrations.map((migration) => ({
      version: migration.version,
      applied: versions.has(migration.version),
    }));
  } finally {
    // release(true) closes the connection even after a failed unlock, preventing a leaked lock.
    try {
      await client.query('SELECT pg_advisory_unlock(174230, 1)');
    } finally {
      client.release(true);
    }
  }
}
