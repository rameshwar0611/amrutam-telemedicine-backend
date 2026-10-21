import { Router } from 'express';
import type { SecurityMiddleware } from '../../identity/routes/security.middleware.js';
import type { DiscoveryController } from '../controllers/discovery.controller.js';
export function createDiscoveryRouter(
  controller: DiscoveryController,
  security: SecurityMiddleware,
) {
  const router = Router();
  router.get(
    '/doctors',
    security.authenticated(),
    security.limited('doctor-discovery', 'read'),
    controller.search.bind(controller),
  );
  router.use(security.auditError());
  return router;
}
