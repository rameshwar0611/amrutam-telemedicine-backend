import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { Router } from 'express';
import request from 'supertest';
import { createApp } from '../../src/infrastructure/http/app.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';
import {
  recordDatabase,
  jobSpan,
  safeRoute,
  telemetryConfig,
} from '../../src/infrastructure/telemetry/runtime.js';
const exporter = new InMemorySpanExporter();
const sdk = new NodeSDK({
  autoDetectResources: false,
  spanProcessors: [new SimpleSpanProcessor(exporter)],
  metricReaders: [],
  logRecordProcessors: [],
});
beforeAll(() => sdk.start());
afterAll(() => sdk.shutdown());
describe('allowlisted telemetry', () => {
  it('captures real HTTP/database spans with propagated trace identity but no input data', async () => {
    const router = Router();
    router.post('/probe/:recordId', (_req, res) => {
      recordDatabase("SELECT 'PRIVATE_SQL_VALUE'", 3, false);
      res.json({ clinical: 'PRIVATE_RESPONSE' });
    });
    const app = createApp(Router(), createLogger('silent'), false, router);
    await request(app)
      .post('/v1/probe/private-record?email=PRIVATE_QUERY')
      .set('Authorization', 'Bearer PRIVATE_TOKEN')
      .set('traceparent', '00-11111111111111111111111111111111-2222222222222222-01')
      .send({ notes: 'PRIVATE_BODY' })
      .expect(200);
    const spans = exporter.getFinishedSpans();
    const http = spans.find((s) => s.name === 'HTTP POST /probe/:recordId');
    expect(http).toBeDefined();
    expect(http?.spanContext().traceId).toBe('11111111111111111111111111111111');
    const db = spans.find((s) => s.name === 'db.SELECT');
    expect(db?.parentSpanContext?.spanId).toBe(http?.spanContext().spanId);
    const serialized = JSON.stringify(
      spans.map((s) => ({ name: s.name, attributes: s.attributes, events: s.events })),
    );
    for (const value of ['PRIVATE_', 'private-record', 'email=', 'Bearer'])
      expect(serialized).not.toContain(value);
  });
  it('captures a real async worker span, drops unknown kind values and never records SQL', async () => {
    await jobSpan('PRIVATE_KIND', null, async () => {
      await Promise.resolve();
      recordDatabase('DELETE FROM sensitive WHERE token=PRIVATE_TOKEN', 2, true);
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.some((s) => s.name === 'worker unrecognized')).toBe(true);
    expect(JSON.stringify(spans.map((s) => s.attributes))).not.toContain('PRIVATE');
  });
  it('validates telemetry endpoints without echoing credentials', () => {
    expect(() =>
      telemetryConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://user:PRIVATE_SECRET@collector/' }),
    ).toThrow('Invalid telemetry configuration');
    expect(telemetryConfig({}).OTEL_ENABLED).toBe('false');
  });
  it('bounds route labels and rejects non-template values', () => {
    expect(safeRoute(undefined)).toBe('unmatched');
    expect(safeRoute('/bad?token=PRIVATE')).toBe('unmatched');
    expect(safeRoute('/x'.repeat(200))).toBe('unmatched');
  });
});
