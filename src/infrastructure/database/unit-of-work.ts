import type { Kysely, Transaction } from 'kysely';
import type { Database } from './types.js';

import type { UnitOfWork } from '../../shared/ports/unit-of-work.js';

export class PostgresUnitOfWork<TRepositories> implements UnitOfWork<TRepositories> {
  constructor(
    private readonly database: Kysely<Database>,
    private readonly createRepositories: (transaction: Transaction<Database>) => TRepositories,
  ) {}

  run<TResult>(work: (repositories: TRepositories) => Promise<TResult>): Promise<TResult> {
    return this.database
      .transaction()
      .setIsolationLevel('read committed')
      .execute((transaction) => work(this.createRepositories(transaction)));
  }
}
