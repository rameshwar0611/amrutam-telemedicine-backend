import type { AuditQuery, AnalyticsQuery, JobsQuery } from '../schemas.js';
export interface AuditRow {
  id: string;
  occurred_at: Date;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  outcome: 'success' | 'failure' | 'denied';
  request_id: string | null;
}
export interface JobRow {
  id: string;
  kind: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  attempts: number;
  max_attempts: number;
  available_at: Date;
  lease_until: Date | null;
  completed_at: Date | null;
  last_error_code: string | null;
  created_at: Date;
}
export interface AdminStore {
  audit(query: AuditQuery): Promise<AuditRow[]>;
  jobs(query: JobsQuery): Promise<JobRow[]>;
  analytics(query: AnalyticsQuery): Promise<{ as_of: Date; totals: unknown; doctors: unknown }>;
}
