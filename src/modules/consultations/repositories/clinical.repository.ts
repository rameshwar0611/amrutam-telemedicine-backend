import { sql, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { JsonValue } from '../../../shared/json.js';
import type { ClinicalStore } from '../domain/ports.js';
export class ClinicalRepository implements ClinicalStore {
  constructor(private readonly db: Transaction<Database>) {}
  get(id: string) {
    return this.db
      .selectFrom('consultations as c')
      .innerJoin('doctors as d', 'd.id', 'c.doctor_id')
      .innerJoin('availability_slots as s', 's.id', 'c.slot_id')
      .selectAll('c')
      .select(['d.user_id as doctor_user_id', 's.starts_at', 's.ends_at'])
      .where('c.id', '=', id)
      .executeTakeFirst();
  }
  async lock(id: string) {
    const initial = await this.get(id);
    if (!initial) return undefined;
    await this.db
      .selectFrom('doctors')
      .select('id')
      .where('id', '=', initial.doctor_id)
      .forShare()
      .executeTakeFirstOrThrow();
    await this.db
      .selectFrom('availability_slots')
      .select('id')
      .where('id', '=', initial.slot_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await this.db
      .selectFrom('consultations')
      .select('id')
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    return this.get(id);
  }
  async transition(id: string, status: 'in_progress' | 'completed' | 'no_show', now: Date) {
    await this.db
      .updateTable('consultations')
      .set({
        status,
        version: sql`version+1`,
        ...(status === 'in_progress'
          ? { started_at: now }
          : status === 'completed'
            ? { completed_at: now }
            : { no_show_at: now }),
      })
      .where('id', '=', id)
      .execute();
  }
  async notes(id: string, value: JsonValue) {
    await this.db
      .updateTable('consultations')
      .set({ clinical_notes: value, version: sql`version+1` })
      .where('id', '=', id)
      .execute();
  }
}
