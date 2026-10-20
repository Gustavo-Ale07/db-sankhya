import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PERMISSIONS } from '@dbx/shared';
import { noStore, parseBody, requirePermission, uuidParam } from '../../http';
import { adminAudit, description, roleKey } from './shared';

const permissionList = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);

const createRoleBody = z
  .object({
    key: roleKey,
    name: z.string().trim().min(1).max(120),
    description: description.optional(),
    permissions: permissionList,
  })
  .strict();

const updateRoleBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: description.optional(),
    permissions: permissionList.optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export async function adminRoleRoutes(app: FastifyInstance): Promise<void> {
  const { authz } = app.services;
  const { record, attempt } = adminAudit(app);

  app.get('/api/admin/roles', async (request, reply) => {
    noStore(reply);
    requirePermission(request, 'ADMIN.ROLES');
    return { items: await authz.listRoles(), permissions: PERMISSIONS };
  });

  app.post('/api/admin/roles', async (request, reply) => {
    const { user: actor } = requirePermission(request, 'ADMIN.ROLES');
    const body = parseBody(createRoleBody, request.body);
    const role = await attempt(
      request,
      actor,
      'role.create',
      { key: body.key, permissions: body.permissions },
      () => authz.createRole(body, actor.id),
    );
    await record(request, actor, 'role.create', {
      roleId: role.id,
      key: role.key,
      permissions: role.permissions,
    });
    void reply.code(201);
    return { item: role };
  });

  app.patch('/api/admin/roles/:id', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.ROLES');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(updateRoleBody, request.body);
    const role = await attempt(request, actor, 'role.update', { roleId: id, changes: body }, () =>
      authz.updateRole(id, body, actor.id),
    );
    await record(request, actor, 'role.update', { roleId: id, changes: body });
    return { item: role };
  });

  app.delete('/api/admin/roles/:id', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.ROLES');
    const { id } = parseBody(uuidParam, request.params);
    await attempt(request, actor, 'role.delete', { roleId: id }, () =>
      authz.deleteRole(id, actor.id),
    );
    await record(request, actor, 'role.delete', { roleId: id });
    return { ok: true };
  });
}
