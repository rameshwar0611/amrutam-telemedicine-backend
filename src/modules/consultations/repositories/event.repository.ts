import { traceParent } from '../../../infrastructure/telemetry/runtime.js';
import type { Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { EventStore } from '../domain/ports.js';
import type { JsonValue } from '../../../shared/json.js';
export class EventRepository implements EventStore {
  constructor(private readonly db: Transaction<Database>) {}
  async enqueue(kind: string, id: string, payload: JsonValue) {
    await this.db
      .insertInto('outbox_jobs')
      .values({ kind, deduplication_key: `${kind}:${id}`, payload, trace_parent: traceParent() })
      .execute();
  }
}
