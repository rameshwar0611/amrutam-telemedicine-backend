import { z } from 'zod';
import type { UnitOfWork } from '../../../shared/ports/unit-of-work.js';
import type { SecurityRepositories } from '../domain/ports.js';
import {
  failure,
  type Actor,
  type Clock,
  type Passwords,
  type RequestContext,
  type SecretBox,
  type SecuritySettings,
  type ServiceResult,
  type TokenIssuer,
} from '../domain/security.js';
import type { LoginInput } from '../schemas.js';
import type { IdempotencyService } from './idempotency.service.js';
import type { AuthorizationService } from './authorization.service.js';
import type { SessionService } from './session.service.js';

export class AuthenticationService {
  constructor(
    private readonly work: UnitOfWork<SecurityRepositories>,
    private readonly passwords: Passwords,
    private readonly secrets: SecretBox,
    private readonly tokens: TokenIssuer,
    private readonly idempotency: IdempotencyService,
    private readonly authorization: AuthorizationService,
    private readonly sessions: SessionService,
    private readonly clock: Clock,
    private readonly settings: SecuritySettings,
  ) {}
  async login(input: LoginInput, key: string, context: RequestContext): Promise<ServiceResult> {
    const candidate = await this.work.run((repositories) =>
      repositories.identity.userByEmail(input.email),
    );
    const verified = await this.passwords.verify(input.password, candidate?.password_hash ?? null);
    return this.work.run(async (repositories) => {
      const user = candidate ? await repositories.identity.userById(candidate.id, true) : undefined;
      if (
        !verified ||
        !user ||
        user.password_hash !== candidate?.password_hash ||
        !user.activated_at ||
        !['pending_mfa', 'active'].includes(user.status)
      ) {
        await repositories.audit.append({
          actorId: null,
          action: 'auth.login_failed',
          resourceType: 'user',
          resourceId: null,
          outcome: 'failure',
          requestId: context.requestId,
        });
        return failure();
      }
      const result = await this.idempotency.execute(
        repositories,
        {
          actorId: user.id,
          scope: `login:${user.id}:${user.auth_version}`,
          key,
          payload: input,
          ttl: this.settings.challengeTtl,
        },
        async () => {
          const challenge = await this.sessions.challenge(repositories, user);
          await repositories.audit.append({
            actorId: user.id,
            action: 'auth.password_verified',
            resourceType: 'user',
            resourceId: user.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return challenge;
        },
      );
      const body = z.object({ challengeToken: z.string() }).parse(result.body);
      const challenge = await this.tokens.verifyChallenge(body.challengeToken);
      const flow = await repositories.identity.flow(challenge.flowId);
      return flow && !flow.consumed_at && flow.attempts < 5 ? result : failure();
    });
  }
  async refresh(
    refreshToken: string,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    const id = refreshToken.split('.')[0];
    if (!id || !z.uuid().safeParse(id).success) return failure();
    const hash = this.secrets.digest(`refresh:${refreshToken}`);
    return this.work.run(async (repositories) => {
      const candidate = await repositories.identity.session(id);
      const user = candidate
        ? await repositories.identity.userById(candidate.user_id, true)
        : undefined;
      const session = candidate
        ? await repositories.identity.session(candidate.id, true)
        : undefined;
      const reject = async (): Promise<ServiceResult> => {
        await repositories.audit.append({
          actorId: null,
          action: 'auth.refresh_failed',
          resourceType: 'session',
          resourceId: null,
          outcome: 'failure',
          requestId: context.requestId,
        });
        return failure();
      };
      if (
        !user ||
        user.status !== 'active' ||
        !user.activated_at ||
        !session ||
        session.revoked_at ||
        !session.mfa_verified_at ||
        session.expires_at <= this.clock.now()
      )
        return reject();
      const scope = `refresh:${session.id}:${hash}`;
      const payload = { refreshToken };
      if (!this.secrets.equal(hash, session.refresh_token_hash)) {
        if (!(await repositories.identity.refreshWasUsed(session.id, hash))) return reject();
        const record = await repositories.idempotency.find(scope, key);
        if (
          !record ||
          record.status !== 'completed' ||
          record.expires_at <= this.clock.now() ||
          record.request_fingerprint !== this.idempotency.fingerprint(payload)
        ) {
          await repositories.identity.revokeFamily(session.family_id, this.clock.now());
          await repositories.audit.append({
            actorId: user.id,
            action: 'auth.refresh_reuse_detected',
            resourceType: 'session',
            resourceId: session.id,
            outcome: 'denied',
            requestId: context.requestId,
          });
          return failure();
        }
      }
      const result = await this.idempotency.execute(
        repositories,
        { actorId: user.id, scope, key, payload, ttl: this.settings.retryTtl },
        async () => {
          if (!this.secrets.equal(hash, session.refresh_token_hash)) return failure();
          const next = `${session.id}.${this.secrets.randomToken()}`;
          await repositories.identity.rotateSession(
            session.id,
            hash,
            this.secrets.digest(`refresh:${next}`),
            new Date(this.clock.now().getTime() + this.settings.retryTtl * 1000),
          );
          await repositories.audit.append({
            actorId: user.id,
            action: 'auth.refresh_rotated',
            resourceType: 'session',
            resourceId: session.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return this.sessions.issue(user, session.id, next, session.expires_at);
        },
      );
      return this.sessions.validateReplay(repositories, user.id, result);
    });
  }
  async logout(actor: Actor, key: string, context: RequestContext): Promise<ServiceResult> {
    return this.work.run(async (repositories) => {
      await this.authorization.require(repositories, actor, { allowRevoked: true });
      return this.idempotency.execute(
        repositories,
        { actorId: actor.userId, scope: `logout:${actor.sessionId}`, key, payload: {}, ttl: 86400 },
        async () => {
          await repositories.identity.revokeSession(actor.sessionId, this.clock.now());
          await repositories.audit.append({
            actorId: actor.userId,
            action: 'auth.logged_out',
            resourceType: 'session',
            resourceId: actor.sessionId,
            outcome: 'success',
            requestId: context.requestId,
          });
          return { status: 204, body: null };
        },
      );
    });
  }
  async listSessions(actor: Actor): Promise<ServiceResult> {
    return this.work.run(async (repositories) => {
      await this.authorization.require(repositories, actor);
      return {
        status: 200,
        body: {
          sessions: (await repositories.identity.sessions(actor.userId)).map((session) => ({
            id: session.id,
            createdAt: session.created_at.toISOString(),
            expiresAt: session.expires_at.toISOString(),
            revokedAt: session.revoked_at?.toISOString() ?? null,
            current: session.id === actor.sessionId,
          })),
        },
      };
    });
  }
  async revoke(
    actor: Actor,
    targetId: string,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    return this.work.run(async (repositories) => {
      await this.authorization.require(repositories, actor, { recent: true });
      const session = await repositories.identity.session(targetId);
      if (!session || session.user_id !== actor.userId) {
        await repositories.audit.append({
          actorId: actor.userId,
          action: 'auth.session_revoke_denied',
          resourceType: 'session',
          resourceId: null,
          outcome: 'denied',
          requestId: context.requestId,
        });
        return failure('NOT_FOUND', 404);
      }
      return this.idempotency.execute(
        repositories,
        {
          actorId: actor.userId,
          scope: `revoke:${actor.userId}:${targetId}`,
          key,
          payload: {},
          ttl: 86400,
        },
        async () => {
          await repositories.identity.revokeSession(session.id, this.clock.now());
          await repositories.audit.append({
            actorId: actor.userId,
            action: 'auth.session_revoked',
            resourceType: 'session',
            resourceId: session.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return { status: 204, body: null };
        },
      );
    });
  }
}
