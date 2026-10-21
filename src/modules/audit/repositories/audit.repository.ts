import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { AuditEvent, AuditWriter } from '../domain/audit.js';

export class AuditRepository implements AuditWriter {
  constructor(private readonly db: Kysely<Database> | Transaction<Database>) {}
  async append(event: AuditEvent): Promise<void> {
    await this.db
      .insertInto('audit_logs')
      .values({
        actor_id: event.actorId,
        action: event.action,
        resource_type: event.resourceType,
        resource_id: event.resourceId,
        outcome: event.outcome,
        request_id: event.requestId,
        metadata: event.metadata ?? {},
      })
      .execute();
  }
}
