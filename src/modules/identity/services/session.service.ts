import { randomUUID } from 'node:crypto';
import type { SecurityRepositories, UserRecord } from '../domain/ports.js';
import {
  failure,
  type Actor,
  type Clock,
  type SecretBox,
  type SecuritySettings,
  type ServiceResult,
  type TokenIssuer,
} from '../domain/security.js';

export class SessionService {
  constructor(
    private readonly secrets: SecretBox,
    private readonly tokens: TokenIssuer,
    private readonly clock: Clock,
    private readonly settings: SecuritySettings,
  ) {}
  async challenge(repositories: SecurityRepositories, user: UserRecord): Promise<ServiceResult> {
    const purpose = user.status === 'pending_mfa' ? 'enroll' : 'verify';
    const flow = await repositories.identity.createFlow(
      user,
      purpose,
      new Date(this.clock.now().getTime() + this.settings.challengeTtl * 1000),
    );
    const challengeToken = await this.tokens.challenge(
      { userId: user.id, flowId: flow.id, authVersion: user.auth_version, purpose },
      flow.expires_at,
    );
    return {
      status: 200,
      body: { challengeToken, nextStep: purpose, expiresIn: this.settings.challengeTtl },
    };
  }
  async issue(
    user: UserRecord,
    sessionId: string,
    refreshToken: string,
    expiresAt: Date,
  ): Promise<ServiceResult> {
    const expiresIn = Math.min(
      this.settings.accessTtl,
      Math.floor((expiresAt.getTime() - this.clock.now().getTime()) / 1000),
    );
    if (expiresIn <= 0) return failure();
    const actor: Actor = {
      userId: user.id,
      sessionId,
      authVersion: user.auth_version,
      role: user.role,
    };
    const accessToken = await this.tokens.access(
      actor,
      new Date(this.clock.now().getTime() + expiresIn * 1000),
    );
    return { status: 200, body: { accessToken, refreshToken, tokenType: 'Bearer', expiresIn } };
  }
  async create(repositories: SecurityRepositories, user: UserRecord): Promise<ServiceResult> {
    const id = randomUUID();
    const token = `${id}.${this.secrets.randomToken()}`;
    const session = await repositories.identity.createSession({
      id,
      userId: user.id,
      hash: this.secrets.digest(`refresh:${token}`),
      expiresAt: new Date(this.clock.now().getTime() + this.settings.refreshTtl * 1000),
      mfaVerifiedAt: this.clock.now(),
    });
    return this.issue(user, session.id, token, session.expires_at);
  }
  async validateReplay(
    repositories: SecurityRepositories,
    userId: string,
    result: ServiceResult,
  ): Promise<ServiceResult> {
    if (result.status >= 400) return result;
    const body = result.body;
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      typeof body.refreshToken !== 'string'
    )
      return failure();
    const id = body.refreshToken.split('.')[0];
    if (!id) return failure();
    const session = await repositories.identity.session(id, true);
    if (
      !session ||
      session.user_id !== userId ||
      session.revoked_at ||
      session.expires_at <= this.clock.now() ||
      !this.secrets.equal(
        session.refresh_token_hash,
        this.secrets.digest(`refresh:${body.refreshToken}`),
      )
    )
      return failure();
    return result;
  }
}
