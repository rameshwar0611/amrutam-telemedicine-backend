import { Router } from 'express';
import type { SecurityMiddleware } from '../../identity/routes/security.middleware.js';
import type { PaymentController } from '../controllers/payment.controller.js';
export function createPaymentRouter(c: PaymentController, s: SecurityMiddleware) {
  const r = Router();
  r.post(
    '/consultations/:consultationId/payments',
    s.authenticated(['admin']),
    s.limited('payment-create', 'write'),
    c.create.bind(c),
  );
  r.get(
    '/consultations/:consultationId/payments',
    s.authenticated(['admin', 'patient']),
    s.limited('payment-read', 'read'),
    c.list.bind(c),
  );
  r.post(
    '/payments/:paymentId/transitions',
    s.authenticated(['admin']),
    s.limited('payment-transition', 'write'),
    c.transition.bind(c),
  );
  r.use(s.auditError());
  return r;
}
