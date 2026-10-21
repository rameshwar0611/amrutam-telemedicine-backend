import { startTelemetry } from '../infrastructure/telemetry/runtime.js';
import { composeApi } from '../composition-root.js';
import { loadConfig } from '../infrastructure/config/env.js';
import { loadSecurityConfig } from '../infrastructure/config/security-env.js';
import { createLogger } from '../infrastructure/logging/logger.js';
import { listen, registerShutdown } from '../infrastructure/http/lifecycle.js';

async function main(): Promise<void> {
  const telemetry = await startTelemetry('api');
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const application = composeApi(config, logger, loadSecurityConfig());
  try {
    await application.connect();
    const server = await listen(application.app, config.HOST, config.PORT);
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
    logger.info({ event: 'api_started', port: config.PORT }, 'Identity API started');
  } catch {
    await application.close();
    await telemetry.shutdown();
    throw new Error('API startup failed');
  }
}

main().catch(() => {
  process.stderr.write('API startup failed; check validated configuration and dependencies.\n');
  process.exitCode = 1;
});
