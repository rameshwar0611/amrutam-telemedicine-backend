import type { RedisClientType } from 'redis';
import type { DirectoryCache } from '../../modules/doctors/domain/ports.js';
import { withTimeout } from '../../shared/timeout.js';
export class RedisDirectoryCache implements DirectoryCache {
  constructor(private readonly redis: RedisClientType) {}
  async get(key: string) {
    return withTimeout(this.redis.get(key), 100);
  }
  async set(key: string, value: string, ttl: number) {
    await withTimeout(this.redis.set(key, value, { EX: ttl }), 100);
  }
}
