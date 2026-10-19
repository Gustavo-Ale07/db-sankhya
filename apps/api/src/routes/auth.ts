import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AppError } from '@dbx/shared';
import { isWeakPassword } from '../config';
import { verifyDummy, verifyPassword } from '../security/crypto';
import { toPublicUser } from '../services/users';
import { clientIp, noStore, parseBody, requireAuth } from '../http';

const loginBody = z
  .object({
    email: z.string().trim().max(254),
    password: z.string().min(1).max(512),
  })
  .strict();

const changePasswordBody = z
  .object({
    currentPassword: z.string().min(1).max(512),
    newPassword: z.string().min(12).max(512),
  })
  .strict();

export function passwordPolicyError(password: string): AppError | null {
  return isWeakPassword(password)
    ? new AppError(
        'VALIDATION_ERROR',
        'Password must have 12+ characters mixing upper case, lower case, digits and symbols',
        {
          field: 'password',
        },
      )
    : null;
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const { users, sessions, audit, config, authz } = app.services;

  const setSessionCookie = (reply: FastifyReply, token: string, expiresAt: Date) => {
    void reply.setCookie(config.session.cookieName, token, {
      httpOnly: true,
      secure: config.session.secureCookie,
      sameSite: 'strict',
      path: '/',
      expires: expiresAt,
    });
  };

  app.post(
    '/api/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      const body = parseBody(loginBody, request.body);
      const email = body.email.toLowerCase();
      const user = await users.findByEmail(email);
      const ip = clientIp(request);
      const fail = async (code: 'INVALID_CREDENTIALS' | 'ACCOUNT_LOCKED', reason: string) => {
        await audit.record({
          action: 'auth.login_failed',
          status: 'denied',
          userId: user?.id ?? null,
          userEmail: email.slice(0, 254),
          ip,
          requestId: request.id,
          errorCode: code,
          details: { reason },
        });
        // Locked accounts get the same answer as bad credentials, so lockouts cannot be used to
        // find out which e-mails exist; the lock is visible in the audit log.
        throw new AppError(
          'INVALID_CREDENTIALS',
          'Invalid e-mail or password. Repeated failures lock the account for a while.',
        );
      };

      if (!user) {
        await verifyDummy(body.password);
        return fail('INVALID_CREDENTIALS', 'unknown_user');
      }
      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        await verifyDummy(body.password);
        return fail('ACCOUNT_LOCKED', 'locked');
      }
      const ok = await verifyPassword(user.passwordHash, body.password);
      if (!ok) {
        const { locked } = await users.recordLoginFailure(
          user.id,
          config.session.loginMaxAttempts,
          config.session.loginLockMinutes,
        );
        return fail(
          locked ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
          locked ? 'locked_now' : 'bad_password',
        );
      }
      if (!user.active) return fail('INVALID_CREDENTIALS', 'inactive');

      // Session fixation: any session presented with the login request is revoked and a new one issued.
      if (request.auth) await sessions.revoke(request.auth.session.id);
      await users.recordLoginSuccess(user.id);
      const { token, session } = await sessions.create(user.id, {
        ip,
        ...(request.headers['user-agent'] ? { userAgent: request.headers['user-agent'] } : {}),
      });
      setSessionCookie(reply, token, session.expiresAt);
      await audit.record({
        action: 'auth.login',
        status: 'success',
        userId: user.id,
        userEmail: user.email,
        ip,
        requestId: request.id,
      });
      return {
        user: toPublicUser(user, await authz.grants(user.id)),
        expiresAt: session.expiresAt.toISOString(),
      };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    noStore(reply);
    if (request.auth) {
      await sessions.revoke(request.auth.session.id);
      await audit.record({
        action: 'auth.logout',
        status: 'success',
        userId: request.auth.user.id,
        userEmail: request.auth.user.email,
        ip: clientIp(request),
        requestId: request.id,
      });
    }
    void reply.clearCookie(config.session.cookieName, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    return {
      user: toPublicUser(auth.user, auth.grants),
      expiresAt: auth.session.expiresAt.toISOString(),
    };
  });

  app.post(
    '/api/auth/change-password',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      const auth = requireAuth(request);
      const body = parseBody(changePasswordBody, request.body);
      if (!(await verifyPassword(auth.user.passwordHash, body.currentPassword))) {
        throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect');
      }
      const weak = passwordPolicyError(body.newPassword);
      if (weak) throw weak;
      await users.setPassword(auth.user.id, body.newPassword, false);
      // Every session (this one included) is now invalid; issue a fresh one for this browser.
      await users.revokeSessions(auth.user.id);
      const { token, session } = await sessions.create(auth.user.id, { ip: clientIp(request) });
      setSessionCookie(reply, token, session.expiresAt);
      await audit.record({
        action: 'auth.password_changed',
        status: 'success',
        userId: auth.user.id,
        userEmail: auth.user.email,
        ip: clientIp(request),
        requestId: request.id,
      });
      return { ok: true };
    },
  );
}
