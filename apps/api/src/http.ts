import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '@dbx/shared';
import type { Permission } from '@dbx/shared';
import type { AuthState } from './context';
import { ENV_CONNECTION_ID } from './services/connections';

/** Parses untrusted input with a strict schema; unknown keys are rejected (no mass assignment). */
export function parseBody<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid request', {
      issues: result.error.issues
        .slice(0, 20)
        .map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
  }
  return result.data;
}

export function requireAuth(request: FastifyRequest): AuthState {
  if (!request.auth) throw new AppError('AUTH_REQUIRED', 'Authentication required');
  return request.auth;
}

export function hasPermission(auth: AuthState, permission: Permission): boolean {
  return auth.grants.permissions.has(permission);
}

/**
 * Authenticates the request and requires a permission from the catalog. This is the only
 * authorization gate: there is no role check and no administrator bypass.
 */
export function requirePermission(request: FastifyRequest, permission: Permission): AuthState {
  const auth = requireAuth(request);
  if (!hasPermission(auth, permission))
    throw new AppError('FORBIDDEN', 'You do not have permission for this action', {
      permission,
    });
  return auth;
}

export function clientIp(request: FastifyRequest): string {
  return request.ip;
}

export function noStore(reply: FastifyReply): void {
  void reply.header('cache-control', 'no-store');
}

export const uuidParam = z.object({ id: z.uuid() }).strict();

/** A saved connection's uuid, or the connection defined by SANKHYA_* variables. */
export const connectionIdSchema = z.union([z.literal(ENV_CONNECTION_ID), z.uuid()]);
