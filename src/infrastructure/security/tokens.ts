import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { SecurityConfig } from '../config/security-env.js';
import type {
  Actor,
  Challenge,
  Clock,
  TokenIssuer,
} from '../../modules/identity/domain/security.js';
import { HttpError } from '../../shared/http-error.js';

const claims = z.object({ sub: z.uuid(), av: z.number().int().positive() });
const accessClaims = claims.extend({
  sid: z.uuid(),
  role: z.enum(['patient', 'doctor', 'admin']),
  token_use: z.literal('access'),
  amr: z.tuple([z.literal('pwd'), z.literal('mfa')]),
});
const challengeClaims = claims.extend({
  fid: z.uuid(),
  purpose: z.enum(['enroll', 'verify']),
  token_use: z.literal('challenge'),
});

export class JwtTokens implements TokenIssuer {
  private readonly privateKey: KeyObject;
  private readonly publicKeys = new Map<string, KeyObject>();
  constructor(
    private readonly config: SecurityConfig,
    private readonly clock: Clock,
  ) {
    try {
      this.privateKey = createPrivateKey(Buffer.from(config.AUTH_JWT_PRIVATE_KEY_BASE64, 'base64'));
      if (this.privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Wrong key type');
      for (const [id, pem] of Object.entries(config.AUTH_JWT_PUBLIC_KEYS)) {
        const key = createPublicKey(Buffer.from(pem, 'base64'));
        if (key.asymmetricKeyType !== 'ed25519') throw new Error('Wrong key type');
        this.publicKeys.set(id, key);
      }
      const current = this.publicKeys.get(config.AUTH_JWT_KEY_ID);
      if (
        !current ||
        !verify(
          null,
          Buffer.from('key-pair-validation'),
          current,
          sign(null, Buffer.from('key-pair-validation'), this.privateKey),
        )
      )
        throw new Error('Mismatched keys');
    } catch {
      throw new Error('Invalid JWT signing/verification key configuration');
    }
  }
  private issue(
    payload: Record<string, unknown>,
    subject: string,
    expiresAt: Date,
    type: string,
  ): Promise<string> {
    return new SignJWT(payload)
      .setProtectedHeader({ alg: 'EdDSA', kid: this.config.AUTH_JWT_KEY_ID, typ: type })
      .setSubject(subject)
      .setIssuer(this.config.AUTH_JWT_ISSUER)
      .setAudience(this.config.AUTH_JWT_AUDIENCE)
      .setIssuedAt(Math.floor(this.clock.now().getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .setJti(randomUUID())
      .sign(this.privateKey);
  }
  access(actor: Actor, expiresAt: Date): Promise<string> {
    return this.issue(
      {
        sid: actor.sessionId,
        av: actor.authVersion,
        role: actor.role,
        amr: ['pwd', 'mfa'],
        token_use: 'access',
      },
      actor.userId,
      expiresAt,
      'amrutam-access+jwt',
    );
  }
  challenge(challenge: Challenge, expiresAt: Date): Promise<string> {
    return this.issue(
      {
        fid: challenge.flowId,
        av: challenge.authVersion,
        purpose: challenge.purpose,
        token_use: 'challenge',
      },
      challenge.userId,
      expiresAt,
      'amrutam-challenge+jwt',
    );
  }
  private async verify(token: string, type: string) {
    try {
      const verified = await jwtVerify(
        token,
        (header) => {
          const key = header.kid ? this.publicKeys.get(header.kid) : undefined;
          if (!key) throw new Error('Unknown key');
          return key;
        },
        {
          algorithms: ['EdDSA'],
          issuer: this.config.AUTH_JWT_ISSUER,
          audience: this.config.AUTH_JWT_AUDIENCE,
          typ: type,
          requiredClaims: ['sub', 'iat', 'exp', 'jti'],
          clockTolerance: 0,
          currentDate: this.clock.now(),
          maxTokenAge:
            type === 'amrutam-access+jwt'
              ? this.config.AUTH_ACCESS_TTL_SECONDS
              : this.config.AUTH_CHALLENGE_TTL_SECONDS,
        },
      );
      const lifetime =
        type === 'amrutam-access+jwt'
          ? this.config.AUTH_ACCESS_TTL_SECONDS
          : this.config.AUTH_CHALLENGE_TTL_SECONDS;
      if (
        typeof verified.payload.iat !== 'number' ||
        typeof verified.payload.exp !== 'number' ||
        verified.payload.exp <= verified.payload.iat ||
        verified.payload.exp - verified.payload.iat > lifetime
      )
        throw new Error('Invalid token lifetime');
      return verified;
    } catch {
      throw new HttpError(401, 'INVALID_AUTHENTICATION');
    }
  }
  async verifyAccess(token: string): Promise<Actor> {
    const result = accessClaims.safeParse((await this.verify(token, 'amrutam-access+jwt')).payload);
    if (!result.success) throw new HttpError(401, 'INVALID_AUTHENTICATION');
    return {
      userId: result.data.sub,
      sessionId: result.data.sid,
      authVersion: result.data.av,
      role: result.data.role,
    };
  }
  async verifyChallenge(token: string): Promise<Challenge> {
    const result = challengeClaims.safeParse(
      (await this.verify(token, 'amrutam-challenge+jwt')).payload,
    );
    if (!result.success) throw new HttpError(401, 'INVALID_AUTHENTICATION');
    return {
      userId: result.data.sub,
      flowId: result.data.fid,
      authVersion: result.data.av,
      purpose: result.data.purpose,
    };
  }
}
