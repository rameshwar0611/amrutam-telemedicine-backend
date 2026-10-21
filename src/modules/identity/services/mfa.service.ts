import { z } from 'zod';
import type { UnitOfWork } from '../../../shared/ports/unit-of-work.js';
import type { SecurityRepositories } from '../domain/ports.js';
import {
  failure,
  type Actor,
  type Challenge,
  type Clock,
  type OtpProvider,
  type Passwords,
  type RequestContext,
  type SecretBox,
  type SecuritySettings,
  type ServiceResult,
  type TokenIssuer,
} from '../domain/security.js';
import type { MfaInput } from '../schemas.js';
import type { AuthorizationService } from './authorization.service.js';
import type { IdempotencyService } from './idempotency.service.js';
import type { SessionService } from './session.service.js';
import { HttpError } from '../../../shared/http-error.js';

export class MfaService {
  constructor(
    private readonly work: UnitOfWork<SecurityRepositories>,
    private readonly secrets: SecretBox,
    private readonly passwords: Passwords,
    private readonly tokens: TokenIssuer,
    private readonly otp: OtpProvider,
    private readonly idempotency: IdempotencyService,
    private readonly authorization: AuthorizationService,
    private readonly sessions: SessionService,
    private readonly clock: Clock,
    private readonly settings: SecuritySettings,
  ) {}
  private async decode(token: string, context: RequestContext): Promise<Challenge> {
    try {
      return await this.tokens.verifyChallenge(token);
    } catch (error) {
      if (error instanceof HttpError)
        await this.authorization.auditDenied(context, 'auth.challenge_denied');
      throw error;
    }
  }
  private async state(
    repositories: SecurityRepositories,
    challenge: Challenge,
    purpose: 'enroll' | 'verify',
  ) {
    const user = await repositories.identity.userById(challenge.userId, true);
    const flow = await repositories.identity.flow(challenge.flowId, true);
    if (
      !user ||
      !user.activated_at ||
      !['pending_mfa', 'active'].includes(user.status) ||
      user.auth_version !== challenge.authVersion ||
      !flow ||
      flow.user_id !== user.id ||
      flow.auth_version !== user.auth_version ||
      flow.purpose !== purpose ||
      challenge.purpose !== purpose ||
      flow.expires_at <= this.clock.now() ||
      flow.attempts >= 5
    )
      return undefined;
    return { user, flow };
  }
  private async failed(
    repositories: SecurityRepositories,
    challenge: Challenge,
    context: RequestContext,
    increment = true,
  ): Promise<ServiceResult> {
    if (increment) await repositories.identity.failFlow(challenge.flowId);
    await repositories.audit.append({
      actorId: challenge.userId,
      action: 'auth.mfa_failed',
      resourceType: 'auth_flow',
      resourceId: challenge.flowId,
      outcome: 'failure',
      requestId: context.requestId,
    });
    return failure();
  }
  async enroll(token: string, key: string, context: RequestContext): Promise<ServiceResult> {
    const challenge = await this.decode(token, context);
    return this.work.run(async (repositories) => {
      const state = await this.state(repositories, challenge, 'enroll');
      if (!state || state.user.status !== 'pending_mfa' || state.flow.consumed_at) return failure();
      const factor = await repositories.identity.factor(state.user.id);
      if (factor?.confirmed_at) return failure();
      return this.idempotency.execute(
        repositories,
        {
          actorId: state.user.id,
          scope: `mfa-enroll:${state.flow.id}`,
          key,
          payload: { token },
          ttl: this.settings.retryTtl,
        },
        async () => {
          if (factor?.enrollment_flow_id === state.flow.id)
            return failure('ENROLLMENT_ALREADY_STARTED', 409);
          const enrollment = this.otp.create(state.user.email);
          await repositories.identity.saveEnrollment(
            state.user.id,
            state.flow.id,
            this.secrets.encrypt(enrollment.secret, `mfa:${state.user.id}`),
            this.clock.now(),
          );
          await repositories.audit.append({
            actorId: state.user.id,
            action: 'auth.mfa_enrollment_started',
            resourceType: 'mfa',
            resourceId: state.user.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return {
            status: 200,
            body: { provisioningUri: enrollment.uri, expiresIn: this.settings.retryTtl },
          };
        },
      );
    });
  }
  async confirm(
    token: string,
    code: string,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    const challenge = await this.decode(token, context);
    return this.work.run(async (repositories) => {
      const state = await this.state(repositories, challenge, 'enroll');
      if (!state) return failure();
      const result = await this.idempotency.execute(
        repositories,
        {
          actorId: state.user.id,
          scope: `mfa-confirm:${state.flow.id}`,
          key,
          payload: { token, code },
          ttl: this.settings.retryTtl,
        },
        async () => {
          const factor = await repositories.identity.factor(state.user.id);
          if (
            state.flow.consumed_at ||
            state.user.status !== 'pending_mfa' ||
            !factor ||
            factor.confirmed_at ||
            factor.enrollment_flow_id !== state.flow.id
          )
            return this.failed(repositories, challenge, context, false);
          const step = this.otp.step(
            z.string().parse(this.secrets.decrypt(factor.secret_envelope, `mfa:${state.user.id}`)),
            code,
          );
          if (step === null || !(await repositories.identity.acceptStep(state.user.id, step)))
            return this.failed(repositories, challenge, context);
          await repositories.identity.confirmFactor(state.user.id, this.clock.now());
          await repositories.identity.consumeFlow(state.flow.id, this.clock.now());
          await repositories.identity.updateUser(state.user.id, { status: 'active' });
          await repositories.identity.setDoctorActive(state.user.id, true);
          const recoveryCodes = Array.from({ length: 10 }, () => this.secrets.randomToken());
          await repositories.identity.replaceRecoveryCodes(
            state.user.id,
            recoveryCodes.map((value) => this.secrets.digest(`recovery:${value}`)),
          );
          const session = await this.sessions.create(repositories, state.user);
          await repositories.audit.append({
            actorId: state.user.id,
            action: 'auth.mfa_confirmed',
            resourceType: 'mfa',
            resourceId: state.user.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return {
            status: session.status,
            body: { ...z.record(z.string(), z.json()).parse(session.body), recoveryCodes },
          };
        },
        async () => {
          // A changed retry must spend the same durable guess budget as a new request.
          await this.failed(repositories, challenge, context);
          return failure('IDEMPOTENCY_CONFLICT', 409);
        },
      );
      return this.sessions.validateReplay(repositories, state.user.id, result);
    });
  }
  async verify(
    token: string,
    input: MfaInput,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    const challenge = await this.decode(token, context);
    return this.work.run(async (repositories) => {
      const state = await this.state(repositories, challenge, 'verify');
      if (!state || state.user.status !== 'active') return failure();
      const result = await this.idempotency.execute(
        repositories,
        {
          actorId: state.user.id,
          scope: `mfa-verify:${state.flow.id}`,
          key,
          payload: { token, ...input },
          ttl: this.settings.retryTtl,
        },
        async () => {
          const factor = await repositories.identity.factor(state.user.id);
          if (state.flow.consumed_at || !factor?.confirmed_at)
            return this.failed(repositories, challenge, context, false);
          let accepted: boolean;
          if (input.method === 'recovery')
            accepted = await repositories.identity.consumeRecoveryCode(
              state.user.id,
              this.secrets.digest(`recovery:${input.code}`),
              this.clock.now(),
            );
          else {
            const step = this.otp.step(
              z
                .string()
                .parse(this.secrets.decrypt(factor.secret_envelope, `mfa:${state.user.id}`)),
              input.code,
            );
            accepted =
              step !== null && (await repositories.identity.acceptStep(state.user.id, step));
          }
          if (!accepted) return this.failed(repositories, challenge, context);
          await repositories.identity.consumeFlow(state.flow.id, this.clock.now());
          const session = await this.sessions.create(repositories, state.user);
          await repositories.audit.append({
            actorId: state.user.id,
            action: 'auth.mfa_verified',
            resourceType: 'mfa',
            resourceId: state.user.id,
            outcome: 'success',
            requestId: context.requestId,
            metadata: { method: input.method },
          });
          return session;
        },
        async () => {
          // A changed retry must spend the same durable guess budget as a new request.
          await this.failed(repositories, challenge, context);
          return failure('IDEMPOTENCY_CONFLICT', 409);
        },
      );
      return this.sessions.validateReplay(repositories, state.user.id, result);
    });
  }
  async regenerateRecovery(
    actor: Actor,
    password: string,
    code: string,
    key: string,
    context: RequestContext,
  ): Promise<ServiceResult> {
    return this.work.run(async (repositories) => {
      const { user } = await this.authorization.require(repositories, actor, { recent: true });
      if (!(await this.passwords.verify(password, user.password_hash))) {
        await repositories.audit.append({
          actorId: user.id,
          action: 'auth.recovery_regeneration_failed',
          resourceType: 'mfa',
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
          scope: `recovery-regenerate:${user.id}`,
          key,
          payload: { password, code },
          ttl: this.settings.retryTtl,
        },
        async () => {
          const factor = await repositories.identity.factor(user.id);
          const step = factor?.confirmed_at
            ? this.otp.step(
                z.string().parse(this.secrets.decrypt(factor.secret_envelope, `mfa:${user.id}`)),
                code,
              )
            : null;
          if (step === null || !(await repositories.identity.acceptStep(user.id, step))) {
            await repositories.audit.append({
              actorId: user.id,
              action: 'auth.recovery_regeneration_failed',
              resourceType: 'mfa',
              resourceId: user.id,
              outcome: 'failure',
              requestId: context.requestId,
            });
            return failure();
          }
          const recoveryCodes = Array.from({ length: 10 }, () => this.secrets.randomToken());
          await repositories.identity.replaceRecoveryCodes(
            user.id,
            recoveryCodes.map((value) => this.secrets.digest(`recovery:${value}`)),
          );
          await repositories.audit.append({
            actorId: user.id,
            action: 'auth.recovery_codes_regenerated',
            resourceType: 'mfa',
            resourceId: user.id,
            outcome: 'success',
            requestId: context.requestId,
          });
          return { status: 200, body: { recoveryCodes } };
        },
      );
    });
  }
}
