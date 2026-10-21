import { Router } from 'express';
import type { HealthController } from '../controllers/health.controller.js';

export function createHealthRouter(controller: HealthController): Router {
  const router = Router();
  router.get('/live', controller.live.bind(controller));
  router.get('/ready', controller.ready.bind(controller));
  return router;
}
