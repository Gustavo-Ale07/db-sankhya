import type { FastifyInstance } from 'fastify';
import { noStore, requirePermission } from '../http';

/**
 * Connection picker listing. Deliberately narrower than the admin view: only what the UI needs
 * to choose a connection and show its environment. Never the gateway URL, the mode, the
 * dialect or anything about credentials.
 */
export async function connectionRoutes(app: FastifyInstance): Promise<void> {
  const { connections } = app.services;

  app.get('/api/connections', async (request, reply) => {
    requirePermission(request, 'QUERY.SELECT');
    noStore(reply);
    const items = (await connections.list())
      .filter((c) => c.enabled && c.status === 'READY')
      .map((c) => ({ id: c.id, name: c.name, environment: c.environment }));
    return { items };
  });
}
