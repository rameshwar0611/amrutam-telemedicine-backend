import { Writable } from 'node:stream';
import pino from 'pino';
import request from 'supertest';
import { Router } from 'express';
import { expect, it } from 'vitest';
import { createApp } from '../../src/infrastructure/http/app.js';

it('omits credentials, query values and request/response bodies from HTTP logs', async () => {
  const records: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      records.push(chunk.toString());
      callback();
    },
  });
  const logger = pino({ level: 'info' }, destination);
  const app = createApp(Router(), logger, false);
  await request(app)
    .post('/missing?token=query-secret-test-value')
    .set('Authorization', 'Bearer bearer-secret-test-value')
    .set('Cookie', 'session=cookie-secret-test-value')
    .send({
      password: 'body-secret-test-value',
      code: 'otp-secret-test-value',
      notes: { summary: 'private-clinical-summary' },
      medications: [{ name: 'private-prescription-name' }],
    })
    .expect(404);
  const logs = records.join('');
  expect(logs).toContain('statusCode');
  for (const secret of [
    'query-secret-test-value',
    'bearer-secret-test-value',
    'cookie-secret-test-value',
    'body-secret-test-value',
    'otp-secret-test-value',
    'private-clinical-summary',
    'private-prescription-name',
  ])
    expect(logs.includes(secret)).toBe(false);
});
