import { createClient } from 'redis';
import type { Logger } from 'pino';

export function createRedisClient(url: string, logger: Logger) {
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: { connectTimeout: 5000, reconnectStrategy: (attempt) => Math.min(attempt * 100, 1000) },
  });
  client.on('error', () => logger.warn({ event: 'redis_connection_error' }, 'Redis unavailable'));
  return client;
}

export type RedisConnection = ReturnType<typeof createRedisClient>;
