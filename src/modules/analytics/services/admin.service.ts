import { z } from 'zod';
import type { UnitOfWork } from '../../../shared/ports/unit-of-work.js';
import { HttpError } from '../../../shared/http-error.js';
import { toJson } from '../../../shared/json.js';
import type { SecurityRepositories } from '../../identity/domain/ports.js';
import type { Actor, RequestContext } from '../../identity/domain/security.js';
import type { AuthorizationService } from '../../identity/services/authorization.service.js';
import type { AdminStore } from '../domain/ports.js';
import type { AuditQuery, AnalyticsQuery, JobsQuery } from '../schemas.js';
export interface AdminRepositories extends SecurityRepositories {
  admin: AdminStore;
}
const utilization = z.array(
  z.object({
    doctorId: z.uuid(),
    name: z.string(),
    offeredSeconds: z.number().nonnegative(),
    bookedSeconds: z.number().nonnegative(),
    utilization: z.number().min(0).max(1),
  }),
);
export class AdminService {
  constructor(
    private readonly work: UnitOfWork<AdminRepositories>,
    private readonly auth: AuthorizationService,
  ) {}
  async query(
    actor: Actor,
    kind: 'audit' | 'analytics' | 'jobs',
    query: AuditQuery | AnalyticsQuery | JobsQuery,
    context: RequestContext,
  ) {
    if (actor.role !== 'admin') throw new HttpError(403, 'FORBIDDEN');
    return this.work.run(async (r) => {
      await this.auth.require(r, actor, { recent: true });
      let body: unknown;
      if (kind === 'analytics') {
        const result = await r.admin.analytics(query);
        const doctors = utilization.parse(result.doctors);
        body = {
          from: query.from,
          to: query.to,
          asOf: result.as_of.toISOString(),
          totals: z
            .object({
              bookings: z.number().int().nonnegative(),
              completed: z.number().int().nonnegative(),
              cancellations: z.number().int().nonnegative(),
              noShows: z.number().int().nonnegative(),
            })
            .parse(result.totals),
          doctors: doctors.slice(0, query.limit),
          limit: query.limit,
          offset: query.offset,
          hasMore: doctors.length > query.limit,
        };
      } else {
        const rows = kind === 'audit' ? await r.admin.audit(query) : await r.admin.jobs(query);
        body = {
          items: rows.slice(0, query.limit),
          limit: query.limit,
          offset: query.offset,
          hasMore: rows.length > query.limit,
        };
      }
      await r.audit.append({
        actorId: actor.userId,
        action: `admin.${kind}_accessed`,
        resourceType:
          kind === 'analytics' ? 'analytics' : kind === 'audit' ? 'audit_log' : 'outbox_job',
        resourceId: null,
        outcome: 'success',
        requestId: context.requestId,
      });
      return { status: 200, body: toJson(body) };
    });
  }
}
