import { sql, type Kysely } from 'kysely';
import type { Database } from '../../../infrastructure/database/types.js';
import type { DependencyProbe } from '../services/health.service.js';

export class DatabaseHealthRepository implements DependencyProbe {
  constructor(private readonly database: Kysely<Database>) {}

  async ping(): Promise<void> {
    await sql`select 1`.execute(this.database);
  }
}
