import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/infrastructure/config/env.js';

const valid = {
  DATABASE_URL: 'postgresql://user:private-value@localhost:5432/amrutam',
  REDIS_URL: 'redis://localhost:6379',
};

describe('environment configuration', () => {
  it('accepts explicit ingress CIDRs while rejecting blanket or malformed proxy trust', () => {
    expect(
      loadConfig({ ...valid, TRUST_PROXY_CIDRS: '10.0.0.0/8,127.0.0.1/32' }).TRUST_PROXY_CIDRS,
    ).toEqual(['10.0.0.0/8', '127.0.0.1/32']);
    for (const TRUST_PROXY_CIDRS of ['0.0.0.0/0', '::/0', 'untrusted.example', '127.0.0.1/33'])
      expect(() => loadConfig({ ...valid, TRUST_PROXY_CIDRS })).toThrow('TRUST_PROXY_CIDRS');
  });
  it('validates and coerces defaults', () => {
    expect(loadConfig({ ...valid, PORT: '3100' })).toMatchObject({
      PORT: 3100,
      NODE_ENV: 'development',
      DATABASE_POOL_MAX: 10,
    });
  });
  it.each(['0', '-1', '65536', 'not-a-number'])('rejects an invalid port: %s', (PORT) => {
    expect(() => loadConfig({ ...valid, PORT })).toThrow('PORT');
  });
  it('rejects missing dependencies without revealing secrets', () => {
    expect(() => loadConfig({ DATABASE_URL: 'invalid-private-value' })).toThrow('DATABASE_URL');
    expect(() => loadConfig({ DATABASE_URL: 'invalid-private-value' })).not.toThrow(
      'invalid-private-value',
    );
  });
  it('rejects database URL TLS overrides', () => {
    expect(() =>
      loadConfig({ ...valid, DATABASE_URL: `${valid.DATABASE_URL}?sslmode=no-verify` }),
    ).toThrow('DATABASE_URL');
  });
  it('requires verified database and Redis TLS in production', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow('DATABASE_SSL_MODE');
    expect(
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        DATABASE_SSL_MODE: 'verify-full',
        REDIS_URL: 'rediss://localhost:6379',
      }).NODE_ENV,
    ).toBe('production');
  });
  it('rejects unrelated database protocols', () => {
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'https://example.test' })).toThrow(
      'DATABASE_URL',
    );
  });
});
