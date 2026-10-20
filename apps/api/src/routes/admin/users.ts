import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { UserRow } from '@dbx/database';
import { toPublicUser } from '../../services/users';
import { noStore, parseBody, requirePermission, uuidParam } from '../../http';
import { passwordPolicyError } from '../auth';
import { adminAudit, rolesBody, roleKeys } from './shared';

const createUserBody = z
  .object({
    email: z.email().max(254),
    name: z.string().trim().min(1).max(120),
    password: z.string().min(12).max(512),
    roles: roleKeys.min(1),
  })
  .strict();

const updateUserBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

const resetPasswordBody = z.object({ password: z.string().min(12).max(512) }).strict();

export async function adminUserRoutes(app: FastifyInstance): Promise<void> {
  const { users, authz } = app.services;
  const { record, attempt } = adminAudit(app);

  /** Admin view of a user: effective grants plus the roles assigned directly. */
  const adminUser = async (u: UserRow) => ({
    ...toPublicUser(u, await authz.grants(u.id)),
    directRoles: await authz.directRoles(u.id),
    groupIds: await authz.groupsOf(u.id),
  });

  app.get('/api/admin/users', async (request, reply) => {
    noStore(reply);
    requirePermission(request, 'ADMIN.USERS');
    const rows = await users.list();
    return { items: await Promise.all(rows.map(adminUser)) };
  });

  /** Creating a user assigns roles, so it needs ADMIN.ROLES as well. */
  app.post('/api/admin/users', async (request, reply) => {
    requirePermission(request, 'ADMIN.USERS');
    const { user: actor } = requirePermission(request, 'ADMIN.ROLES');
    const body = parseBody(createUserBody, request.body);
    const weak = passwordPolicyError(body.password);
    if (weak) throw weak;
    const created = await attempt(
      request,
      actor,
      'user.create',
      { email: body.email, roles: body.roles },
      () => users.create({ ...body, mustChangePassword: true, createdBy: actor.id }),
    );
    await record(request, actor, 'user.create', {
      targetUserId: created.id,
      email: created.email,
      roles: body.roles,
    });
    void reply.code(201);
    return { item: await adminUser(created) };
  });

  app.patch('/api/admin/users/:id', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.USERS');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(updateUserBody, request.body);
    const updated = await attempt(
      request,
      actor,
      'user.update',
      { targetUserId: id, changes: body },
      () => users.update(id, body, actor.id),
    );
    await record(request, actor, 'user.update', { targetUserId: id, changes: body });
    return { item: await adminUser(updated) };
  });

  app.put('/api/admin/users/:id/roles', async (request) => {
    requirePermission(request, 'ADMIN.USERS');
    const { user: actor } = requirePermission(request, 'ADMIN.ROLES');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(rolesBody, request.body);
    await attempt(request, actor, 'user.roles', { targetUserId: id, roles: body.roles }, () =>
      authz.setUserRoles(id, body.roles, actor.id),
    );
    await record(request, actor, 'user.roles', { targetUserId: id, roles: body.roles });
    const user = await users.findById(id);
    return { item: await adminUser(user!) };
  });

  app.post('/api/admin/users/:id/reset-password', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.USERS');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(resetPasswordBody, request.body);
    const weak = passwordPolicyError(body.password);
    if (weak) throw weak;
    await attempt(request, actor, 'user.reset_password', { targetUserId: id }, () =>
      users.resetPassword(id, body.password, actor.id),
    );
    await record(request, actor, 'user.reset_password', { targetUserId: id });
    return { ok: true };
  });
}
