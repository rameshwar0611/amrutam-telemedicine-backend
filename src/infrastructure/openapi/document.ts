import { clinicalPaths, clinicalSchemas } from './clinical.js';
import { bookingPaths, bookingSchemas } from './booking.js';
import { z } from 'zod';
import { errorSchema } from '../http/errors.js';
import { livenessSchema, readinessSchema } from '../../modules/health/schemas.js';
import { identityPaths, identitySchemas } from './identity.js';

export const openApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Amrutam Backend API',
    version: '0.4.0',
    description:
      'Phase 4: identity/MFA, discovery, availability, booking, encrypted clinical records, prescription versions, internal fake payments, durable jobs and admin audit/analytics. No real payment or email provider is configured.',
  },
  servers: [{ url: '/', description: 'Current server' }],
  paths: {
    ...identityPaths,
    ...bookingPaths,
    ...clinicalPaths,
    '/health/live': {
      get: {
        operationId: 'getLiveness',
        tags: ['Health'],
        responses: {
          '200': {
            description: 'Process is alive',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Liveness' } } },
          },
        },
      },
    },
    '/health/ready': {
      get: {
        operationId: 'getReadiness',
        tags: ['Health'],
        responses: {
          '200': {
            description: 'Dependencies available and accepting traffic',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Readiness' } } },
          },
          '503': {
            description: 'Dependency unavailable or draining',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Readiness' } } },
          },
        },
      },
    },
    '/openapi.json': {
      get: {
        operationId: 'getOpenApi',
        tags: ['Documentation'],
        responses: {
          '200': {
            description: 'OpenAPI 3.1 document',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
  },
  components: {
    securitySchemes: {
      AccessToken: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description: 'Full MFA-authenticated access token; live account/session state is checked.',
      },
      MfaChallenge: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        description:
          'Short-lived password-authenticated challenge; cannot access protected application routes.',
      },
    },
    schemas: {
      ...identitySchemas,
      ...bookingSchemas,
      ...clinicalSchemas,
      Liveness: z.toJSONSchema(livenessSchema),
      Readiness: z.toJSONSchema(readinessSchema),
      Error: z.toJSONSchema(errorSchema),
    },
  },
};
