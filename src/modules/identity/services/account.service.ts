import { randomUUID } from 'node:crypto';
import type { UnitOfWork } from '../../../shared/ports/unit-of-work.js';
import { toJson, type JsonValue } from '../../../shared/json.js';
import type { SecurityRepositories, UserRecord } from '../domain/ports.js';
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
import type {
  ActivationInput,
  ProfilePatch,
  ProvisionInput,
  RegistrationInput,
} from '../schemas.js';
import type { AuthorizationService } from './authorization.service.js';
import type { IdempotencyService } from './idempotency.service.js';

export class AccountService {
  constructor(
    private readonly work: UnitOfWork<SecurityRepositories>,
    private readonly passwords: Passwords,
    private readonly secrets: SecretBox,
    private readonly tokens: TokenIssuer,
    private readonly idempotency: IdempotencyService,
    private readonly authorization: AuthorizationService,
    private readonly clock: Clock,
    private readonly settings: SecuritySettings,
  ) {}

  private async queueSetup(
    repositories: SecurityRepositories,
    user: UserRecord,
    requiresPassword: boolean,
  ): Promise<void> {
    const token = this.secrets.randomToken();
    const id = randomUUID();
    await repositories.identity.createSetupToken({
      id,
      userId: user.id,
      tokenHash: this.secrets.digest(`setup:${token}`),
      requiresPassword,
      expiresAt: new Date(this.clock.now().getTime() + this.settings.setupTtl * 1000),
    });
    await repositories.identity.queueDelivery(`setup:${id}`, {
      userId: user.id,
      tokenId: id,
      tokenEnvelope: this.secrets.encrypt(token, `activation:${id}`),
    });
  }
  async register(
    input: RegistrationInput,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    const passwordHash = await this.passwords.hash(input.password);
    return this.work.run((repositories) =>
      this.idempotency.execute(
        repositories,
        {
          actorId: null,
          scope: `register:${this.secrets.digest(input.email)}`,
          key,
          payload: input,
          ttl: 86400,
        },
        async () => {
          await repositories.identity.lockEmail(input.email);
          const existing = await repositories.identity.userByEmail(input.email);
          if (!existing) {
            const user = await repositories.identity.createUser({
              email: input.email,
              password_hash: passwordHash,
              role: 'patient',
              status: 'pending_activation',
            });
            await repositories.identity.createProfile(user.id, input.displayName, input.timeZone);
            await this.queueSetup(repositories, user, true);
            await repositories.audit.append({
              actorId: user.id,
              action: 'identity.registered',
              resourceType: 'user',
              resourceId: user.id,
              outcome: 'success',
              requestId: context.requestId,
            });
          }
          return {
            status: 202,
            body: { message: 'If eligible, activation instructions will be delivered.' },
          };
        },
      ),
    );
  }
  async activate(
    input: ActivationInput,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    const passwordHash = await this.passwords.hash(input.password);
    return this.work.run(async (repositories) => {
      const candidate = await repositories.identity.setupByHash(
        this.secrets.digest(`setup:${input.token}`),
      );
      if (!candidate) {
        await repositories.audit.append({
          actorId: null,
          action: 'identity.activation_failed',
          resourceType: 'user',
          resourceId: null,
          outcome: 'failure',
          requestId: context.requestId,
        });
        return failure();
      }
      const user = await repositories.identity.userById(candidate.user_id, true);
      const setup = await repositories.identity.setupByHash(candidate.token_hash, true);
      if (
        !user ||
        !setup ||
        user.status === 'disabled' ||
        user.status === 'active' ||
        setup.expires_at <= this.clock.now()
      )
        return failure();
      return this.idempotency.execute(
        repositories,
        {
          actorId: user.id,
          scope: `activate:${setup.id}`,
          key,
          payload: toJson(input),
          ttl: this.settings.challengeTtl,
        },
        async () => {
          if (setup.consumed_at || user.status !== 'pending_activation') return failure();
          await repositories.identity.consumeSetup(setup.id, this.clock.now());
          await repositories.identity.updateUser(user.id, {
            status: 'pending_mfa',
            activated_at: this.clock.now(),
            password_hash: passwordHash,
          });
          const flow = await repositories.identity.createFlow(
            user,
            'enroll',
            new Date(this.clock.now().getTime() + this.settings.challengeTtl * 1000),
          );
          const challengeToken = await this.tokens.challenge(
            { userId: user.id, flowId: flow.id, authVersion: user.auth_version, purpose: 'enroll' },
            flow.expires_at,
          );
          await repositories.audit.append({
            actorId: user.id,
            action: 'identity.activated',
            resourceType: 'user',
            resourceId: user.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return {
            status: 200,
            body: { challengeToken, nextStep: 'enroll', expiresIn: this.settings.challengeTtl },
          };
        },
      );
    });
  }
  private async safeUser(repositories: SecurityRepositories, user: UserRecord): Promise<JsonValue> {
    const profile = await repositories.identity.profile(user.id);
    if (!profile) throw new Error('Missing user profile');
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      status: user.status,
      profile: {
        displayName: profile.display_name,
        phone: profile.phone,
        timeZone: profile.time_zone,
      },
      createdAt: user.created_at.toISOString(),
    };
  }
  async profile(actor: Actor, targetId: string, context: RequestContext): Promise<ServiceResult> {
    return this.work.run(async (repositories) => {
      const { user } = await this.authorization.require(repositories, actor);
      if (targetId !== actor.userId) {
        await repositories.audit.append({
          actorId: actor.userId,
          action: 'identity.profile_denied',
          resourceType: 'user',
          resourceId: targetId,
          outcome: 'denied',
          requestId: context.requestId,
        });
        return failure('FORBIDDEN', 403);
      }
      return { status: 200, body: await this.safeUser(repositories, user) };
    });
  }
  async updateProfile(
    actor: Actor,
    targetId: string,
    input: ProfilePatch,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    return this.work.run(async (repositories) => {
      const { user } = await this.authorization.require(repositories, actor);
      if (targetId !== actor.userId) {
        await repositories.audit.append({
          actorId: actor.userId,
          action: 'identity.profile_denied',
          resourceType: 'user',
          resourceId: targetId,
          outcome: 'denied',
          requestId: context.requestId,
        });
        return failure('FORBIDDEN', 403);
      }
      return this.idempotency.execute(
        repositories,
        { actorId: user.id, scope: `profile:${user.id}`, key, payload: toJson(input), ttl: 86400 },
        async () => {
          await repositories.identity.updateProfile(user.id, input);
          await repositories.audit.append({
            actorId: user.id,
            action: 'identity.profile_updated',
            resourceType: 'user',
            resourceId: user.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return { status: 200, body: await this.safeUser(repositories, user) };
        },
      );
    });
  }
  private async createPrivileged(
    repositories: SecurityRepositories,
    input: ProvisionInput,
    passwordHash: string,
    context: RequestContext,
    actorId: string | null,
  ): Promise<ServiceResult> {
    await repositories.identity.lockEmail(input.email);
    if (await repositories.identity.userByEmail(input.email))
      return failure('ACCOUNT_CONFLICT', 409);
    const user = await repositories.identity.createUser({
      email: input.email,
      password_hash: passwordHash,
      role: input.role,
      status: 'pending_activation',
    });
    await repositories.identity.createProfile(user.id, input.displayName, input.timeZone);
    if (input.role === 'doctor')
      await repositories.identity.createDoctor(
        user.id,
        input.doctor.publicName,
        input.doctor.specialty,
      );
    await this.queueSetup(repositories, user, true);
    await repositories.audit.append({
      actorId,
      action: actorId ? 'identity.privileged_provisioned' : 'identity.admin_bootstrapped',
      resourceType: 'user',
      resourceId: user.id,
      outcome: 'success',
      requestId: context.requestId,
      metadata: { role: user.role },
    });
    return { status: 201, body: await this.safeUser(repositories, user) };
  }
  async provision(
    actor: Actor,
    input: ProvisionInput,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    const hash = await this.passwords.hash(this.secrets.randomToken());
    return this.work.run(async (repositories) => {
      await this.authorization.require(repositories, actor, { recent: true });
      if (actor.role !== 'admin') return failure('FORBIDDEN', 403);
      return this.idempotency.execute(
        repositories,
        {
          actorId: actor.userId,
          scope: `provision:${actor.userId}`,
          key,
          payload: input,
          ttl: 86400,
        },
        () => this.createPrivileged(repositories, input, hash, context, actor.userId),
      );
    });
  }
  async bootstrap(input: ProvisionInput, context: RequestContext): Promise<ServiceResult> {
    const hash = await this.passwords.hash(this.secrets.randomToken());
    return this.work.run(async (repositories) => {
      await repositories.identity.lockBootstrap();
      if (input.role !== 'admin' || (await repositories.identity.hasAdmin())) {
        await repositories.audit.append({
          actorId: null,
          action: 'identity.bootstrap_denied',
          resourceType: 'user',
          resourceId: null,
          outcome: 'denied',
          requestId: context.requestId,
        });
        return failure('BOOTSTRAP_UNAVAILABLE', 409);
      }
      return this.createPrivileged(repositories, input, hash, context, null);
    });
  }
  async changeStatus(
    actor: Actor,
    targetId: string,
    status: 'enabled' | 'disabled',
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    return this.work.run(async (repositories) => {
      // Multi-user writes acquire user locks in a consistent order.
      for (const id of [...new Set([actor.userId, targetId])].sort())
        await repositories.identity.userById(id, true);
      await this.authorization.require(repositories, actor, { recent: true });
      if (actor.role !== 'admin' || targetId === actor.userId) return failure('FORBIDDEN', 403);
      const target = await repositories.identity.userById(targetId, true);
      if (!target) return failure('NOT_FOUND', 404);
      return this.idempotency.execute(
        repositories,
        {
          actorId: actor.userId,
          scope: `status:${actor.userId}:${targetId}`,
          key,
          payload: { status },
          ttl: 86400,
        },
        async () => {
          if (status === 'enabled' && !target.activated_at)
            return failure('ACTIVATION_REQUIRED', 409);
          const factor = await repositories.identity.factor(target.id);
          const nextStatus =
            status === 'disabled' ? 'disabled' : factor?.confirmed_at ? 'active' : 'pending_mfa';
          await repositories.identity.updateUser(target.id, {
            status: nextStatus,
            auth_version: target.auth_version + 1,
          });
          await repositories.identity.revokeAll(target.id, this.clock.now());
          await repositories.identity.setDoctorActive(target.id, nextStatus === 'active');
          await repositories.audit.append({
            actorId: actor.userId,
            action: 'identity.status_changed',
            resourceType: 'user',
            resourceId: target.id,
            outcome: 'success',
            requestId: context.requestId,
            metadata: { status: nextStatus },
          });
          return { status: 204, body: null };
        },
      );
    });
  }
  async passwordChange(
    actor: Actor,
    input: { currentPassword: string; newPassword: string },
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    const hash = await this.passwords.hash(input.newPassword);
    return this.work.run(async (repositories) => {
      const { user } = await this.authorization.require(repositories, actor, { recent: true });
      if (!(await this.passwords.verify(input.currentPassword, user.password_hash))) {
        await repositories.audit.append({
          actorId: user.id,
          action: 'identity.password_change_failed',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'failure',
          requestId: context.requestId,
        });
        return failure();
      }
      return this.idempotency.execute(
        repositories,
        { actorId: user.id, scope: `password:${user.id}`, key, payload: input, ttl: 86400 },
        async () => {
          await repositories.identity.updateUser(user.id, {
            password_hash: hash,
            auth_version: user.auth_version + 1,
          });
          await repositories.identity.revokeAll(user.id, this.clock.now());
          await repositories.audit.append({
            actorId: user.id,
            action: 'identity.password_changed',
            resourceType: 'user',
            resourceId: user.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return { status: 204, body: null };
        },
      );
    });
  }
  async deactivate(
    actor: Actor,
    password: string,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    return this.work.run(async (repositories) => {
      const { user } = await this.authorization.require(repositories, actor, { recent: true });
      if (user.role === 'admin') return failure('FORBIDDEN', 403);
      if (!(await this.passwords.verify(password, user.password_hash))) {
        await repositories.audit.append({
          actorId: user.id,
          action: 'identity.deactivation_failed',
          resourceType: 'user',
          resourceId: user.id,
          outcome: 'failure',
          requestId: context.requestId,
        });
        return failure();
      }
      return this.idempotency.execute(
        repositories,
        {
          actorId: user.id,
          scope: `deactivate:${user.id}`,
          key,
          payload: { password },
          ttl: 86400,
        },
        async () => {
          await repositories.identity.updateUser(user.id, {
            status: 'disabled',
            auth_version: user.auth_version + 1,
          });
          await repositories.identity.revokeAll(user.id, this.clock.now());
          await repositories.identity.setDoctorActive(user.id, false);
          await repositories.audit.append({
            actorId: user.id,
            action: 'identity.deactivated',
            resourceType: 'user',
            resourceId: user.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return { status: 204, body: null };
        },
      );
    });
  }
}
