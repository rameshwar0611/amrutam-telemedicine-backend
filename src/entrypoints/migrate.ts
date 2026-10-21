import { loadDatabaseConfig } from '../infrastructure/config/env.js';
import { createPool } from '../infrastructure/database/client.js';
import { migrate } from '../infrastructure/database/migrator.js';

async function main(): Promise<void> {
  const direction = process.argv[2] ?? 'up';
  if (!['up', 'down', 'status'].includes(direction)) throw new Error('Use up, down, or status');
  if (direction === 'down' && process.env.ALLOW_DESTRUCTIVE_MIGRATIONS !== 'true') {
    throw new Error('Rollback requires ALLOW_DESTRUCTIVE_MIGRATIONS=true');
  }
  const pool = createPool(loadDatabaseConfig());
  try {
    const status = await migrate(pool, direction as 'up' | 'down' | 'status');
    for (const migration of status)
      process.stdout.write(`${migration.version}: ${migration.applied ? 'applied' : 'pending'}\n`);
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write(
    'Migration command failed. Check configuration, database access, migration history and SQL.\n',
  );
  process.exitCode = 1;
});
