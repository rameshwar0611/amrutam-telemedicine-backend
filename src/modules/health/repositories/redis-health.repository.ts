import type { RedisConnection } from '../../../infrastructure/redis/client.js';
import type { DependencyProbe } from '../services/health.service.js';

export class RedisHealthRepository implements DependencyProbe {
  constructor(private readonly redis: RedisConnection) {}

  async ping(): Promise<void> {
    await this.redis.ping();
  }
}
