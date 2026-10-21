import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, it, expect } from 'vitest';
import { startTelemetry, httpDuration } from '../../src/infrastructure/telemetry/runtime.js';

describe('runtime telemetry bootstrap', () => {
  it('exports instruments imported before SDK startup to the actual OTLP receiver', async () => {
    const received: string[] = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push(Buffer.concat(chunks).toString());
        response.setHeader('content-type', 'application/json');
        response.end('{}');
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No test receiver');
    const telemetry = await startTelemetry('api', {
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
      OTEL_SAMPLE_RATIO: '1',
    });
    try {
      httpDuration.record(0.01, { method: 'GET', route: '/ready', status: '200' });
      await expect
        .poll(() => received.join(''), { timeout: 12000 })
        .toContain('http_request_duration_seconds');
      expect(received.join('')).toContain('amrutam-api');
      expect(received.join('')).toContain('service.instance.id');
    } finally {
      await telemetry.shutdown();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 20000);
});
