import type { JsonValue } from '../../../shared/json.js';

export type Role = 'patient' | 'doctor' | 'admin';
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
export interface Actor {
  userId: string;
  sessionId: string;
  authVersion: number;
  role: Role;
}
export interface Challenge {
  userId: string;
  flowId: string;
  authVersion: number;
  purpose: 'enroll' | 'verify';
}
export interface TokenIssuer {
  access(actor: Actor, expiresAt: Date): Promise<string>;
  challenge(challenge: Challenge, expiresAt: Date): Promise<string>;
  verifyAccess(token: string): Promise<Actor>;
  verifyChallenge(token: string): Promise<Challenge>;
}
export interface SecretBox {
  encrypt(value: JsonValue, context: string): JsonValue;
  decrypt(value: JsonValue, context: string): JsonValue;
  digest(value: string): string;
  equal(left: string, right: string): boolean;
  randomToken(): string;
}
export interface Passwords {
  hash(value: string): Promise<string>;
  verify(value: string, hash: string | null): Promise<boolean>;
}
export interface OtpProvider {
  create(label: string): { secret: string; uri: string };
  step(secret: string, code: string): number | null;
}
export interface RateLimiter {
  consume(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; retryAfter: number; firstDenied: boolean }>;
}
export interface SecuritySettings {
  accessTtl: number;
  challengeTtl: number;
  refreshTtl: number;
  setupTtl: number;
  retryTtl: number;
}
export interface RequestContext {
  requestId: string;
}
export interface ServiceResult {
  status: number;
  body: JsonValue;
}
export const failure = (code = 'INVALID_AUTHENTICATION', status = 401): ServiceResult => ({
  status,
  body: { code },
});
