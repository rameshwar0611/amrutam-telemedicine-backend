import { context, propagation, trace, metrics, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

const tracer = trace.getTracer('amrutam.safe');
function instruments() {
  const meter = metrics.getMeter('amrutam.safe');
  return {
    httpDuration: meter.createHistogram('http_request_duration_seconds', {
      unit: 's',
      advice: { explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5] },
    }),
    dbDuration: meter.createHistogram('db_operation_duration_seconds', { unit: 's' }),
    bookingConflicts: meter.createCounter('booking_conflicts_total'),
    authFailures: meter.createCounter('auth_failures_total'),
    workerJobs: meter.createCounter('worker_jobs_total'),
    poolGauge: meter.createGauge('db_pool_connections'),
    backlogGauge: meter.createGauge('worker_backlog'),
    oldestGauge: meter.createGauge('worker_oldest_pending_seconds'),
  };
}
// Unlike tracers, API meters obtained before SDK registration are no-ops.
// Rebind live ESM exports after registration, before constructing the application.
export let {
  httpDuration,
  dbDuration,
  bookingConflicts,
  authFailures,
  workerJobs,
  poolGauge,
  backlogGauge,
  oldestGauge,
} = instruments();
export const telemetrySchema = z.object({
  OTEL_ENABLED: z.enum(['true', 'false']).default('false'),
  OTEL_EXPORTER_OTLP_ENDPOINT: z
    .url()
    .default('http://localhost:4318')
    .refine((value) => {
      const u = new URL(value);
      return (
        ['http:', 'https:'].includes(u.protocol) &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        u.pathname === '/'
      );
    }),
  OTEL_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1),
});
export function telemetryConfig(input: NodeJS.ProcessEnv = process.env) {
  const result = telemetrySchema.safeParse(input);
  if (!result.success) throw new Error('Invalid telemetry configuration');
  return result.data;
}
export async function startTelemetry(
  service: 'api' | 'worker' | 'maintenance',
  input: NodeJS.ProcessEnv = process.env,
) {
  const config = telemetryConfig(input);
  if (config.OTEL_ENABLED !== 'true') return { shutdown: () => Promise.resolve() };
  const { ParentBasedSampler, TraceIdRatioBasedSampler } =
    await import('@opentelemetry/sdk-trace-base');
  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes({
      'service.name': `amrutam-${service}`,
      'service.version': '0.5.0',
      // Distinguish cumulative metrics from concurrent replicas without host/env data.
      'service.instance.id': randomUUID(),
    }),
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(config.OTEL_SAMPLE_RATIO),
    }),
    traceExporter: new OTLPTraceExporter({
      url: new URL('/v1/traces', config.OTEL_EXPORTER_OTLP_ENDPOINT).toString(),
      timeoutMillis: 2000,
    }),
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          url: new URL('/v1/metrics', config.OTEL_EXPORTER_OTLP_ENDPOINT).toString(),
          timeoutMillis: 2000,
        }),
        exportIntervalMillis: 5000,
        exportTimeoutMillis: 3000,
      }),
    ],
  });
  sdk.start();
  ({
    httpDuration,
    dbDuration,
    bookingConflicts,
    authFailures,
    workerJobs,
    poolGauge,
    backlogGauge,
    oldestGauge,
  } = instruments());
  return { shutdown: () => sdk.shutdown() };
}
const traceParentPattern = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;
export function traceParent(): string | null {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent && traceParentPattern.test(carrier.traceparent)
    ? carrier.traceparent
    : null;
}
export function safeParent(value: unknown) {
  return typeof value === 'string' && traceParentPattern.test(value)
    ? propagation.extract(context.active(), { traceparent: value })
    : context.active();
}
export function safeRoute(value: unknown): string {
  return typeof value === 'string' && /^\/[A-Za-z0-9_/:{}.-]*$/.test(value) && value.length < 180
    ? value
    : 'unmatched';
}
export function telemetryHttp(): RequestHandler {
  return (request, response, next) => {
    const method = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'OPTIONS'].includes(
      request.method,
    )
      ? request.method
      : 'OTHER';
    const span = tracer.startSpan(
      'HTTP request',
      { kind: SpanKind.SERVER },
      safeParent(request.get('traceparent')),
    );
    const start = performance.now();
    let ended = false;
    response.once('finish', () => finish(false));
    response.once('close', () => finish(!response.writableFinished));
    function finish(aborted: boolean) {
      if (ended) return;
      ended = true;
      const route = safeRoute((request.route as { path?: unknown } | undefined)?.path);
      const status = aborted ? 499 : response.statusCode;
      span.updateName(`HTTP ${method} ${route}`);
      span.setAttributes({
        'http.request.method': method,
        'http.route': route,
        'http.response.status_code': status,
      });
      if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      span.end();
      const labels = { method, route, status: String(status) };
      httpDuration.record((performance.now() - start) / 1000, labels);
      if (status === 409 && route === '/consultations') bookingConflicts.add(1);
      if ([401, 403, 429].includes(status))
        authFailures.add(1, {
          reason:
            status === 429 ? 'rate_limited' : status === 401 ? 'unauthenticated' : 'forbidden',
        });
    }
    context.with(trace.setSpan(context.active(), span), next);
  };
}
const operations = new Set([
  'SELECT',
  'INSERT',
  'UPDATE',
  'DELETE',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'SET',
  'TRUNCATE',
]);
export function recordDatabase(sql: string, durationMs: number, failed: boolean) {
  const candidate = sql.trimStart().split(/\s/, 1)[0]?.toUpperCase() ?? '';
  const operation = operations.has(candidate) ? candidate : 'OTHER';
  const end = Date.now();
  const span = tracer.startSpan(`db.${operation}`, {
    kind: SpanKind.CLIENT,
    startTime: end - durationMs,
    attributes: { 'db.system.name': 'postgresql', 'db.operation.name': operation },
  });
  if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end(end);
  dbDuration.record(durationMs / 1000, { operation, outcome: failed ? 'error' : 'success' });
}
const knownKinds = new Set([
  'consultation.booked',
  'consultation.cancelled',
  'consultation.in_progress',
  'consultation.completed',
  'consultation.no_show',
  'prescription.finalized',
  'prescription.revoked',
  'payment.created',
  'payment.authorized',
  'payment.paid',
  'payment.failed',
  'payment.cancelled',
  'payment.refund_requested',
]);
export async function jobSpan<T>(
  kind: string,
  parent: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  const label = knownKinds.has(kind) ? kind : 'unrecognized';
  return tracer.startActiveSpan(
    `worker ${label}`,
    { kind: SpanKind.CONSUMER, attributes: { 'job.kind': label } },
    safeParent(parent),
    async (span) => {
      try {
        return await operation();
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
export function traceLogFields() {
  const current = trace.getSpan(context.active())?.spanContext();
  return current ? { traceId: current.traceId, spanId: current.spanId } : {};
}
