import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  loadSecurityConfig,
  type SecurityConfig,
} from '../../src/infrastructure/config/security-env.js';
import type { Clock } from '../../src/modules/identity/domain/security.js';

export function makeSecurityConfig(overrides: Partial<SecurityConfig> = {}): SecurityConfig {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    ...loadSecurityConfig({
      AUTH_JWT_KEY_ID: 'test-1',
      AUTH_JWT_PRIVATE_KEY_BASE64: Buffer.from(privateKey).toString('base64'),
      AUTH_JWT_PUBLIC_KEYS: JSON.stringify({ 'test-1': Buffer.from(publicKey).toString('base64') }),
      AUTH_ENCRYPTION_KEY_ID: 'test-1',
      AUTH_ENCRYPTION_KEYS: JSON.stringify({ 'test-1': randomBytes(32).toString('base64') }),
      AUTH_TOKEN_PEPPER_BASE64: randomBytes(32).toString('base64'),
    }),
    ...overrides,
  };
}

export class TestClock implements Clock {
  // Keep frozen fixtures ahead of PostgreSQL wall-clock defaults while long suites run.
  private timestamp = Math.floor(Date.now() / 30000) * 30000 + 65000;
  now(): Date {
    return new Date(this.timestamp);
  }
  advance(seconds: number): void {
    this.timestamp += seconds * 1000;
  }
}
