import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { open, readFile, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';

// Local stack plus an isolated test DB; never enqueue synthetic events in real data.
const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? '');
assert.ok(databaseUrl.pathname.endsWith('_test'));
assert.equal(new URL(process.env.TEST_REDIS_URL ?? '').pathname, '/15');
assert.ok(process.argv.includes('--allow-isolated-test-job'));
const traceId = randomBytes(16).toString('hex');
const parent = `00-${traceId}-${randomBytes(8).toString('hex')}-01`;
const marker = 'PRIVACY_PROBE_CLINICAL_SECRET';
const pool = new pg.Pool({ connectionString: databaseUrl.toString() });
const jobId = randomUUID();
const log = await open('work/telemetry-worker.log', 'w', 0o600);
let worker;
async function until(operation, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await delay(500);
    }
  }
}
async function json(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return response.json();
}
try {
  await json('http://127.0.0.1:13133/');
  await json('http://127.0.0.1:3002/api/health');
  await pool.query(
    'INSERT INTO outbox_jobs(id,kind,deduplication_key,payload,trace_parent) VALUES($1,$2,$3,$4,$5)',
    [
      jobId,
      'consultation.booked',
      `telemetry-smoke:${jobId}`,
      { consultationId: randomUUID() },
      parent,
    ],
  );
  databaseUrl.searchParams.set('options', '-c role=amrutam_worker');
  const proxy = Object.fromEntries(
    ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  worker = spawn(process.execPath, ['dist/entrypoints/worker.js'], {
    env: {
      ...proxy,
      PATH: process.env.PATH,
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl.toString(),
      DATABASE_SSL_MODE: 'disable',
      REDIS_URL: process.env.TEST_REDIS_URL,
      WORKER_HEALTH_PORT: '3012',
      WORKER_POLL_MS: '100',
      OTEL_ENABLED: 'true',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318',
      OTEL_SAMPLE_RATIO: '1',
    },
    stdio: ['ignore', log.fd, log.fd],
  });
  await until(async () => {
    const result = await pool.query('SELECT status FROM outbox_jobs WHERE id=$1', [jobId]);
    assert.equal(result.rows[0]?.status, 'completed');
  });
  const ready = await fetch(`http://127.0.0.1:3000/health/ready?notes=${marker}`, {
    headers: { traceparent: parent, Authorization: `Bearer ${marker}` },
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(ready.status, 200);
  await fetch(`http://127.0.0.1:3000/v1/not-found?notes=${marker}`, {
    method: 'POST',
    headers: { traceparent: parent, 'Content-Type': 'application/json' },
    body: JSON.stringify({ clinicalNotes: marker }),
    signal: AbortSignal.timeout(5000),
  });
  const trace = await until(async () => {
    const value = await json(`http://127.0.0.1:3200/api/traces/${traceId}`);
    const serialized = JSON.stringify(value);
    for (const name of [
      'HTTP GET /ready',
      'db.SELECT',
      'worker consultation.booked',
      'amrutam-api',
      'amrutam-worker',
    ])
      assert.ok(serialized.includes(name), `Missing trace component: ${name}`);
    assert.ok(!serialized.includes(marker));
    assert.ok(!serialized.includes('db.statement'));
    return value;
  });
  const metrics = await until(async () => {
    const result = await fetch('http://127.0.0.1:8889/metrics');
    const value = await result.text();
    for (const name of [
      'http_request_duration_seconds_count',
      'db_operation_duration_seconds_count',
      'worker_jobs_total',
    ])
      assert.ok(value.includes(name), `Missing metric: ${name}`);
    assert.ok(!value.includes(marker));
    return value;
  });
  await until(async () => {
    const value = await json(
      'http://127.0.0.1:9090/api/v1/query?query=up%7Bjob%3D%22amrutam%22%7D',
    );
    assert.equal(value.data.result[0]?.value[1], '1');
  });
  assert.ok(!(await readFile('work/telemetry-worker.log', 'utf8')).includes(marker));
  await writeFile('work/telemetry-smoke-trace.json', JSON.stringify(trace, null, 2), {
    mode: 0o600,
  });
  await writeFile('work/telemetry-smoke-metrics.txt', metrics, { mode: 0o600 });
  console.log(
    'PASS: real API + PostgreSQL + isolated worker trace, collector metrics, Prometheus scrape and Grafana health; privacy marker absent.',
  );
} finally {
  if (worker && worker.exitCode === null) {
    worker.kill('SIGTERM');
    await Promise.race([once(worker, 'exit'), delay(12000)]);
    if (worker.exitCode === null) worker.kill('SIGKILL');
  }
  await log.close();
  await pool.end();
}
