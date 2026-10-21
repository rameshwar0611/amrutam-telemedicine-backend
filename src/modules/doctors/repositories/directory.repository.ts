import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { DirectoryStore } from '../domain/ports.js';
import type { DiscoveryQuery } from '../schemas.js';

export class DirectoryRepository implements DirectoryStore {
  constructor(private readonly db: Kysely<Database>) {}
  async generation() {
    return (
      await this.db
        .selectFrom('doctor_directory_revision')
        .select('generation')
        .where('id', '=', true)
        .executeTakeFirstOrThrow()
    ).generation;
  }
  async snapshot(query: DiscoveryQuery, now: Date) {
    return this.db
      .transaction()
      .setIsolationLevel('repeatable read')
      .execute(async (tx) => {
        const { generation } = await tx
          .selectFrom('doctor_directory_revision')
          .select('generation')
          .where('id', '=', true)
          .executeTakeFirstOrThrow();
        let select = tx
          .selectFrom('doctors as d')
          .innerJoin('users as u', 'u.id', 'd.user_id')
          .select(['d.id', 'd.public_name as name', 'd.specialty', 'd.biography'])
          .where('d.active', '=', true)
          .where('u.status', '=', 'active')
          .where('u.role', '=', 'doctor')
          .where('u.activated_at', 'is not', null);
        if (query.name) {
          const literal = query.name.replace(/[\\%_]/g, '\\$&');
          select = select.where('d.public_name', 'ilike', `%${literal}%`);
        }
        if (query.specialty)
          select = select.where(sql<string>`lower(d.specialty)`, '=', query.specialty);
        if (query.availableFrom && query.availableTo)
          select = select.where(sql<boolean>`EXISTS(
        SELECT 1 FROM availability_slots s WHERE s.doctor_id=d.id AND s.status='open'
          AND s.starts_at > ${now} AND s.starts_at >= ${query.availableFrom}::timestamptz AND s.ends_at <= ${query.availableTo}::timestamptz
          AND NOT EXISTS(SELECT 1 FROM consultations c WHERE c.slot_id=s.id AND c.status <> 'cancelled')
      )`);
        const rows = await select
          .orderBy(sql`lower(d.public_name)`)
          .orderBy('d.id')
          .limit(query.limit + 1)
          .offset(query.offset)
          .execute();
        return {
          generation,
          page: {
            items: rows.slice(0, query.limit),
            limit: query.limit,
            offset: query.offset,
            hasMore: rows.length > query.limit,
          },
        };
      });
  }
}
