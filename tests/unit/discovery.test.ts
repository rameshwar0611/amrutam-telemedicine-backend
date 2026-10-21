import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { DiscoveryService } from '../../src/modules/doctors/services/discovery.service.js';
import type { DirectoryStore, DirectoryCache } from '../../src/modules/doctors/domain/ports.js';
import type { SecurityRepositories } from '../../src/modules/identity/domain/ports.js';
import type { Actor } from '../../src/modules/identity/domain/security.js';
import type { UnitOfWork } from '../../src/shared/ports/unit-of-work.js';
import { discoveryQuerySchema } from '../../src/modules/doctors/schemas.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';

// Authorization is exercised by real restricted-role API integration tests.
const work: UnitOfWork<SecurityRepositories> = {
  run: (operation) => operation({} as SecurityRepositories),
};
const authorization = { require: vi.fn().mockResolvedValue({}) };
const actor: Actor = {
  userId: randomUUID(),
  sessionId: randomUUID(),
  authVersion: 1,
  role: 'patient',
};
const clock = { now: () => new Date('2035-01-01T00:00:00Z') };
const page = {
  items: [{ id: randomUUID(), name: 'Fresh Doctor', specialty: 'Ayurveda', biography: null }],
  limit: 20,
  offset: 0,
  hasMore: false,
};
function fixture() {
  const directory = {
    generation: vi.fn<DirectoryStore['generation']>().mockResolvedValue('current'),
    snapshot: vi
      .fn<DirectoryStore['snapshot']>()
      .mockResolvedValue({ generation: 'current', page }),
  };
  const cache = {
    get: vi.fn<DirectoryCache['get']>().mockResolvedValue(null),
    set: vi.fn<DirectoryCache['set']>().mockResolvedValue(undefined),
  };
  const service = new DiscoveryService(
    work,
    authorization,
    directory,
    cache,
    clock,
    createLogger('silent'),
  );
  return { directory, cache, service };
}
describe('directory cache consistency and fallback', () => {
  it('serves a validated hit without rerunning the directory query', async () => {
    const { directory, cache, service } = fixture();
    vi.mocked(cache.get).mockResolvedValue(JSON.stringify(page));
    expect(await service.search(actor, discoveryQuerySchema.parse({}))).toEqual(page);
    expect(directory.snapshot).not.toHaveBeenCalled();
    expect(directory.generation).toHaveBeenCalledTimes(2);
  });
  it('does not return a cache hit invalidated while Redis was being read', async () => {
    const { directory, cache, service } = fixture();
    vi.mocked(directory.generation).mockResolvedValueOnce('old').mockResolvedValueOnce('current');
    vi.mocked(cache.get).mockResolvedValue(JSON.stringify({ ...page, items: [] }));
    expect(await service.search(actor, discoveryQuerySchema.parse({}))).toEqual(page);
    expect(directory.snapshot).toHaveBeenCalledOnce();
  });
  it('bypasses Redis entirely when filtering by live availability', async () => {
    const { cache, service } = fixture();
    await service.search(
      actor,
      discoveryQuerySchema.parse({
        availableFrom: '2035-01-02T00:00:00Z',
        availableTo: '2035-01-03T00:00:00Z',
      }),
    );
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });
  it('returns the database result when both cache read and write fail', async () => {
    const { cache, service } = fixture();
    vi.mocked(cache.get).mockRejectedValue(new Error('offline'));
    vi.mocked(cache.set).mockRejectedValue(new Error('offline'));
    expect(await service.search(actor, discoveryQuerySchema.parse({}))).toEqual(page);
  });
  it('does not hide database failures behind an old cached response', async () => {
    const { directory, cache, service } = fixture();
    vi.mocked(directory.generation).mockRejectedValue(new Error('database offline'));
    vi.mocked(cache.get).mockResolvedValue(JSON.stringify(page));
    await expect(service.search(actor, discoveryQuerySchema.parse({}))).rejects.toThrow(
      'database offline',
    );
    expect(cache.get).not.toHaveBeenCalled();
  });
  it('rejects cached responses containing fields outside the public DTO', async () => {
    const { directory, cache, service } = fixture();
    vi.mocked(cache.get).mockResolvedValue(
      JSON.stringify({ ...page, items: [{ ...page.items[0], email: 'private@example.test' }] }),
    );
    expect(await service.search(actor, discoveryQuerySchema.parse({}))).toEqual(page);
    expect(directory.snapshot).toHaveBeenCalledOnce();
  });
});
