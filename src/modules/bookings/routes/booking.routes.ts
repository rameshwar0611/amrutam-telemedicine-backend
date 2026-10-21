import { Router } from 'express';
import type { BookingController } from '../controllers/booking.controller.js';
import type { SecurityMiddleware } from '../../identity/routes/security.middleware.js';
export function createBookingRouter(controller: BookingController, security: SecurityMiddleware) {
  const router = Router();
  router.get(
    '/doctors/:doctorId/availability',
    security.authenticated(),
    security.limited('availability-read', 'read'),
    controller.list.bind(controller),
  );
  router.post(
    '/doctors/:doctorId/availability',
    security.authenticated(['doctor']),
    security.limited('availability-create', 'write'),
    controller.createSlot.bind(controller),
  );
  router.patch(
    '/doctors/:doctorId/availability/:slotId/block',
    security.authenticated(['doctor']),
    security.limited('availability-block', 'write'),
    controller.block.bind(controller),
  );
  router.post(
    '/consultations',
    security.authenticated(['patient']),
    security.limited('consultation-book', 'booking'),
    controller.book.bind(controller),
  );
  router.post(
    '/consultations/:consultationId/cancel',
    security.authenticated(),
    security.limited('consultation-cancel', 'booking'),
    controller.cancel.bind(controller),
  );
  router.use(security.auditError());
  return router;
}
