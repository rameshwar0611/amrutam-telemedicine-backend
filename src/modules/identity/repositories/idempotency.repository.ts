import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { JsonValue } from '../../../shared/json.js';
import type { IdempotencyStore } from '../domain/ports.js';

export class IdempotencyRepository implements IdempotencyStore {
  constructor(private readonly db: Kysely<Database> | Transaction<Database>) {}
  async claim(input: Parameters<IdempotencyStore['claim']>[0]) {
    await this.db
      .insertInto('idempotency_records')
      .values({
        actor_id: input.actorId,
        scope: input.scope,
        key: input.key,
        request_fingerprint: input.fingerprint,
        expires_at: input.expiresAt,
      })
      .onConflict((conflict) => conflict.columns(['scope', 'key']).doNothing())
      .execute();
    return this.db
      .selectFrom('idempotency_records')
      .selectAll()
      .where('scope', '=', input.scope)
      .where('key', '=', input.key)
      .forUpdate()
      .executeTakeFirstOrThrow();
  }
  find(scope: string, key: string) {
    return this.db
      .selectFrom('idempotency_records')
      .selectAll()
      .where('scope', '=', scope)
      .where('key', '=', key)
      .forUpdate()
      .executeTakeFirst();
  }
  async complete(id: string, status: number, body: JsonValue) {
    await this.db
      .updateTable('idempotency_records')
      .set({
        status: 'completed',
        response_status: status,
        response_body: body,
        response_encrypted: true,
      })
      .where('id', '=', id)
      .execute();
  }
}
