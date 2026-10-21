export interface AuditEvent {
  actorId: string | null;
  action: string;
  resourceType:
    | 'audit_log'
    | 'analytics'
    | 'outbox_job'
    | 'user'
    | 'session'
    | 'mfa'
    | 'auth_flow'
    | 'doctor'
    | 'availability_slot'
    | 'consultation'
    | 'prescription'
    | 'payment';
  resourceId: string | null;
  outcome: 'success' | 'failure' | 'denied';
  requestId: string;
  metadata?: Record<string, string | number | boolean | null>;
}
export interface AuditWriter {
  append(event: AuditEvent): Promise<void>;
}
