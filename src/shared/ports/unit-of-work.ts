export interface UnitOfWork<TRepositories> {
  run<TResult>(work: (repositories: TRepositories) => Promise<TResult>): Promise<TResult>;
}
