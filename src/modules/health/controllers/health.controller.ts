import type { Request, Response } from 'express';
import type { HealthService } from '../services/health.service.js';

export class HealthController {
  constructor(private readonly service: HealthService) {}

  live(_request: Request, response: Response): void {
    response.json({ status: 'alive' });
  }

  async ready(_request: Request, response: Response): Promise<void> {
    const result = await this.service.readiness();
    response.status(result.status === 'ready' ? 200 : 503).json(result);
  }
}
