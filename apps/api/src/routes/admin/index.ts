import type { FastifyInstance } from 'fastify';
import { adminConnectionRoutes } from './connections';
import { adminGroupRoutes } from './groups';
import { adminPolicyRoutes } from './policies';
import { adminRoleRoutes } from './roles';
import { adminSecurityRoutes } from './security';
import { adminUserRoutes } from './users';

/**
 * Administration API. Each area requires its own ADMIN.* permission; there is no administrator
 * bypass, and every change is audited.
 */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  await adminUserRoutes(app);
  await adminGroupRoutes(app);
  await adminRoleRoutes(app);
  await adminPolicyRoutes(app);
  await adminConnectionRoutes(app);
  await adminSecurityRoutes(app);
}
