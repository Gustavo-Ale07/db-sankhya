import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, PERMISSIONS } from '@dbx/shared';
import type { AuditEventRow, UserRow } from '@dbx/database';
import { toPublicUser } from '../services/users';
import { clientIp, noStore, parseBody, requirePermission, uuidParam } from '../http';
import { passwordPolicyError } from './auth';

const roleKey = z.string().regex(/^[A-Z][A-Z0-9_]{1,39}$/, 'Invalid role key');
const roleKeys = z.array(roleKey).max(20);
const description = z.string().trim().max(500).nullable();

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

const rolesBody = z.object({ roles: roleKeys }).strict();
const membersBody = z.object({ userIds: z.array(z.uuid()).max(1000) }).strict();
const resetPasswordBody = z.object({ password: z.string().min(12).max(512) }).strict();

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

const auditQuery = z
  .object({
    action: z.string().max(60).optional(),
    userEmail: z.string().max(254).optional(),
    resource: z.string().max(60).optional(),
    status: z.enum(['success', 'partial', 'failed', 'denied', 'info']).optional(),
    from: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
    to: z.iso.datetime({ offset: true }).or(z.iso.date()).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
  })
  .strict();

const toAudit = (a: AuditEventRow) => ({
  id: a.id,
  createdAt: a.createdAt.toISOString(),
  userId: a.userId,
  userEmail: a.userEmail,
  ip: a.ip,
  requestId: a.requestId,
  action: a.action,
  operation: a.operation,
  resource: a.resource,
  statement: a.statement,
  targetIds: a.targetIds,
  before: a.before,
  after: a.after,
  gatewayCalls: a.gatewayCalls,
  status: a.status,
  durationMs: a.durationMs,
  errorCode: a.errorCode,
  errorMessage: a.errorMessage,
  details: a.details,
});

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const { users, audit, authz } = app.services;

  const record = (
    request: Parameters<typeof clientIp>[0],
    actor: { id: string; email: string },
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
    request: Parameters<typeof clientIp>[0],
    actor: { id: string; email: string },
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

  /** Admin view of a user: effective grants plus the roles assigned directly. */
  const adminUser = async (u: UserRow) => ({
    ...toPublicUser(u, await authz.grants(u.id)),
    directRoles: await authz.directRoles(u.id),
    groupIds: await authz.groupsOf(u.id),
  });

  // ---- users -------------------------------------------------------------------------------

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

  // ---- roles -------------------------------------------------------------------------------

  app.get('/api/admin/roles', async (request, reply) => {
    noStore(reply);
    requirePermission(request, 'ADMIN.ROLES');
    return { items: await authz.listRoles(), permissions: PERMISSIONS };
  });

  app.post('/api/admin/roles', async (request, reply) => {
    const { user: actor } = requirePermission(request, 'ADMIN.ROLES');
    const body = parseBody(createRoleBody, request.body);
    const role = await authz.createRole(body);
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

  // ---- groups ------------------------------------------------------------------------------

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

  // ---- audit -------------------------------------------------------------------------------

  app.get('/api/audit', async (request, reply) => {
    noStore(reply);
    requirePermission(request, 'AUDIT.READ');
    const { from, to, ...q } = parseBody(auditQuery, request.query);
    const { items, total } = await audit.list({
      ...q,
      ...(from ? { from: new Date(from) } : {}),
      ...(to ? { to: endOfDay(to) } : {}),
    });
    return { items: items.map(toAudit), total };
  });
}

function endOfDay(value: string | Date): Date {
  if (typeof value === 'string' && value.length === 10) return new Date(`${value}T23:59:59.999Z`);
  return new Date(value);
}
