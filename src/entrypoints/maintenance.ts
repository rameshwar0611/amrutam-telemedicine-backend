import { setTimeout as delay } from 'node:timers/promises';
import { loadDatabaseConfig } from '../infrastructure/config/env.js';
import { createPool } from '../infrastructure/database/client.js';
import { createLogger } from '../infrastructure/logging/logger.js';
import { startTelemetry } from '../infrastructure/telemetry/runtime.js';
const abort = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => abort.abort());
async function main() {
  const telemetry = await startTelemetry('maintenance');
  const pool = createPool(loadDatabaseConfig());
  const logger = createLogger();
  try {
    do {
      const partitions = await pool.query<{ result: unknown }>(
        'SELECT maintain_audit_partitions() AS result',
      );
      const cleanup = await pool.query<{ result: unknown }>(
        'SELECT cleanup_security_records(500) AS result',
      );
      logger.info(
        {
          event: 'maintenance_completed',
          partitions: partitions.rows[0]?.result,
          cleanup: cleanup.rows[0]?.result,
        },
        'Maintenance completed',
      );
      if (!process.argv.includes('--loop')) break;
      try {
        await delay(3600000, undefined, { signal: abort.signal });
      } catch {
        if (!abort.signal.aborted) throw new Error('Maintenance timer failed');
      }
    } while (!abort.signal.aborted);
  } finally {
    await pool.end();
    await telemetry.shutdown();
  }
}
main().catch(() => {
  process.stderr.write('Maintenance failed; inspect safe operational counters.\n');
  process.exitCode = 1;
});
