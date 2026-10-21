import { traceLogFields } from '../telemetry/runtime.js';
import pino from 'pino';

export function createLogger(level = 'info') {
  return pino({
    level,
    mixin: traceLogFields,
    base: { service: 'amrutam-backend' },
    redact: {
      paths: [
        'password',
        'token',
        'secret',
        'DATABASE_URL',
        'REDIS_URL',
        'req.headers.authorization',
        'req.headers.cookie',
      ],
      censor: '[REDACTED]',
    },
  });
}
