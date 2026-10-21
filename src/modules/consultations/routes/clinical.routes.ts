import { Router } from 'express';
import type { SecurityMiddleware } from '../../identity/routes/security.middleware.js';
import type { ClinicalController } from '../controllers/clinical.controller.js';
export function createClinicalRouter(controller: ClinicalController, security: SecurityMiddleware) {
  const r = Router();
  r.get(
    '/consultations/:consultationId',
    security.authenticated(['patient', 'doctor']),
    security.limited('clinical-read', 'read'),
    controller.read.bind(controller),
  );
  r.get(
    '/consultations/:consultationId/notes',
    security.authenticated(['patient', 'doctor']),
    security.limited('notes-read', 'read'),
    controller.notes.bind(controller),
  );
  r.put(
    '/consultations/:consultationId/notes',
    security.authenticated(['doctor']),
    security.limited('notes-write', 'write'),
    controller.writeNotes.bind(controller),
  );
  r.post(
    '/consultations/:consultationId/transitions',
    security.authenticated(['doctor']),
    security.limited('clinical-transition', 'write'),
    controller.transition.bind(controller),
  );
  r.use(security.auditError());
  return r;
}
