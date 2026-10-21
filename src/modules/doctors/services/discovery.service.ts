import { createHash } from 'node:crypto';
import type { Logger } from 'pino';
import type { UnitOfWork } from '../../../shared/ports/unit-of-work.js';
import { canonicalJson, toJson } from '../../../shared/json.js';
import type { SecurityRepositories } from '../../identity/domain/ports.js';
import type { Actor, Clock } from '../../identity/domain/security.js';
import type { AuthorizationService } from '../../identity/services/authorization.service.js';
import type { DirectoryCache, DirectoryStore } from '../domain/ports.js';
import { doctorPageSchema, type DiscoveryQuery } from '../schemas.js';
export class DiscoveryService {
  constructor(
    private readonly work: UnitOfWork<SecurityRepositories>,
    private readonly authorization: Pick<AuthorizationService, 'require'>,
    private readonly directory: DirectoryStore,
    private readonly cache: DirectoryCache,
    private readonly clock: Clock,
    private readonly logger: Logger,
  ) {}
  async search(actor: Actor, query: DiscoveryQuery) {
    await this.work.run((r) => this.authorization.require(r, actor));
    // No Redis I/O occurs inside an authorization or database snapshot transaction.
    if (query.availableFrom) return (await this.directory.snapshot(query, this.clock.now())).page;
    const generation = await this.directory.generation();
    const digest = createHash('sha256')
      .update(canonicalJson(toJson(query)))
      .digest('hex');
    const key = (version: string) => `directory:v1:${version}:${digest}`;
    try {
      const raw = await this.cache.get(key(generation));
      if (raw) {
        const parsed = doctorPageSchema.safeParse(JSON.parse(raw));
        // Recheck after Redis I/O to reject invalidation during a read.
        if (
          parsed.success &&
          parsed.data.limit === query.limit &&
          parsed.data.offset === query.offset &&
          (await this.directory.generation()) === generation
        )
          return parsed.data;
      }
    } catch {
      this.logger.warn({ event: 'directory_cache_read_unavailable' }, 'Directory cache bypassed');
    }
    const snapshot = await this.directory.snapshot(query, this.clock.now());
    try {
      await this.cache.set(key(snapshot.generation), JSON.stringify(snapshot.page), 30);
    } catch {
      this.logger.warn(
        { event: 'directory_cache_write_unavailable' },
        'Directory cache write skipped',
      );
    }
    return snapshot.page;
  }
}
