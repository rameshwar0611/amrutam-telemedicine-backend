import type { Request, Response } from 'express';
import { actor, context } from '../../identity/controllers/identity.controller.js';
import { sendResult, requestKey } from '../../../shared/http-result.js';
import { clinicalParams } from '../../consultations/schemas.js';
import { paginationSchema } from '../../bookings/schemas.js';
import { paymentCreateSchema, paymentParams, paymentTransitionSchema } from '../schemas.js';
import type { PaymentService } from '../services/payment.service.js';
export class PaymentController {
  constructor(private readonly payments: PaymentService) {}
  async create(request: Request, response: Response) {
    sendResult(
      response,
      await this.payments.create(
        actor(response),
        clinicalParams.parse(request.params).consultationId,
        paymentCreateSchema.parse(request.body),
        requestKey(request),
        context(response),
      ),
    );
  }
  async list(request: Request, response: Response) {
    const page = paginationSchema.strict().parse(request.query);
    sendResult(
      response,
      await this.payments.list(
        actor(response),
        clinicalParams.parse(request.params).consultationId,
        page.limit,
        page.offset,
        context(response),
      ),
    );
  }
  async transition(request: Request, response: Response) {
    sendResult(
      response,
      await this.payments.transition(
        actor(response),
        paymentParams.parse(request.params).paymentId,
        paymentTransitionSchema.parse(request.body).status,
        requestKey(request),
        context(response),
      ),
    );
  }
}
