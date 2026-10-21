import type { PrescriptionStore } from '../domain/ports.js';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { JsonValue } from '../../../shared/json.js';
export class PrescriptionRepository implements PrescriptionStore {
  constructor(private readonly db: Transaction<Database>) {}
  get(id: string) {
    return this.db.selectFrom('prescriptions').selectAll().where('id', '=', id).executeTakeFirst();
  }
  list(id: string, limit: number, offset: number, patient = false) {
    let q = this.db.selectFrom('prescriptions').selectAll().where('consultation_id', '=', id);
    if (patient) q = q.where('status', '=', 'finalized');
    return q
      .orderBy('version', 'desc')
      .limit(limit + 1)
      .offset(offset)
      .execute();
  }
  current(id: string) {
    return this.db
      .selectFrom('prescriptions')
      .selectAll()
      .where('consultation_id', '=', id)
      .where('status', '=', 'finalized')
      .executeTakeFirst();
  }
  async nextVersion(id: string) {
    const row = await this.db
      .selectFrom('prescriptions')
      .select(sql<number>`COALESCE(max(version),0)+1`.as('next'))
      .where('consultation_id', '=', id)
      .executeTakeFirstOrThrow();
    return row.next;
  }
  create(
    id: string,
    consultationId: string,
    doctorId: string,
    version: number,
    payload: JsonValue,
    correctionOf: string | null,
  ) {
    return this.db
      .insertInto('prescriptions')
      .values({
        id,
        consultation_id: consultationId,
        doctor_id: doctorId,
        version,
        clinical_payload: payload,
        correction_of: correctionOf,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async edit(id: string, payload: JsonValue) {
    await this.db
      .updateTable('prescriptions')
      .set({ clinical_payload: payload, revision: sql`revision+1` })
      .where('id', '=', id)
      .execute();
  }
  async finalize(id: string, now: Date) {
    await this.db
      .updateTable('prescriptions')
      .set({ status: 'finalized', finalized_at: now })
      .where('id', '=', id)
      .execute();
  }
  async revoke(id: string, reason: string, now: Date) {
    await this.db
      .updateTable('prescriptions')
      .set({ status: 'revoked', revoked_at: now, revocation_reason: reason })
      .where('id', '=', id)
      .execute();
  }
}
