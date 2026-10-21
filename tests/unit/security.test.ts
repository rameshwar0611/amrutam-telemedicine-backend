import { describe, expect, it } from 'vitest';
import { randomBytes, createPrivateKey } from 'node:crypto';
import { SignJWT } from 'jose';
import { AesSecretBox } from '../../src/infrastructure/security/secret-box.js';
import { ArgonPasswords } from '../../src/infrastructure/security/passwords.js';
import { JwtTokens } from '../../src/infrastructure/security/tokens.js';
import { TotpProvider } from '../../src/infrastructure/security/otp.js';
import { loadSecurityConfig } from '../../src/infrastructure/config/security-env.js';
import { makeSecurityConfig, TestClock } from '../helpers/security.js';
import { randomUUID } from 'node:crypto';
import { RedisRateLimiter } from '../../src/infrastructure/security/rate-limiter.js';

describe('security primitives', () => {
  it('uses Argon2id with the configured work factor and verifies safely', async () => {
    const passwords = new ArgonPasswords();
    const password = randomBytes(24).toString('base64url');
    const hash = await passwords.hash(password);
    expect(hash).toMatch(/^\$argon2id\$v=19\$/);
    expect(new Set(hash.split('$')[3]?.split(','))).toEqual(new Set(['m=65536', 't=3', 'p=1']));
    expect(await passwords.verify(password, hash)).toBe(true);
    expect(await passwords.verify('incorrect-password', hash)).toBe(false);
    expect(await passwords.verify(password, null)).toBe(false);
    expect(await passwords.verify(password, 'malformed')).toBe(false);
  });
  it('encrypts with randomized authenticated envelopes and binds context', () => {
    const key = randomBytes(32).toString('base64');
    const box = new AesSecretBox({ one: key }, 'one', randomBytes(32).toString('base64'));
    const first = box.encrypt('sensitive-test-value', 'user:one');
    expect(first).not.toEqual(box.encrypt('sensitive-test-value', 'user:one'));
    expect(box.decrypt(first, 'user:one')).toBe('sensitive-test-value');
    expect(() => box.decrypt(first, 'user:two')).toThrow();
    expect(JSON.stringify(first)).not.toContain('sensitive-test-value');
    expect(
      () => new AesSecretBox({ one: key }, 'constructor', randomBytes(32).toString('base64')),
    ).toThrow('Missing active encryption key');
  });
  it('can decrypt old key versions after staged encryption-key rotation', () => {
    const old = randomBytes(32).toString('base64');
    const next = randomBytes(32).toString('base64');
    const pepper = randomBytes(32).toString('base64');
    const prior = new AesSecretBox({ old }, 'old', pepper).encrypt({ value: 'test' }, 'context');
    const rotated = new AesSecretBox({ old, next }, 'next', pepper);
    expect(rotated.decrypt(prior, 'context')).toEqual({ value: 'test' });
    expect(rotated.encrypt('test', 'context')).toMatchObject({ key_version: 'next' });
  });
  it('matches the RFC 6238 SHA1 six-digit vector', () => {
    const provider = new TotpProvider({ now: () => new Date(59000) });
    expect(provider.step('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '287082')).toBe(1);
    expect(provider.step('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', '123')).toBeNull();
  });
  it('validates security configuration without echoing invalid secret material', () => {
    expect(() => loadSecurityConfig({ AUTH_ENCRYPTION_KEYS: 'private-invalid-value' })).not.toThrow(
      'private-invalid-value',
    );
    expect(() => loadSecurityConfig({ AUTH_ENCRYPTION_KEYS: 'private-invalid-value' })).toThrow(
      'AUTH_ENCRYPTION_KEYS',
    );
  });
  it('masks dependency details and fails closed when Redis cannot enforce a rate limit', async () => {
    const limiter = new RedisRateLimiter({
      eval: () => Promise.reject(new Error('private Redis credential detail')),
    });
    await expect(limiter.consume('test-key', 1, 60)).rejects.toMatchObject({
      status: 503,
      code: 'SECURITY_DEPENDENCY_UNAVAILABLE',
      message: 'SECURITY_DEPENDENCY_UNAVAILABLE',
    });
  });
});

describe('strict JWT boundaries', () => {
  const config = makeSecurityConfig();
  const clock = new TestClock();
  const tokens = new JwtTokens(config, clock);
  const actor = {
    userId: randomUUID(),
    sessionId: randomUUID(),
    authVersion: 1,
    role: 'patient' as const,
  };
  it('round trips a full access token and rejects its tampered signature', async () => {
    const token = await tokens.access(actor, new Date(clock.now().getTime() + 300000));
    expect(await tokens.verifyAccess(token)).toEqual(actor);
    const parts = token.split('.');
    parts[2] = `${parts[2]?.startsWith('A') ? 'B' : 'A'}${parts[2]?.slice(1)}`;
    await expect(tokens.verifyAccess(parts.join('.'))).rejects.toMatchObject({ status: 401 });
  });
  it('cannot exchange a pre-MFA challenge for application access', async () => {
    const token = await tokens.challenge(
      { userId: actor.userId, flowId: randomUUID(), authVersion: 1, purpose: 'enroll' },
      new Date(clock.now().getTime() + 300000),
    );
    await expect(tokens.verifyAccess(token)).rejects.toMatchObject({ status: 401 });
  });
  it('supports signing-key rotation while retaining an old verification key', async () => {
    const token = await tokens.access(actor, new Date(clock.now().getTime() + 300000));
    const next = makeSecurityConfig();
    const publicKey = next.AUTH_JWT_PUBLIC_KEYS['test-1'];
    if (!publicKey) throw new Error('Expected key');
    const rotated = new JwtTokens(
      {
        ...next,
        AUTH_JWT_KEY_ID: 'test-2',
        AUTH_JWT_PUBLIC_KEYS: { ...config.AUTH_JWT_PUBLIC_KEYS, 'test-2': publicKey },
      },
      clock,
    );
    expect(await rotated.verifyAccess(token)).toEqual(actor);
    const newToken = await rotated.access(actor, new Date(clock.now().getTime() + 300000));
    expect(await rotated.verifyAccess(newToken)).toEqual(actor);
    await expect(tokens.verifyAccess(newToken)).rejects.toMatchObject({ status: 401 });
  });
  it.each([
    'issuer',
    'audience',
    'kid',
    'algorithm',
    'expiry',
    'missing-expiry',
    'future-iat',
    'type',
    'long-lifetime',
  ])('rejects invalid %s', async (invalid) => {
    const now = Math.floor(clock.now().getTime() / 1000);
    const builder = new SignJWT({
      sid: actor.sessionId,
      av: 1,
      role: 'patient',
      token_use: 'access',
      amr: ['pwd', 'mfa'],
    })
      .setSubject(actor.userId)
      .setIssuer(invalid === 'issuer' ? 'wrong-issuer' : config.AUTH_JWT_ISSUER)
      .setAudience(invalid === 'audience' ? 'wrong-audience' : config.AUTH_JWT_AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt(invalid === 'future-iat' ? now + 60 : now)
      .setProtectedHeader({
        alg: invalid === 'algorithm' ? 'HS256' : 'EdDSA',
        kid: invalid === 'kid' ? 'unknown-key' : config.AUTH_JWT_KEY_ID,
        typ: invalid === 'type' ? 'amrutam-challenge+jwt' : 'amrutam-access+jwt',
      });
    if (invalid !== 'missing-expiry')
      builder.setExpirationTime(
        invalid === 'expiry' ? now - 1 : invalid === 'long-lifetime' ? now + 86400 : now + 300,
      );
    const key =
      invalid === 'algorithm'
        ? randomBytes(32)
        : createPrivateKey(Buffer.from(config.AUTH_JWT_PRIVATE_KEY_BASE64, 'base64'));
    await expect(tokens.verifyAccess(await builder.sign(key))).rejects.toMatchObject({
      status: 401,
    });
  });
});
