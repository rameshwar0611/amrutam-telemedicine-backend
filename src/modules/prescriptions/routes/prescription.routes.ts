import { Router } from 'express';
import type { SecurityMiddleware } from '../../identity/routes/security.middleware.js';
import type { PrescriptionController } from '../controllers/prescription.controller.js';
export function createPrescriptionRouter(c: PrescriptionController, s: SecurityMiddleware) {
  const r = Router();
  r.post(
    '/consultations/:consultationId/prescriptions',
    s.authenticated(['doctor']),
    s.limited('prescription-create', 'write'),
    c.create.bind(c),
  );
  r.get(
    '/consultations/:consultationId/prescriptions',
    s.authenticated(['doctor', 'patient']),
    s.limited('prescription-history', 'read'),
    c.list.bind(c),
  );
  r.get(
    '/prescriptions/:prescriptionId',
    s.authenticated(['doctor', 'patient']),
    s.limited('prescription-read', 'read'),
    c.read.bind(c),
  );
  r.patch(
    '/prescriptions/:prescriptionId',
    s.authenticated(['doctor']),
    s.limited('prescription-edit', 'write'),
    c.edit.bind(c),
  );
  r.post(
    '/prescriptions/:prescriptionId/finalize',
    s.authenticated(['doctor']),
    s.limited('prescription-finalize', 'write'),
    c.finalize.bind(c),
  );
  r.post(
    '/prescriptions/:prescriptionId/revoke',
    s.authenticated(['doctor']),
    s.limited('prescription-revoke', 'write'),
    c.revoke.bind(c),
  );
  r.use(s.auditError());
  return r;
}
