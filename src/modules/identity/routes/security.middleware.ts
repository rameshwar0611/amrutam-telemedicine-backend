import type { ErrorRequestHandler, RequestHandler } from 'express';
import { z } from 'zod';
import { HttpError } from '../../../shared/http-error.js';
import type { RateLimiter, Role, SecretBox } from '../domain/security.js';
import { actor, bearer, context } from '../controllers/identity.controller.js';
import type { AuthorizationService } from '../services/authorization.service.js';

export class SecurityMiddleware {
  constructor(
    private readonly authorization: AuthorizationService,
    private readonly limiter: RateLimiter,
    private readonly secrets: SecretBox,
    private readonly limits: { login: number; ip: number },
  ) {}
  ingress(): RequestHandler {
    return async (request, response, next) => {
      const result = await this.limiter.consume(
        `ingress:ip:${this.secrets.digest(request.ip ?? 'unknown')}`,
        this.limits.ip * 5,
        60,
      );
      if (!result.allowed) {
        if (result.firstDenied)
          await this.authorization.auditDenied(context(response), 'auth.rate_limited');
        throw new HttpError(429, 'RATE_LIMITED', result.retryAfter);
      }
      next();
    };
  }
  authenticated(
    roles: Role[] = ['patient', 'doctor', 'admin'],
    allowRevoked = false,
  ): RequestHandler {
    return async (request, response, next) => {
      let token: string;
      try {
        token = bearer(request);
      } catch (error) {
        await this.authorization.auditDenied(context(response), 'auth.access_denied');
        throw error;
      }
      const principal = await this.authorization.authenticate(
        token,
        context(response),
        allowRevoked,
      );
      await this.authorization.checkRole(principal, roles, context(response));
      response.locals.actor = principal;
      next();
    };
  }
  auditError(): ErrorRequestHandler {
    return async (error: unknown, _request, response, next) => {
      if (error instanceof HttpError && [401, 403].includes(error.status)) {
        const principal = z
          .object({
            userId: z.uuid(),
            sessionId: z.uuid(),
            authVersion: z.number(),
            role: z.enum(['patient', 'doctor', 'admin']),
          })
          .safeParse(response.locals.actor);
        await this.authorization.auditDenied(
          context(response),
          'auth.request_denied',
          principal.success ? principal.data : undefined,
        );
      }
      next(error);
    };
  }
  limited(
    operation: string,
    category: 'register' | 'login' | 'mfa' | 'refresh' | 'read' | 'write' | 'admin' | 'booking',
  ): RequestHandler {
    return async (request, response, next) => {
      const window =
        category === 'register' || category === 'admin'
          ? 3600
          : category === 'login' || category === 'mfa'
            ? 900
            : 60;
      const ipLimit =
        category === 'register'
          ? 5
          : category === 'mfa'
            ? 30
            : category === 'booking'
              ? Math.max(120, this.limits.ip)
              : this.limits.ip;
      const checks = [
        { key: `${operation}:ip:${this.secrets.digest(request.ip ?? 'unknown')}`, limit: ipLimit },
      ];
      if (category === 'login') {
        const parsed = z.object({ email: z.string().max(254) }).safeParse(request.body);
        if (parsed.success)
          checks.push({
            key: `${operation}:account:${this.secrets.digest(parsed.data.email.trim().toLowerCase())}`,
            limit: this.limits.login,
          });
      }
      if (category === 'mfa') {
        const principal = z.object({ userId: z.uuid() }).safeParse(response.locals.actor);
        if (principal.success)
          checks.push({ key: `${operation}:actor:${principal.data.userId}`, limit: 5 });
      }
      if (
        category === 'read' ||
        category === 'write' ||
        category === 'admin' ||
        category === 'booking'
      )
        checks.push({
          key: `${operation}:actor:${actor(response).userId}`,
          limit:
            category === 'admin' ? 10 : category === 'read' || category === 'booking' ? 120 : 30,
        });
      for (const check of checks) {
        const result = await this.limiter.consume(check.key, check.limit, window);
        if (!result.allowed) {
          if (result.firstDenied)
            await this.authorization.auditDenied(context(response), 'auth.rate_limited');
          throw new HttpError(429, 'RATE_LIMITED', result.retryAfter);
        }
      }
      next();
    };
  }
}
