import { z } from 'zod';
import * as schemas from '../../modules/identity/schemas.js';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: object) => ({ 'application/json': { schema } });
const result = (name: string, description = 'Success') => ({
  description,
  content: json(ref(name)),
});
const idempotency = {
  name: 'Idempotency-Key',
  in: 'header',
  required: true,
  description:
    'New key for each logical write; identical authorized retries replay the original result. Authentication credentials are still required.',
  schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,128}$' },
};
const errors = Object.fromEntries(
  [400, 401, 403, 404, 409, 413, 415, 429, 500, 503].map((status) => [
    String(status),
    result(
      'Error',
      (
        {
          400: 'Invalid input',
          401: 'Invalid authentication',
          403: 'Forbidden or fresh MFA needed',
          404: 'Not found',
          409: 'Conflict or expired idempotency key',
          413: 'Body too large',
          415: 'Unsupported encoding or charset',
          429: 'Rate limited; Retry-After header specifies seconds',
          500: 'Internal error',
          503: 'Security dependency unavailable',
        } as Record<number, string>
      )[status],
    ),
  ]),
);
function operation(
  id: string,
  options: {
    request?: string;
    response?: string;
    status?: number;
    auth?: 'access' | 'challenge';
    write?: boolean;
    parameter?: 'userId' | 'sessionId';
    description?: string;
  },
) {
  return {
    operationId: id,
    tags: ['Identity'],
    description:
      options.description ??
      'Responses are not cacheable. Errors do not disclose credentials or account existence.',
    security: options.auth
      ? [{ [options.auth === 'access' ? 'AccessToken' : 'MfaChallenge']: [] }]
      : [],
    parameters: [
      ...(options.write ? [idempotency] : []),
      ...(options.parameter
        ? [
            {
              name: options.parameter,
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ]
        : []),
    ],
    ...(options.request
      ? { requestBody: { required: true, content: json(ref(options.request)) } }
      : {}),
    responses: {
      ...errors,
      [String(options.status ?? 200)]: options.response
        ? result(options.response)
        : { description: 'Success; no response body' },
    },
  };
}

export const identityPaths = {
  '/v1/auth/register': {
    post: operation('registerPatient', {
      write: true,
      request: 'RegisterRequest',
      response: 'Accepted',
      status: 202,
      description:
        'Public patient registration only. Same generic response for existing accounts. Encrypted setup delivery is queued; no email provider is configured.',
    }),
  },
  '/v1/auth/activate': {
    post: operation('activateAccount', {
      write: true,
      request: 'ActivationRequest',
      response: 'Challenge',
      description:
        'Consumes a setup token and always sets the recipient-chosen password. An earlier registration password cannot remain valid unless the recipient chooses it again. Returns an enrollment-only challenge, never application access.',
    }),
  },
  '/v1/auth/login': {
    post: operation('verifyPassword', {
      write: true,
      request: 'LoginRequest',
      response: 'Challenge',
    }),
  },
  '/v1/auth/refresh': {
    post: operation('rotateRefreshToken', {
      write: true,
      request: 'RefreshRequest',
      response: 'Tokens',
      description:
        'One-time rotation. Identical key and credential may replay for 30 seconds by default. Known consumed credential with a new key revokes the session family. Absolute session expiry is not extended.',
    }),
  },
  '/v1/auth/mfa/enroll': {
    post: operation('beginMfaEnrollment', {
      auth: 'challenge',
      write: true,
      request: 'EmptyRequest',
      response: 'Enrollment',
      description:
        'Password-authenticated enrollment challenge only. Sole approved secret-provisioning exception: URI contains the seed. Persisted retry result is encrypted and short-lived; URI is unavailable after confirmation.',
    }),
  },
  '/v1/auth/mfa/confirm': {
    post: operation('confirmMfaEnrollment', {
      auth: 'challenge',
      write: true,
      request: 'OtpRequest',
      response: 'Tokens',
      description:
        'Confirms TOTP, activates account and issues full access plus recovery codes for this one logical operation.',
    }),
  },
  '/v1/auth/mfa/verify': {
    post: operation('verifyMfaChallenge', {
      auth: 'challenge',
      write: true,
      request: 'MfaRequest',
      response: 'Tokens',
    }),
  },
  '/v1/auth/logout': {
    post: operation('logoutSession', {
      auth: 'access',
      write: true,
      status: 204,
      description:
        'Revokes current session. This endpoint alone permits a still-valid access token from its already revoked session for a safe logout retry.',
    }),
  },
  '/v1/me': {
    get: operation('getOwnProfile', { auth: 'access', response: 'User' }),
    patch: operation('updateOwnProfile', {
      auth: 'access',
      write: true,
      request: 'ProfilePatch',
      response: 'User',
    }),
  },
  '/v1/users/{userId}/profile': {
    get: operation('getProfile', {
      auth: 'access',
      parameter: 'userId',
      response: 'User',
      description: 'Own profile only; administrative role does not bypass resource ownership.',
    }),
    patch: operation('updateProfile', {
      auth: 'access',
      write: true,
      parameter: 'userId',
      request: 'ProfilePatch',
      response: 'User',
    }),
  },
  '/v1/me/password': {
    post: operation('changePassword', {
      auth: 'access',
      write: true,
      request: 'PasswordChange',
      status: 204,
      description:
        'Current password plus MFA within five minutes. Increments auth version and revokes all sessions atomically; sign in again after success.',
    }),
  },
  '/v1/me/deactivate': {
    post: operation('deactivateAccount', {
      auth: 'access',
      write: true,
      request: 'Deactivate',
      status: 204,
      description:
        'Own non-admin account only. Requires current password and MFA within five minutes; revokes all sessions atomically.',
    }),
  },
  '/v1/me/sessions': {
    get: operation('listOwnSessions', { auth: 'access', response: 'Sessions' }),
  },
  '/v1/me/sessions/{sessionId}': {
    delete: operation('revokeOwnSession', {
      auth: 'access',
      write: true,
      parameter: 'sessionId',
      status: 204,
    }),
  },
  '/v1/me/mfa/recovery-codes': {
    post: operation('regenerateRecoveryCodes', {
      auth: 'access',
      write: true,
      request: 'RecoveryRegenerate',
      response: 'RecoveryCodes',
      description:
        'Requires password, recent MFA and a fresh unused TOTP. Replaces all old recovery codes; encrypted result replays briefly for the same logical request.',
    }),
  },
  '/v1/admin/users': {
    post: operation('provisionPrivilegedAccount', {
      auth: 'access',
      write: true,
      request: 'ProvisionRequest',
      response: 'User',
      status: 201,
      description:
        'Admin role and MFA within five minutes. Creates pending doctor/admin account with secure setup token; no default password or public self-promotion.',
    }),
  },
  '/v1/admin/users/{userId}/status': {
    patch: operation('changeAccountStatus', {
      auth: 'access',
      write: true,
      parameter: 'userId',
      request: 'StatusChange',
      status: 204,
      description:
        'Admin with recent MFA. Cannot target self or bypass account activation. All target sessions revoked and auth version incremented.',
    }),
  },
};

const input = (schema: z.ZodType) => z.toJSONSchema(schema, { io: 'input' });
export const identitySchemas = {
  RegisterRequest: input(schemas.registerSchema),
  ActivationRequest: input(schemas.activateSchema),
  LoginRequest: input(schemas.loginSchema),
  RefreshRequest: input(schemas.refreshSchema),
  EmptyRequest: input(schemas.emptySchema),
  OtpRequest: input(schemas.otpSchema),
  MfaRequest: input(schemas.verifyMfaSchema),
  ProfilePatch: input(schemas.profilePatchSchema),
  PasswordChange: input(schemas.passwordChangeSchema),
  Deactivate: input(schemas.deactivateSchema),
  RecoveryRegenerate: input(schemas.recoveryRegenerateSchema),
  ProvisionRequest: input(schemas.provisionSchema),
  StatusChange: input(schemas.statusChangeSchema),
  User: z.toJSONSchema(schemas.userDtoSchema),
  Challenge: z.toJSONSchema(schemas.challengeResponseSchema),
  Tokens: z.toJSONSchema(schemas.tokenResponseSchema),
  Enrollment: z.toJSONSchema(schemas.enrollmentResponseSchema),
  Accepted: z.toJSONSchema(schemas.genericAcceptedSchema),
  Sessions: z.toJSONSchema(z.object({ sessions: z.array(schemas.sessionDtoSchema) })),
  RecoveryCodes: z.toJSONSchema(z.object({ recoveryCodes: z.array(z.string()) })),
};
