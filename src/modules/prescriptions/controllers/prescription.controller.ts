import type { Request, Response } from 'express';
import { actor, context } from '../../identity/controllers/identity.controller.js';
import { emptySchema } from '../../identity/schemas.js';
import { sendResult, requestKey } from '../../../shared/http-result.js';
import { clinicalParams } from '../../consultations/schemas.js';
import { paginationSchema } from '../../bookings/schemas.js';
import {
  prescriptionParams,
  prescriptionCreateSchema,
  prescriptionEditSchema,
  prescriptionRevokeSchema,
} from '../schemas.js';
import type { PrescriptionService } from '../services/prescription.service.js';
export class PrescriptionController {
  constructor(private readonly prescriptions: PrescriptionService) {}
  async create(request: Request, response: Response) {
    sendResult(
      response,
      await this.prescriptions.create(
        actor(response),
        clinicalParams.parse(request.params).consultationId,
        prescriptionCreateSchema.parse(request.body),
        requestKey(request),
        context(response),
      ),
    );
  }
  async read(request: Request, response: Response) {
    sendResult(
      response,
      await this.prescriptions.read(
        actor(response),
        prescriptionParams.parse(request.params).prescriptionId,
        context(response),
      ),
    );
  }
  async list(request: Request, response: Response) {
    const page = paginationSchema.strict().parse(request.query);
    sendResult(
      response,
      await this.prescriptions.list(
        actor(response),
        clinicalParams.parse(request.params).consultationId,
        page.limit,
        page.offset,
        context(response),
      ),
    );
  }
  async edit(request: Request, response: Response) {
    sendResult(
      response,
      await this.prescriptions.mutate(
        actor(response),
        prescriptionParams.parse(request.params).prescriptionId,
        'edit',
        prescriptionEditSchema.parse(request.body),
        requestKey(request),
        context(response),
      ),
    );
  }
  async finalize(request: Request, response: Response) {
    emptySchema.parse(request.body ?? {});
    sendResult(
      response,
      await this.prescriptions.mutate(
        actor(response),
        prescriptionParams.parse(request.params).prescriptionId,
        'finalize',
        {},
        requestKey(request),
        context(response),
      ),
    );
  }
  async revoke(request: Request, response: Response) {
    sendResult(
      response,
      await this.prescriptions.mutate(
        actor(response),
        prescriptionParams.parse(request.params).prescriptionId,
        'revoke',
        prescriptionRevokeSchema.parse(request.body),
        requestKey(request),
        context(response),
      ),
    );
  }
}
