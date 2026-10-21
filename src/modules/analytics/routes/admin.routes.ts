import { Router } from 'express';
import type { SecurityMiddleware } from '../../identity/routes/security.middleware.js';
import type { AdminController } from '../controllers/admin.controller.js';
export function createAdminRouter(c: AdminController, s: SecurityMiddleware) {
  const r = Router();
  r.get(
    '/admin/audit-logs',
    s.authenticated(['admin']),
    s.limited('audit-query', 'read'),
    c.audit.bind(c),
  );
  r.get(
    '/admin/analytics',
    s.authenticated(['admin']),
    s.limited('analytics-query', 'read'),
    c.analytics.bind(c),
  );
  r.get('/admin/jobs', s.authenticated(['admin']), s.limited('job-query', 'read'), c.jobs.bind(c));
  r.use(s.auditError());
  return r;
}
