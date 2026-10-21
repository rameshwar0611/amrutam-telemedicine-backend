import { startTelemetry } from '../infrastructure/telemetry/runtime.js';
import { composeWorker } from '../composition-root.js';
import { loadConfig } from '../infrastructure/config/env.js';
import { createLogger } from '../infrastructure/logging/logger.js';
import { listen, registerShutdown } from '../infrastructure/http/lifecycle.js';

async function main(): Promise<void> {
  const telemetry = await startTelemetry('worker');
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const application = composeWorker(config, logger);
  try {
    await application.connect();
    const server = await listen(application.app, config.HOST, config.WORKER_HEALTH_PORT);
    registerShutdown({
      server,
      logger,
      timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
      markUnready: () => application.healthService.markUnready(),
      closeDependencies: async () => {
        await application.close();
        await telemetry.shutdown();
      },
    });
    logger.info(
      { event: 'worker_started', consumesJobs: true, paymentMode: 'internal_fake' },
      'Outbox worker ready',
    );
  } catch {
    await application.close();
    await telemetry.shutdown();
    throw new Error('Worker startup failed');
  }
}

main().catch(() => {
  process.stderr.write('Worker startup failed; check validated configuration and dependencies.\n');
  process.exitCode = 1;
});
