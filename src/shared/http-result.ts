import type { Request, Response } from 'express';
import { z } from 'zod';
import { idempotencyKeySchema } from '../modules/identity/schemas.js';
import type { ServiceResult } from '../modules/identity/domain/security.js';
import { HttpError } from './http-error.js';
export const requestKey = (request: Request) =>
  idempotencyKeySchema.parse(request.get('Idempotency-Key'));
export function sendResult(response: Response, result: ServiceResult) {
  if (result.status >= 400)
    throw new HttpError(result.status, z.object({ code: z.string() }).parse(result.body).code);
  response.status(result.status).json(result.body);
}
