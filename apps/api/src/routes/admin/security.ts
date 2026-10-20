import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { noStore, parseBody, requirePermission } from '../../http';
import { adminAudit } from './shared';

const securityBody = z.object({ globalWriteEnabled: z.boolean() }).strict();

/**
 * The runtime write kill switch. Both values are reported: `env` (GLOBAL_WRITE_ENABLED), `runtime`
 * (this toggle) and `effective = env AND runtime`, so turning the toggle on while the environment
 * keeps writes off visibly changes nothing.
 */
export async function adminSecurityRoutes(app: FastifyInstance): Promise<void> {
  const { security } = app.services;
  const { record } = adminAudit(app);

  app.get('/api/admin/security', async (request, reply) => {
    noStore(reply);
    requirePermission(request, 'ADMIN.SECURITY');
    return { globalWriteEnabled: await security.globalWriteState() };
  });

  app.put('/api/admin/security', async (request, reply) => {
    noStore(reply);
    const { user: actor } = requirePermission(request, 'ADMIN.SECURITY');
    const body = parseBody(securityBody, request.body);
    const { previous } = await security.setGlobalWrite(body.globalWriteEnabled, actor.id);
    const state = await security.globalWriteState();
    await record(request, actor, 'security.update', {
      setting: 'globalWriteEnabled',
      from: previous,
      to: body.globalWriteEnabled,
      env: state.env,
      effective: state.effective,
    });
    return { globalWriteEnabled: state };
  });
}
