import { traceParent } from '../../../infrastructure/telemetry/runtime.js';
import { sql, type Transaction } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { BookingStore } from '../domain/ports.js';
import type { AvailabilityQuery, SlotInput } from '../schemas.js';
import type { JsonValue } from '../../../shared/json.js';

export class BookingRepository implements BookingStore {
  constructor(private readonly db: Transaction<Database>) {}
  doctor(id: string) {
    return this.db
      .selectFrom('doctors as d')
      .innerJoin('users as u', 'u.id', 'd.user_id')
      .selectAll('d')
      .select(
        sql<boolean>`(u.status='active' AND u.role='doctor' AND u.activated_at IS NOT NULL)`.as(
          'account_active',
        ),
      )
      .where('d.id', '=', id)
      .forShare('d')
      .executeTakeFirst();
  }
  slot(id: string, lock = false) {
    let query = this.db.selectFrom('availability_slots').selectAll().where('id', '=', id);
    if (lock) query = query.forUpdate();
    return query.executeTakeFirst();
  }
  createSlot(doctorId: string, input: SlotInput) {
    return this.db
      .insertInto('availability_slots')
      .values({ doctor_id: doctorId, starts_at: input.startsAt, ends_at: input.endsAt })
      .returningAll()
      .executeTakeFirstOrThrow();
  }
  async blockSlot(id: string) {
    await this.db
      .updateTable('availability_slots')
      .set({ status: 'blocked' })
      .where('id', '=', id)
      .execute();
  }
  async occupied(slotId: string) {
    return !!(await this.db
      .selectFrom('consultations')
      .select('id')
      .where('slot_id', '=', slotId)
      .where('status', '!=', 'cancelled')
      .executeTakeFirst());
  }
  async listSlots(doctorId: string, query: AvailabilityQuery, own: boolean, now: Date) {
    let select = this.db
      .selectFrom('availability_slots as s')
      .selectAll('s')
      .select(
        sql<boolean>`EXISTS(SELECT 1 FROM consultations c WHERE c.slot_id=s.id AND c.status <> 'cancelled')`.as(
          'occupied',
        ),
      )
      .where('s.doctor_id', '=', doctorId);
    if (!own)
      select = select
        .where('s.status', '=', 'open')
        .where('s.starts_at', '>', now)
        .where(
          sql<boolean>`NOT EXISTS(SELECT 1 FROM consultations c WHERE c.slot_id=s.id AND c.status <> 'cancelled')`,
        );
    if (query.from) select = select.where('s.starts_at', '>=', new Date(query.from));
    if (query.to) select = select.where('s.ends_at', '<=', new Date(query.to));
    return select
      .orderBy('s.starts_at')
      .orderBy('s.id')
      .limit(query.limit + 1)
      .offset(query.offset)
      .execute();
  }
  consultation(id: string, lock = false) {
    let query = this.db
      .selectFrom('consultations as c')
      .innerJoin('availability_slots as s', 's.id', 'c.slot_id')
      .innerJoin('doctors as d', 'd.id', 'c.doctor_id')
      .select([
        'c.id',
        'c.slot_id',
        'c.doctor_id',
        'c.patient_id',
        'c.status',
        'c.version',
        'c.cancelled_at',
        'c.cancellation_reason',
      ])
      .select(['s.starts_at', 's.ends_at', 'd.user_id as doctor_user_id'])
      .where('c.id', '=', id);
    if (lock) query = query.forUpdate('c');
    return query.executeTakeFirst();
  }
  async book(slotId: string, doctorId: string, patientId: string) {
    const row = await this.db
      .insertInto('consultations')
      .values({ slot_id: slotId, doctor_id: doctorId, patient_id: patientId })
      .returning('id')
      .executeTakeFirstOrThrow();
    return (await this.consultation(row.id))!;
  }
  async cancel(id: string, reason: string, now: Date) {
    await this.db
      .updateTable('consultations')
      .set({
        status: 'cancelled',
        cancelled_at: now,
        cancellation_reason: reason,
        version: sql`version+1`,
      })
      .where('id', '=', id)
      .execute();
    return (await this.consultation(id))!;
  }
  async enqueue(
    kind: 'consultation.booked' | 'consultation.cancelled',
    id: string,
    payload: JsonValue,
  ) {
    await this.db
      .insertInto('outbox_jobs')
      .values({ kind, deduplication_key: `${kind}:${id}`, payload, trace_parent: traceParent() })
      .execute();
  }
}
