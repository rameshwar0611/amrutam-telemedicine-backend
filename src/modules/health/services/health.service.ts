import type { Readiness } from '../schemas.js';
import { withTimeout } from '../../../shared/timeout.js';

export interface DependencyProbe {
  ping(): Promise<void>;
}

export class HealthService {
  private acceptingRequests = true;

  constructor(
    private readonly postgres: DependencyProbe,
    private readonly redis: DependencyProbe,
  ) {}

  markUnready(): void {
    this.acceptingRequests = false;
  }

  async readiness(): Promise<Readiness> {
    const [postgres, redis] = await Promise.allSettled([
      withTimeout(this.postgres.ping(), 2000),
      withTimeout(this.redis.ping(), 2000),
    ]);
    return {
      status:
        this.acceptingRequests && postgres.status === 'fulfilled' && redis.status === 'fulfilled'
          ? 'ready'
          : 'not_ready',
      dependencies: {
        postgres: postgres.status === 'fulfilled' ? 'up' : 'down',
        redis: redis.status === 'fulfilled' ? 'up' : 'down',
      },
    };
  }
}
