import type { JsonValue } from '../../../shared/json.js';
import type { Actor, Role } from './security.js';
import type { AuditWriter } from '../../audit/domain/audit.js';

export type AccountStatus = 'pending_activation' | 'pending_mfa' | 'active' | 'disabled';
export interface UserRecord {
  id: string;
  email: string;
  password_hash: string;
  role: Role;
  status: AccountStatus;
  auth_version: number;
  activated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface ProfileRecord {
  user_id: string;
  display_name: string;
  phone: string | null;
  time_zone: string;
}
export interface SessionRecord {
  id: string;
  user_id: string;
  family_id: string;
  refresh_token_hash: string;
  previous_refresh_token_hash: string | null;
  previous_token_valid_until: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  mfa_verified_at: Date | null;
  created_at: Date;
}
export interface FlowRecord {
  id: string;
  user_id: string;
  auth_version: number;
  purpose: 'enroll' | 'verify';
  attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
}
export interface FactorRecord {
  id: string;
  user_id: string;
  secret_envelope: JsonValue;
  confirmed_at: Date | null;
  last_accepted_step: string | null;
  enrollment_flow_id: string | null;
}
export interface SetupTokenRecord {
  id: string;
  user_id: string;
  token_hash: string;
  purpose: 'account_setup' | 'account_recovery';
  requires_password: boolean;
  expires_at: Date;
  consumed_at: Date | null;
}
export interface IdempotencyRecord {
  id: string;
  request_fingerprint: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: JsonValue | null;
  response_encrypted: boolean;
  expires_at: Date;
}

export interface IdentityStore {
  lockEmail(email: string): Promise<void>;
  userByEmail(email: string): Promise<UserRecord | undefined>;
  userById(id: string, lock?: boolean): Promise<UserRecord | undefined>;
  createUser(input: {
    email: string;
    password_hash: string;
    role: Role;
    status: AccountStatus;
  }): Promise<UserRecord>;
  updateUser(
    id: string,
    values: Partial<Pick<UserRecord, 'password_hash' | 'status' | 'auth_version' | 'activated_at'>>,
  ): Promise<void>;
  createProfile(userId: string, displayName: string, timeZone: string): Promise<void>;
  profile(userId: string): Promise<ProfileRecord | undefined>;
  updateProfile(
    userId: string,
    values: {
      displayName?: string | undefined;
      phone?: string | null | undefined;
      timeZone?: string | undefined;
    },
  ): Promise<void>;
  createDoctor(userId: string, publicName: string, specialty: string): Promise<void>;
  setDoctorActive(userId: string, active: boolean): Promise<void>;
  lockBootstrap(): Promise<void>;
  hasAdmin(): Promise<boolean>;
  createSetupToken(input: {
    id: string;
    userId: string;
    tokenHash: string;
    requiresPassword: boolean;
    expiresAt: Date;
  }): Promise<void>;
  setupByHash(hash: string, lock?: boolean): Promise<SetupTokenRecord | undefined>;
  latestSetup(userId: string): Promise<SetupTokenRecord | undefined>;
  consumeSetup(id: string, now: Date): Promise<void>;
  queueDelivery(deduplicationKey: string, payload: JsonValue): Promise<void>;
  delivery(deduplicationKey: string): Promise<JsonValue | undefined>;
  createFlow(user: UserRecord, purpose: 'enroll' | 'verify', expiresAt: Date): Promise<FlowRecord>;
  flow(id: string, lock?: boolean): Promise<FlowRecord | undefined>;
  consumeFlow(id: string, now: Date): Promise<void>;
  failFlow(id: string): Promise<void>;
  factor(userId: string): Promise<FactorRecord | undefined>;
  saveEnrollment(userId: string, flowId: string, envelope: JsonValue, now: Date): Promise<void>;
  acceptStep(userId: string, step: number): Promise<boolean>;
  confirmFactor(userId: string, now: Date): Promise<void>;
  replaceRecoveryCodes(userId: string, hashes: string[]): Promise<void>;
  consumeRecoveryCode(userId: string, hash: string, now: Date): Promise<boolean>;
  createSession(input: {
    id: string;
    userId: string;
    hash: string;
    expiresAt: Date;
    mfaVerifiedAt: Date;
  }): Promise<SessionRecord>;
  session(id: string, lock?: boolean): Promise<SessionRecord | undefined>;
  sessions(userId: string): Promise<SessionRecord[]>;
  rotateSession(id: string, currentHash: string, nextHash: string, retryUntil: Date): Promise<void>;
  refreshWasUsed(sessionId: string, hash: string): Promise<boolean>;
  revokeFamily(familyId: string, now: Date): Promise<void>;
  revokeSession(id: string, now: Date): Promise<void>;
  revokeAll(userId: string, now: Date): Promise<void>;
}

export interface IdempotencyStore {
  claim(input: {
    actorId: string | null;
    scope: string;
    key: string;
    fingerprint: string;
    expiresAt: Date;
  }): Promise<IdempotencyRecord>;
  find(scope: string, key: string): Promise<IdempotencyRecord | undefined>;
  complete(id: string, status: number, body: JsonValue): Promise<void>;
}
export interface SecurityRepositories {
  identity: IdentityStore;
  audit: AuditWriter;
  idempotency: IdempotencyStore;
}
export interface AuthorizedState {
  user: UserRecord;
  session: SessionRecord;
  actor: Actor;
}
