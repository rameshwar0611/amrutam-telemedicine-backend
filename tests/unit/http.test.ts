import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import SwaggerParser from '@apidevtools/swagger-parser';
import { createApp } from '../../src/infrastructure/http/app.js';
import { createLogger } from '../../src/infrastructure/logging/logger.js';
import { HealthService } from '../../src/modules/health/services/health.service.js';
import { HealthController } from '../../src/modules/health/controllers/health.controller.js';
import { createHealthRouter } from '../../src/modules/health/routes/health.routes.js';
import { openApiDocument } from '../../src/infrastructure/openapi/document.js';

function setup(failing = false, exposeOpenApi = true) {
  const postgres = {
    ping: vi.fn(() =>
      failing ? Promise.reject(new Error('private database detail')) : Promise.resolve(),
    ),
  };
  const redis = { ping: vi.fn(() => Promise.resolve()) };
  const service = new HealthService(postgres, redis);
  const controller = new HealthController(service);
  return {
    app: createApp(createHealthRouter(controller), createLogger('silent'), exposeOpenApi),
    service,
  };
}

describe('foundation HTTP contract', () => {
  it('reports liveness without checking dependencies', async () => {
    const { app } = setup(true);
    const response = await request(app).get('/health/live').expect(200);
    expect(response.body).toEqual({ status: 'alive' });
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
  it('reports successful dependency checks', async () => {
    const { app } = setup();
    expect((await request(app).get('/health/ready').expect(200)).body).toEqual({
      status: 'ready',
      dependencies: { postgres: 'up', redis: 'up' },
    });
  });
  it('reports failure without disclosing connection details', async () => {
    const { app } = setup(true);
    const response = await request(app).get('/health/ready').expect(503);
    expect(response.text).not.toContain('private database detail');
    expect(response.body).toEqual({
      status: 'not_ready',
      dependencies: { postgres: 'down', redis: 'up' },
    });
  });
  it('marks draining processes unready', async () => {
    const { app, service } = setup();
    service.markUnready();
    await request(app).get('/health/ready').expect(503);
    await request(app).get('/health/live').expect(200);
  });
  it('does not mount business routes when no application router is supplied', async () => {
    const { app } = setup();
    const response = await request(app).post('/v1/consultations').send({}).expect(404);
    expect(response.body).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
  it('handles malformed JSON and oversized bodies safely', async () => {
    const { app } = setup();
    const malformed = await request(app)
      .post('/missing')
      .set('Content-Type', 'application/json')
      .send('{')
      .expect(400);
    expect(malformed.body).toMatchObject({ error: { code: 'INVALID_JSON' } });
    await request(app)
      .post('/missing')
      .send({ value: 'x'.repeat(40_000) })
      .expect(413);
  });
  it('converts async failures to redacted errors', async () => {
    const { app, service } = setup();
    vi.spyOn(service, 'readiness').mockRejectedValueOnce(new Error('a secret stack trace'));
    const response = await request(app).get('/health/ready').expect(500);
    expect(response.body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(response.text).not.toContain('secret');
  });
  it('serves the API contract but not from the worker', async () => {
    expect((await request(setup().app).get('/openapi.json').expect(200)).body).toEqual(
      openApiDocument,
    );
    await request(setup(false, false).app).get('/openapi.json').expect(404);
  });
  it('validates the complete current OpenAPI document', async () => {
    await expect(SwaggerParser.validate('docs/openapi.json')).resolves.toBeDefined();
  });
});
