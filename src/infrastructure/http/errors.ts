import { z } from 'zod';
import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { HttpError } from '../../shared/http-error.js';

export const errorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string().uuid() }),
});

export const notFound: RequestHandler = (_request, response) => {
  response.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Resource not found',
      requestId: response.locals.requestId as string,
    },
  });
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, _request, response, next) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const malformed =
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.parse.failed';
    const oversized =
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      error.type === 'entity.too.large';
    const unsupported =
      typeof error === 'object' &&
      error !== null &&
      'type' in error &&
      ['charset.unsupported', 'encoding.unsupported'].includes(String(error.type));
    const status =
      error instanceof HttpError
        ? error.status
        : error instanceof z.ZodError
          ? 400
          : malformed
            ? 400
            : oversized
              ? 413
              : unsupported
                ? 415
                : 500;
    const code =
      error instanceof HttpError
        ? error.code
        : error instanceof z.ZodError
          ? 'VALIDATION_ERROR'
          : malformed
            ? 'INVALID_JSON'
            : oversized
              ? 'PAYLOAD_TOO_LARGE'
              : unsupported
                ? 'UNSUPPORTED_MEDIA_TYPE'
                : 'INTERNAL_ERROR';
    if (error instanceof HttpError && error.retryAfter)
      response.setHeader('Retry-After', error.retryAfter);
    if (status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
    if (status === 500)
      logger.error(
        { event: 'request_failed', requestId: response.locals.requestId },
        'Unhandled request failure',
      );
    response.status(status).json({
      error: {
        code,
        message:
          error instanceof HttpError
            ? ((
                {
                  INVALID_AUTHENTICATION: 'Invalid authentication credentials',
                  RATE_LIMITED: 'Too many requests',
                  FORBIDDEN: 'Access denied',
                  NOT_FOUND: 'Resource not found',
                  SECURITY_DEPENDENCY_UNAVAILABLE: 'Security service temporarily unavailable',
                  IDEMPOTENCY_CONFLICT: 'Idempotency key was used with a different request',
                  IDEMPOTENCY_EXPIRED: 'Use a new idempotency key',
                  RECENT_MFA_REQUIRED: 'Recent MFA authentication required',
                } as Record<string, string>
              )[error.code] ?? 'Request cannot be completed')
            : error instanceof z.ZodError
              ? 'Request validation failed'
              : malformed
                ? 'Invalid JSON body'
                : oversized
                  ? 'Request body too large'
                  : 'An unexpected error occurred',
        requestId: response.locals.requestId as string,
      },
    });
  };
}
