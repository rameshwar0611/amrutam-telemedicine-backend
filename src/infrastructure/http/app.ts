import { telemetryHttp } from '../telemetry/runtime.js';
import { randomUUID } from 'node:crypto';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import type { Logger } from 'pino';
import { createErrorHandler, notFound } from './errors.js';
import { openApiDocument } from '../openapi/document.js';

export function createApp(
  healthRouter: Router,
  logger: Logger,
  exposeOpenApi = true,
  identityRouter?: Router,
  trustedProxies: string[] = [],
): Express {
  const app = express();
  app.disable('x-powered-by');
  // No trusted proxies by default. Production proxy topology must be configured explicitly.
  app.set('trust proxy', trustedProxies.length ? trustedProxies : false);
  app.use((_request, response, next) => {
    const requestId = randomUUID();
    response.locals.requestId = requestId;
    response.setHeader('X-Request-Id', requestId);
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use(telemetryHttp());
  app.use(
    pinoHttp({
      logger,
      genReqId: (_request, response) => response.getHeader('X-Request-Id') as string,
      serializers: {
        req: (request: { id: string; method: string; url: string }) => ({
          id: request.id,
          method: request.method,
        }),
        res: (response: { statusCode: number }) => ({ statusCode: response.statusCode }),
      },
    }),
  );
  app.use(helmet());
  app.use(express.json({ limit: '32kb', strict: true }));
  app.use('/health', healthRouter);
  if (identityRouter) app.use('/v1', identityRouter);
  if (exposeOpenApi)
    app.get('/openapi.json', (_request, response) => {
      response.json(openApiDocument);
    });
  app.use(notFound);
  app.use(createErrorHandler(logger));
  return app;
}
