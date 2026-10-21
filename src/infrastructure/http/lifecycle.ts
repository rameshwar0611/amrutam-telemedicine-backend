import type { Server } from 'node:http';
import type { Express } from 'express';
import type { Logger } from 'pino';

export function listen(app: Express, host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.once('error', reject);
  });
}

export function registerShutdown(options: {
  server: Server;
  logger: Logger;
  timeoutMs: number;
  markUnready: () => void;
  closeDependencies: () => Promise<void>;
}): void {
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    options.markUnready();
    options.logger.info({ event: 'shutdown_started' }, 'Draining connections');
    const deadline = setTimeout(() => {
      options.logger.error({ event: 'shutdown_timeout' }, 'Shutdown deadline exceeded');
      options.server.closeAllConnections();
      process.exit(1);
    }, options.timeoutMs);
    try {
      await new Promise<void>((resolve, reject) =>
        options.server.close((error) => (error ? reject(error) : resolve())),
      );
      await options.closeDependencies();
    } finally {
      clearTimeout(deadline);
    }
  };
  const onSignal = (): void => {
    void stop().catch(() => {
      options.logger.error({ event: 'shutdown_failed' }, 'Graceful shutdown failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
}
