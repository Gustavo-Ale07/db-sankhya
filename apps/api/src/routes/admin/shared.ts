import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@dbx/shared';
import { clientIp } from '../../http';

export const roleKey = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Invalid role key');
export const roleKeys = z.array(roleKey).max(20);
export const description = z.string().trim().max(500).nullable();
export const rolesBody = z.object({ roles: roleKeys }).strict();

export interface Actor {
  id: string;
  email: string;
}

/** Audit helpers shared by every admin route file. */
export function adminAudit(app: FastifyInstance) {
  const { audit } = app.services;

  const record = (
    request: FastifyRequest,
    actor: Actor,
    action: string,
    details: Record<string, unknown>,
  ) =>
    audit.record({
      action,
      status: 'success',
      userId: actor.id,
      userEmail: actor.email,
      ip: clientIp(request),
      requestId: request.id,
      details,
    });

  /**
   * Runs an administrative change and audits a refused attempt to change one's own permissions
   * (status `denied`) before rethrowing it.
   */
  const attempt = async <T>(
    request: FastifyRequest,
    actor: Actor,
    action: string,
    details: Record<string, unknown>,
    change: () => Promise<T>,
  ): Promise<T> => {
    try {
      return await change();
    } catch (err) {
      if (err instanceof AppError && err.code === 'FORBIDDEN') {
        await audit.record({
          action,
          status: 'denied',
          userId: actor.id,
          userEmail: actor.email,
          ip: clientIp(request),
          requestId: request.id,
          errorCode: err.code,
          errorMessage: err.message,
          details,
        });
      }
      throw err;
    }
  };

  return { record, attempt };
}
