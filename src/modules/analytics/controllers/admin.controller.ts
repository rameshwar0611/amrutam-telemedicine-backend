import type { Request, Response } from 'express';
import { actor, context } from '../../identity/controllers/identity.controller.js';
import { sendResult } from '../../../shared/http-result.js';
import { auditQuerySchema, analyticsQuerySchema, jobsQuerySchema } from '../schemas.js';
import type { AdminService } from '../services/admin.service.js';
export class AdminController {
  constructor(private readonly admin: AdminService) {}
  async audit(request: Request, response: Response) {
    sendResult(
      response,
      await this.admin.query(
        actor(response),
        'audit',
        auditQuerySchema.parse(request.query),
        context(response),
      ),
    );
  }
  async analytics(request: Request, response: Response) {
    sendResult(
      response,
      await this.admin.query(
        actor(response),
        'analytics',
        analyticsQuerySchema.parse(request.query),
        context(response),
      ),
    );
  }
  async jobs(request: Request, response: Response) {
    sendResult(
      response,
      await this.admin.query(
        actor(response),
        'jobs',
        jobsQuerySchema.parse(request.query),
        context(response),
      ),
    );
  }
}
