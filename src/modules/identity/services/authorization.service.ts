import type { UnitOfWork } from '../../../shared/ports/unit-of-work.js';
import { HttpError } from '../../../shared/http-error.js';
import type { SecurityRepositories } from '../domain/ports.js';
import type { Actor, Clock, RequestContext, Role, TokenIssuer } from '../domain/security.js';

export class AuthorizationService {
  constructor(
    private readonly work: UnitOfWork<SecurityRepositories>,
    private readonly tokens: TokenIssuer,
    private readonly clock: Clock,
  ) {}
  async require(
    repositories: SecurityRepositories,
    actor: Actor,
    options: { allowRevoked?: boolean; recent?: boolean } = {},
  ) {
    const user = await repositories.identity.userById(actor.userId, true);
    const session = await repositories.identity.session(actor.sessionId, true);
    if (
      !user ||
      user.status !== 'active' ||
      user.auth_version !== actor.authVersion ||
      user.role !== actor.role ||
      !session ||
      session.user_id !== user.id ||
      (!options.allowRevoked && session.revoked_at) ||
      session.expires_at <= this.clock.now() ||
      !session.mfa_verified_at ||
      !user.activated_at
    )
      throw new HttpError(401, 'INVALID_AUTHENTICATION');
    if (options.recent && this.clock.now().getTime() - session.mfa_verified_at.getTime() > 300000)
      throw new HttpError(403, 'RECENT_MFA_REQUIRED');
    return { user, session, actor };
  }
  async authenticate(token: string, context: RequestContext, allowRevoked = false): Promise<Actor> {
    try {
      const actor = await this.tokens.verifyAccess(token);
      await this.work.run((repositories) => this.require(repositories, actor, { allowRevoked }));
      return actor;
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      await this.auditDenied(context, 'auth.access_denied');
      throw error;
    }
  }
  async checkRole(actor: Actor, roles: Role[], context: RequestContext): Promise<void> {
    if (!roles.includes(actor.role)) {
      await this.auditDenied(context, 'auth.role_denied', actor);
      throw new HttpError(403, 'FORBIDDEN');
    }
  }
  async auditDenied(context: RequestContext, action: string, actor?: Actor): Promise<void> {
    await this.work.run((repositories) =>
      repositories.audit.append({
        actorId: actor?.userId ?? null,
        action,
        resourceType: 'user',
        resourceId: actor?.userId ?? null,
        outcome: 'denied',
        requestId: context.requestId,
      }),
    );
  }
}
