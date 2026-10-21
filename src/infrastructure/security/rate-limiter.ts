import type { RedisConnection } from '../redis/client.js';
import type { RateLimiter } from '../../modules/identity/domain/security.js';
import { HttpError } from '../../shared/http-error.js';
import { withTimeout } from '../../shared/timeout.js';

const script = `local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}`;

export class RedisRateLimiter implements RateLimiter {
  constructor(private readonly redis: Pick<RedisConnection, 'eval'>) {}
  async consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; retryAfter: number; firstDenied: boolean }> {
    try {
      const result = await withTimeout(
        this.redis.eval(script, {
          keys: [`amrutam:limit:${key}`],
          arguments: [String(windowSeconds * 1000)],
        }),
        2000,
      );
      if (!Array.isArray(result) || result.length !== 2)
        throw new Error('Invalid limiter response');
      return {
        allowed: Number(result[0]) <= limit,
        firstDenied: Number(result[0]) === limit + 1,
        retryAfter: Math.max(1, Math.ceil(Number(result[1]) / 1000)),
      };
    } catch {
      throw new HttpError(503, 'SECURITY_DEPENDENCY_UNAVAILABLE');
    }
  }
}
