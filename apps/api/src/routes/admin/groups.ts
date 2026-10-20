import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { noStore, parseBody, requirePermission, uuidParam } from '../../http';
import { adminAudit, description, rolesBody } from './shared';

const membersBody = z.object({ userIds: z.array(z.uuid()).max(1000) }).strict();

const createGroupBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    description: description.optional(),
  })
  .strict();

const updateGroupBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: description.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export async function adminGroupRoutes(app: FastifyInstance): Promise<void> {
  const { authz } = app.services;
  const { record, attempt } = adminAudit(app);

  app.get('/api/admin/groups', async (request, reply) => {
    noStore(reply);
    requirePermission(request, 'ADMIN.GROUPS');
    return { items: await authz.listGroups() };
  });

  app.post('/api/admin/groups', async (request, reply) => {
    const { user: actor } = requirePermission(request, 'ADMIN.GROUPS');
    const body = parseBody(createGroupBody, request.body);
    const group = await authz.createGroup(body);
    await record(request, actor, 'group.create', { groupId: group.id, name: group.name });
    void reply.code(201);
    return { item: group };
  });

  app.patch('/api/admin/groups/:id', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.GROUPS');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(updateGroupBody, request.body);
    const group = await attempt(
      request,
      actor,
      'group.update',
      { groupId: id, changes: body },
      () => authz.updateGroup(id, body, actor.id),
    );
    await record(request, actor, 'group.update', { groupId: id, changes: body });
    return { item: group };
  });

  app.delete('/api/admin/groups/:id', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.GROUPS');
    const { id } = parseBody(uuidParam, request.params);
    await attempt(request, actor, 'group.delete', { groupId: id }, () =>
      authz.deleteGroup(id, actor.id),
    );
    await record(request, actor, 'group.delete', { groupId: id });
    return { ok: true };
  });

  app.put('/api/admin/groups/:id/members', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.GROUPS');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(membersBody, request.body);
    const group = await attempt(
      request,
      actor,
      'group.members',
      { groupId: id, userIds: body.userIds },
      () => authz.setGroupMembers(id, body.userIds, actor.id),
    );
    await record(request, actor, 'group.members', { groupId: id, userIds: group.memberIds });
    return { item: group };
  });

  /** Granting roles to a group is a role assignment, so it needs ADMIN.ROLES too. */
  app.put('/api/admin/groups/:id/roles', async (request) => {
    requirePermission(request, 'ADMIN.GROUPS');
    const { user: actor } = requirePermission(request, 'ADMIN.ROLES');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(rolesBody, request.body);
    const group = await attempt(
      request,
      actor,
      'group.roles',
      { groupId: id, roles: body.roles },
      () => authz.setGroupRoles(id, body.roles, actor.id),
    );
    await record(request, actor, 'group.roles', { groupId: id, roles: group.roleKeys });
    return { item: group };
  });
}
