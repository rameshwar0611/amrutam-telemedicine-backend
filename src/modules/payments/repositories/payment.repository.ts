import type { PaymentStore } from '../domain/ports.js';
import type { Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
export class PaymentRepository implements PaymentStore {
  constructor(private readonly db: Transaction<Database>) {}
  get(id: string, lock = false) {
    let q = this.db.selectFrom('payments').selectAll().where('id', '=', id);
    if (lock) q = q.forUpdate();
    return q.executeTakeFirst();
  }
  create(consultationId: string, amountMinor: number, currency: string) {
    return this.db
      .insertInto('payments')
      .values({ consultation_id: consultationId, amount_minor: amountMinor, currency })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  list(id: string, limit: number, offset: number) {
    return this.db
      .selectFrom('payments')
      .selectAll()
      .where('consultation_id', '=', id)
      .orderBy('created_at', 'desc')
      .orderBy('id')
      .limit(limit + 1)
      .offset(offset)
      .execute();
  }
  async update(
    id: string,
    status: 'authorized' | 'paid' | 'failed' | 'cancelled' | 'refund_pending',
  ) {
    await this.db.updateTable('payments').set({ status }).where('id', '=', id).execute();
  }
}
