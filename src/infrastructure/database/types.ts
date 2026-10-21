import type { ColumnType, Generated } from 'kysely';

import type { JsonValue } from '../../shared/json.js';
export type { JsonValue } from '../../shared/json.js';
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type DefaultTimestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type BigInteger = ColumnType<string, string | number, string | number>;
interface Timestamps {
  created_at: DefaultTimestamp;
  updated_at: DefaultTimestamp;
}

export interface UsersTable extends Timestamps {
  id: Generated<string>;
  email: string;
  password_hash: string;
  role: 'patient' | 'doctor' | 'admin';
  status: Generated<'pending_activation' | 'pending_mfa' | 'active' | 'disabled'>;
  auth_version: Generated<number>;
  activated_at: Timestamp | null;
}
export interface ProfilesTable extends Timestamps {
  user_id: string;
  display_name: string;
  phone: string | null;
  time_zone: Generated<string>;
}
export interface DoctorsTable extends Timestamps {
  id: Generated<string>;
  user_id: string;
  public_name: string;
  specialty: string;
  biography: string | null;
  active: Generated<boolean>;
}
export interface AvailabilitySlotsTable extends Timestamps {
  id: Generated<string>;
  doctor_id: string;
  starts_at: Timestamp;
  ends_at: Timestamp;
  status: Generated<'open' | 'blocked'>;
}
export interface ConsultationsTable extends Timestamps {
  id: Generated<string>;
  slot_id: string;
  doctor_id: string;
  patient_id: string;
  status: Generated<'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'no_show'>;
  clinical_notes: JsonValue | null;
  version: Generated<number>;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  cancelled_at: Timestamp | null;
  no_show_at: Timestamp | null;
  cancellation_reason: string | null;
}
export interface PrescriptionsTable extends Timestamps {
  correction_of: string | null;
  revision: Generated<number>;
  revoked_at: Timestamp | null;
  revocation_reason: string | null;
  id: Generated<string>;
  consultation_id: string;
  doctor_id: string;
  version: number;
  status: Generated<'draft' | 'finalized' | 'revoked'>;
  clinical_payload: JsonValue;
  finalized_at: Timestamp | null;
}
export interface PaymentsTable extends Timestamps {
  id: Generated<string>;
  consultation_id: string;
  amount_minor: BigInteger;
  currency: string;
  status: Generated<
    'pending' | 'authorized' | 'paid' | 'refund_pending' | 'refunded' | 'failed' | 'cancelled'
  >;
  provider_reference: string | null;
}
export interface AuditLogsTable {
  id: Generated<string>;
  occurred_at: DefaultTimestamp;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: 'success' | 'failure' | 'denied';
  request_id: string | null;
  trace_id: string | null;
  metadata: Generated<JsonValue>;
}
export interface AuthSessionsTable extends Timestamps {
  id: Generated<string>;
  user_id: string;
  family_id: Generated<string>;
  refresh_token_hash: string;
  previous_refresh_token_hash: string | null;
  previous_token_valid_until: Timestamp | null;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  mfa_verified_at: Timestamp | null;
}
export interface MfaFactorsTable extends Timestamps {
  id: Generated<string>;
  user_id: string;
  secret_envelope: JsonValue;
  confirmed_at: Timestamp | null;
  last_accepted_step: BigInteger | null;
  enrollment_flow_id: string | null;
}
export interface MfaRecoveryCodesTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  created_at: DefaultTimestamp;
  consumed_at: Timestamp | null;
}
export interface AuthTokensTable {
  id: Generated<string>;
  user_id: string;
  purpose: 'account_setup' | 'account_recovery';
  requires_password: Generated<boolean>;
  token_hash: string;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
}
export interface IdempotencyRecordsTable {
  id: Generated<string>;
  actor_id: string | null;
  scope: string;
  key: string;
  request_fingerprint: string;
  status: Generated<'in_progress' | 'completed'>;
  response_status: number | null;
  response_body: JsonValue | null;
  response_encrypted: Generated<boolean>;
  resource_id: string | null;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
}
export interface OutboxJobsTable extends Timestamps {
  trace_parent: string | null;
  id: Generated<string>;
  kind: string;
  deduplication_key: string;
  payload: JsonValue;
  status: Generated<'pending' | 'processing' | 'completed' | 'failed'>;
  attempts: Generated<number>;
  max_attempts: Generated<number>;
  available_at: DefaultTimestamp;
  leased_by: string | null;
  lease_until: Timestamp | null;
  completed_at: Timestamp | null;
  last_error_code: string | null;
}
export interface Database {
  job_receipts: { job_id: string; kind: string; completed_at: DefaultTimestamp };
  doctor_directory_revision: { id: boolean; generation: string };
  auth_flows: AuthFlowsTable;
  refresh_token_history: RefreshTokenHistoryTable;
  users: UsersTable;
  profiles: ProfilesTable;
  doctors: DoctorsTable;
  availability_slots: AvailabilitySlotsTable;
  consultations: ConsultationsTable;
  prescriptions: PrescriptionsTable;
  payments: PaymentsTable;
  audit_logs: AuditLogsTable;
  auth_sessions: AuthSessionsTable;
  mfa_factors: MfaFactorsTable;
  mfa_recovery_codes: MfaRecoveryCodesTable;
  auth_tokens: AuthTokensTable;
  idempotency_records: IdempotencyRecordsTable;
  outbox_jobs: OutboxJobsTable;
}

export interface AuthFlowsTable {
  id: Generated<string>;
  user_id: string;
  auth_version: number;
  purpose: 'enroll' | 'verify';
  attempts: Generated<number>;
  created_at: DefaultTimestamp;
  expires_at: Timestamp;
  consumed_at: Timestamp | null;
}
export interface RefreshTokenHistoryTable {
  token_hash: string;
  session_id: string;
  used_at: DefaultTimestamp;
}
