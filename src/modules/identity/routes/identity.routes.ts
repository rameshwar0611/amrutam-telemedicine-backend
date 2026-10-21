import { Router } from 'express';
import type { IdentityController } from '../controllers/identity.controller.js';
import type { SecurityMiddleware } from './security.middleware.js';

export function createIdentityRouter(
  controller: IdentityController,
  security: SecurityMiddleware,
): Router {
  const router = Router();
  router.use(security.ingress());
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.post(
    '/auth/register',
    security.limited('register', 'register'),
    controller.register.bind(controller),
  );
  router.post(
    '/auth/activate',
    security.limited('activate', 'mfa'),
    controller.activate.bind(controller),
  );
  router.post('/auth/login', security.limited('login', 'login'), controller.login.bind(controller));
  router.post(
    '/auth/refresh',
    security.limited('refresh', 'refresh'),
    controller.refresh.bind(controller),
  );
  router.post(
    '/auth/mfa/enroll',
    security.limited('mfa-enroll', 'mfa'),
    controller.enroll.bind(controller),
  );
  router.post(
    '/auth/mfa/confirm',
    security.limited('mfa-confirm', 'mfa'),
    controller.confirm.bind(controller),
  );
  router.post(
    '/auth/mfa/verify',
    security.limited('mfa-verify', 'mfa'),
    controller.verify.bind(controller),
  );
  router.post(
    '/auth/logout',
    security.authenticated(undefined, true),
    security.limited('logout', 'write'),
    controller.logout.bind(controller),
  );
  router.get(
    '/me',
    security.authenticated(),
    security.limited('profile-read', 'read'),
    controller.profile.bind(controller),
  );
  router.patch(
    '/me',
    security.authenticated(),
    security.limited('profile-write', 'write'),
    controller.patchProfile.bind(controller),
  );
  router.get(
    '/users/:userId/profile',
    security.authenticated(),
    security.limited('profile-read', 'read'),
    controller.profile.bind(controller),
  );
  router.patch(
    '/users/:userId/profile',
    security.authenticated(),
    security.limited('profile-write', 'write'),
    controller.patchProfile.bind(controller),
  );
  router.post(
    '/me/password',
    security.authenticated(),
    security.limited('password', 'write'),
    controller.password.bind(controller),
  );
  router.post(
    '/me/deactivate',
    security.authenticated(),
    security.limited('deactivate', 'write'),
    controller.deactivate.bind(controller),
  );
  router.get(
    '/me/sessions',
    security.authenticated(),
    security.limited('sessions', 'read'),
    controller.sessions.bind(controller),
  );
  router.delete(
    '/me/sessions/:sessionId',
    security.authenticated(),
    security.limited('session-revoke', 'write'),
    controller.revoke.bind(controller),
  );
  router.post(
    '/me/mfa/recovery-codes',
    security.authenticated(),
    security.limited('recovery-regenerate', 'mfa'),
    controller.recovery.bind(controller),
  );
  router.post(
    '/admin/users',
    security.authenticated(['admin']),
    security.limited('provision', 'admin'),
    controller.provision.bind(controller),
  );
  router.patch(
    '/admin/users/:userId/status',
    security.authenticated(['admin']),
    security.limited('account-status', 'write'),
    controller.status.bind(controller),
  );
  router.use(security.auditError());
  return router;
}
