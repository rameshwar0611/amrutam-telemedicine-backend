import { afterEach, describe, expect, it, vi } from 'vitest';
import { HealthService } from '../../src/modules/health/services/health.service.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('readiness deadlines', () => {
  it('does not hang forever on an unresponsive dependency', async () => {
    vi.useFakeTimers();
    const service = new HealthService(
      { ping: () => new Promise<void>(() => undefined) },
      { ping: () => Promise.resolve() },
    );
    const readiness = service.readiness();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await readiness).toEqual({
      status: 'not_ready',
      dependencies: { postgres: 'down', redis: 'up' },
    });
  });
});
