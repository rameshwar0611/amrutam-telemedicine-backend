import type { Request, Response } from 'express';
import { z } from 'zod';
import { HttpError } from '../../../shared/http-error.js';
import type { ServiceResult } from '../domain/security.js';
import {
  activateSchema,
  actorSchema,
  deactivateSchema,
  emptySchema,
  idempotencyKeySchema,
  loginSchema,
  otpSchema,
  passwordChangeSchema,
  profilePatchSchema,
  provisionSchema,
  recoveryRegenerateSchema,
  refreshSchema,
  registerSchema,
  sessionIdParams,
  statusChangeSchema,
  userIdParams,
  verifyMfaSchema,
} from '../schemas.js';
import type { AccountService } from '../services/account.service.js';
import type { AuthenticationService } from '../services/authentication.service.js';
import type { MfaService } from '../services/mfa.service.js';

export const context = (response: Response) => ({
  requestId: z.uuid().parse(response.locals.requestId),
});
export const actor = (response: Response) => actorSchema.parse(response.locals.actor);
export function bearer(request: Request): string {
  const header = request.get('Authorization');
  const match = header && /^Bearer ([^\s]{1,8192})$/i.exec(header);
  if (!match?.[1]) throw new HttpError(401, 'INVALID_AUTHENTICATION');
  return match[1];
}
const key = (request: Request) => idempotencyKeySchema.parse(request.get('Idempotency-Key'));
const send = (response: Response, result: ServiceResult): void => {
  if (result.status >= 400)
    throw new HttpError(result.status, z.object({ code: z.string() }).parse(result.body).code);
  if (result.status === 204) {
    response.status(204).end();
    return;
  }
  response.status(result.status).json(result.body);
};

export class IdentityController {
  constructor(
    private readonly accounts: AccountService,
    private readonly authentication: AuthenticationService,
    private readonly mfa: MfaService,
  ) {}
  async register(request: Request, response: Response) {
    send(
      response,
      await this.accounts.register(
        registerSchema.parse(request.body),
        key(request),
        context(response),
      ),
    );
  }
  async activate(request: Request, response: Response) {
    send(
      response,
      await this.accounts.activate(
        activateSchema.parse(request.body),
        key(request),
        context(response),
      ),
    );
  }
  async login(request: Request, response: Response) {
    send(
      response,
      await this.authentication.login(
        loginSchema.parse(request.body),
        key(request),
        context(response),
      ),
    );
  }
  async refresh(request: Request, response: Response) {
    send(
      response,
      await this.authentication.refresh(
        refreshSchema.parse(request.body).refreshToken,
        key(request),
        context(response),
      ),
    );
  }
  async logout(request: Request, response: Response) {
    emptySchema.parse(request.body ?? {});
    send(
      response,
      await this.authentication.logout(actor(response), key(request), context(response)),
    );
  }
  async enroll(request: Request, response: Response) {
    emptySchema.parse(request.body ?? {});
    send(response, await this.mfa.enroll(bearer(request), key(request), context(response)));
  }
  async confirm(request: Request, response: Response) {
    send(
      response,
      await this.mfa.confirm(
        bearer(request),
        otpSchema.parse(request.body).code,
        key(request),
        context(response),
      ),
    );
  }
  async verify(request: Request, response: Response) {
    send(
      response,
      await this.mfa.verify(
        bearer(request),
        verifyMfaSchema.parse(request.body),
        key(request),
        context(response),
      ),
    );
  }
  async profile(request: Request, response: Response) {
    send(
      response,
      await this.accounts.profile(
        actor(response),
        request.params.userId ? userIdParams.parse(request.params).userId : actor(response).userId,
        context(response),
      ),
    );
  }
  async patchProfile(request: Request, response: Response) {
    send(
      response,
      await this.accounts.updateProfile(
        actor(response),
        request.params.userId ? userIdParams.parse(request.params).userId : actor(response).userId,
        profilePatchSchema.parse(request.body),
        key(request),
        context(response),
      ),
    );
  }
  async password(request: Request, response: Response) {
    send(
      response,
      await this.accounts.passwordChange(
        actor(response),
        passwordChangeSchema.parse(request.body),
        key(request),
        context(response),
      ),
    );
  }
  async deactivate(request: Request, response: Response) {
    send(
      response,
      await this.accounts.deactivate(
        actor(response),
        deactivateSchema.parse(request.body).password,
        key(request),
        context(response),
      ),
    );
  }
  async sessions(_request: Request, response: Response) {
    send(response, await this.authentication.listSessions(actor(response)));
  }
  async revoke(request: Request, response: Response) {
    send(
      response,
      await this.authentication.revoke(
        actor(response),
        sessionIdParams.parse(request.params).sessionId,
        key(request),
        context(response),
      ),
    );
  }
  async provision(request: Request, response: Response) {
    send(
      response,
      await this.accounts.provision(
        actor(response),
        provisionSchema.parse(request.body),
        key(request),
        context(response),
      ),
    );
  }
  async status(request: Request, response: Response) {
    send(
      response,
      await this.accounts.changeStatus(
        actor(response),
        userIdParams.parse(request.params).userId,
        statusChangeSchema.parse(request.body).status,
        key(request),
        context(response),
      ),
    );
  }
  async recovery(request: Request, response: Response) {
    const input = recoveryRegenerateSchema.parse(request.body);
    send(
      response,
      await this.mfa.regenerateRecovery(
        actor(response),
        input.password,
        input.code,
        key(request),
        context(response),
      ),
    );
  }
}
