import type { AdminStore } from '../domain/ports.js';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { AuditQuery, AnalyticsQuery, JobsQuery } from '../schemas.js';
export class AdminRepository implements AdminStore {
  constructor(private readonly db: Transaction<Database>) {}
  audit(query: AuditQuery) {
    let q = this.db
      .selectFrom('audit_logs')
      .select([
        'id',
        'occurred_at',
        'actor_id',
        'action',
        'resource_type',
        'resource_id',
        'outcome',
        'request_id',
      ])
      .where('occurred_at', '>=', new Date(query.from))
      .where('occurred_at', '<', new Date(query.to));
    if (query.actorId) q = q.where('actor_id', '=', query.actorId);
    if (query.resourceId) q = q.where('resource_id', '=', query.resourceId);
    if (query.action) q = q.where('action', '=', query.action);
    if (query.outcome) q = q.where('outcome', '=', query.outcome);
    return q
      .orderBy('occurred_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .offset(query.offset)
      .execute();
  }
  jobs(query: JobsQuery) {
    let q = this.db
      .selectFrom('outbox_jobs')
      .select([
        'id',
        'kind',
        'status',
        'attempts',
        'max_attempts',
        'available_at',
        'lease_until',
        'completed_at',
        'last_error_code',
        'created_at',
      ])
      .where('created_at', '>=', new Date(query.from))
      .where('created_at', '<', new Date(query.to));
    if (query.status) q = q.where('status', '=', query.status);
    return q
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(query.limit + 1)
      .offset(query.offset)
      .execute();
  }
  async analytics(query: AnalyticsQuery) {
    const result = await sql<{ as_of: Date; totals: unknown; doctors: unknown }>`WITH cohort AS (
   SELECT c.* FROM consultations c JOIN availability_slots s ON s.id=c.slot_id
   WHERE s.starts_at >= ${query.from}::timestamptz AND s.starts_at < ${query.to}::timestamptz
   AND (${query.doctorId ?? null}::uuid IS NULL OR c.doctor_id=${query.doctorId ?? null}::uuid)
  ), capacity AS (
   SELECT d.id,d.public_name, COALESCE(sum(CASE WHEN s.id IS NOT NULL THEN EXTRACT(EPOCH FROM LEAST(s.ends_at,${query.to}::timestamptz)-GREATEST(s.starts_at,${query.from}::timestamptz)) ELSE 0 END),0)::float8 AS offered_seconds,
    COALESCE(sum(CASE WHEN EXISTS(SELECT 1 FROM consultations c WHERE c.slot_id=s.id AND c.status<>'cancelled') THEN EXTRACT(EPOCH FROM LEAST(s.ends_at,${query.to}::timestamptz)-GREATEST(s.starts_at,${query.from}::timestamptz)) ELSE 0 END),0)::float8 AS booked_seconds
   FROM doctors d LEFT JOIN availability_slots s ON s.doctor_id=d.id AND s.status='open' AND s.starts_at < ${query.to}::timestamptz AND s.ends_at > ${query.from}::timestamptz
   WHERE (${query.doctorId ?? null}::uuid IS NULL OR d.id=${query.doctorId ?? null}::uuid) GROUP BY d.id,d.public_name
  ), page AS (SELECT * FROM capacity ORDER BY id LIMIT ${query.limit + 1} OFFSET ${query.offset})
  SELECT statement_timestamp() AS as_of,
   (SELECT jsonb_build_object('bookings',count(*),'completed',count(*) FILTER(WHERE status='completed'),'cancellations',count(*) FILTER(WHERE status='cancelled'),'noShows',count(*) FILTER(WHERE status='no_show')) FROM cohort) AS totals,
   COALESCE((SELECT jsonb_agg(jsonb_build_object('doctorId',id,'name',public_name,'offeredSeconds',offered_seconds,'bookedSeconds',booked_seconds,'utilization',CASE WHEN offered_seconds=0 THEN 0 ELSE booked_seconds/offered_seconds END) ORDER BY id) FROM page),'[]'::jsonb) AS doctors`.execute(
      this.db,
    );
    return result.rows[0]!;
  }
}
