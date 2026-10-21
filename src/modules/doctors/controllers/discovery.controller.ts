import type { Request, Response } from 'express';
import { actor } from '../../identity/controllers/identity.controller.js';
import { discoveryQuerySchema } from '../schemas.js';
import type { DiscoveryService } from '../services/discovery.service.js';
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}
  async search(request: Request, response: Response) {
    response.json(
      await this.discovery.search(actor(response), discoveryQuerySchema.parse(request.query)),
    );
  }
}
