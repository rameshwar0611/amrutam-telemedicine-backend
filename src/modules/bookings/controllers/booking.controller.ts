import type { Request, Response } from 'express';
import { actor, context } from '../../identity/controllers/identity.controller.js';
import { emptySchema, idempotencyKeySchema } from '../../identity/schemas.js';
import { HttpError } from '../../../shared/http-error.js';
import { z } from 'zod';
import type { ServiceResult } from '../../identity/domain/security.js';
import {
  availabilityQuerySchema,
  bookingCreateSchema,
  cancellationSchema,
  consultationParams,
  doctorParams,
  slotCreateSchema,
  slotParams,
} from '../schemas.js';
import type { BookingService } from '../services/booking.service.js';
const key = (request: Request) => idempotencyKeySchema.parse(request.get('Idempotency-Key'));
const send = (response: Response, result: ServiceResult) => {
  if (result.status >= 400)
    throw new HttpError(result.status, z.object({ code: z.string() }).parse(result.body).code);
  response.status(result.status).json(result.body);
};
export class BookingController {
  constructor(private readonly bookings: BookingService) {}
  async createSlot(request: Request, response: Response) {
    send(
      response,
      await this.bookings.createSlot(
        actor(response),
        doctorParams.parse(request.params).doctorId,
        slotCreateSchema.parse(request.body),
        key(request),
        context(response),
      ),
    );
  }
  async block(request: Request, response: Response) {
    emptySchema.parse(request.body ?? {});
    const params = slotParams.parse(request.params);
    send(
      response,
      await this.bookings.block(
        actor(response),
        params.doctorId,
        params.slotId,
        key(request),
        context(response),
      ),
    );
  }
  async list(request: Request, response: Response) {
    send(
      response,
      await this.bookings.list(
        actor(response),
        doctorParams.parse(request.params).doctorId,
        availabilityQuerySchema.parse(request.query),
      ),
    );
  }
  async book(request: Request, response: Response) {
    send(
      response,
      await this.bookings.book(
        actor(response),
        bookingCreateSchema.parse(request.body).slotId,
        key(request),
        context(response),
      ),
    );
  }
  async cancel(request: Request, response: Response) {
    send(
      response,
      await this.bookings.cancel(
        actor(response),
        consultationParams.parse(request.params).consultationId,
        cancellationSchema.parse(request.body).reason,
        key(request),
        context(response),
      ),
    );
  }
}
