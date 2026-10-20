import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ENVIRONMENTS } from '@dbx/shared';
import type { ConnectionPublic, ConnectionSecrets } from '../../services/connections';
import { connectionIdSchema, noStore, parseBody, requirePermission } from '../../http';
import { adminAudit } from './shared';

const secretValue = z.string().min(1).max(4096);
const secretsShape = z
  .object({
    clientId: secretValue.optional(),
    clientSecret: secretValue.optional(),
    xToken: secretValue.optional(),
  })
  .strict();

const connectionFields = {
  name: z.string().trim().min(1).max(120),
  environment: z.enum(ENVIRONMENTS),
  mode: z.enum(['live', 'mock']),
  baseUrl: z.string().trim().min(1).max(2048),
  dialect: z.enum(['oracle', 'mssql']),
  enabled: z.boolean().optional(),
};

const createConnectionBody = z
  .object({ ...connectionFields, secrets: secretsShape.optional() })
  .strict();
const updateConnectionBody = z
  .object(connectionFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');
const rotateSecretsBody = secretsShape.refine(
  (v) => Object.keys(v).length > 0,
  'No secret to replace',
);
const idParam = z.object({ id: connectionIdSchema }).strict();

/** Names of the secret fields present in a payload; never their values. */
const fieldsOf = (secrets: Partial<ConnectionSecrets> | undefined) =>
  Object.keys(secrets ?? {}).sort();

/**
 * Admin view of a connection: the masked public shape (secrets only as SET / NOT_SET, the client
 * id partially) plus whether it can be edited. The connection defined by the SANKHYA_* variables
 * is listed but read-only: it can only be tested.
 */
const view = (c: ConnectionPublic) => ({ ...c, editable: c.source !== 'env' });

export async function adminConnectionRoutes(app: FastifyInstance): Promise<void> {
  const { connections } = app.services;
  const { record, attempt } = adminAudit(app);

  app.get('/api/admin/connections', async (request, reply) => {
    noStore(reply);
    requirePermission(request, 'ADMIN.CONNECTIONS');
    return { items: (await connections.list()).map(view) };
  });

  app.get('/api/admin/connections/:id', async (request, reply) => {
    noStore(reply);
    requirePermission(request, 'ADMIN.CONNECTIONS');
    const { id } = parseBody(idParam, request.params);
    return { item: view(await connections.get(id)) };
  });

  app.post('/api/admin/connections', async (request, reply) => {
    const { user: actor } = requirePermission(request, 'ADMIN.CONNECTIONS');
    const body = parseBody(createConnectionBody, request.body);
    const created = await connections.create(body);
    await record(request, actor, 'connection.create', {
      connectionId: created.id,
      name: created.name,
      environment: created.environment,
      mode: created.mode,
      baseUrl: created.baseUrl,
      dialect: created.dialect,
      enabled: created.enabled,
      fields: fieldsOf(body.secrets),
    });
    void reply.code(201);
    return { item: view(created) };
  });

  app.patch('/api/admin/connections/:id', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.CONNECTIONS');
    const { id } = parseBody(idParam, request.params);
    const body = parseBody(updateConnectionBody, request.body);
    const details = { connectionId: id, changes: body };
    const updated = await attempt(request, actor, 'connection.update', details, () =>
      connections.update(id, body),
    );
    await record(request, actor, 'connection.update', details);
    return { item: view(updated) };
  });

  /** Replaces some or all secrets. They are write-only: no route ever returns them. */
  app.put('/api/admin/connections/:id/secrets', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.CONNECTIONS');
    const { id } = parseBody(idParam, request.params);
    const body = parseBody(rotateSecretsBody, request.body);
    const details = { connectionId: id, fields: fieldsOf(body) };
    const rotated = await attempt(request, actor, 'connection.rotate_secrets', details, () =>
      connections.rotateSecrets(id, body),
    );
    await record(request, actor, 'connection.rotate_secrets', details);
    return { item: view(rotated) };
  });

  app.delete('/api/admin/connections/:id', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.CONNECTIONS');
    const { id } = parseBody(idParam, request.params);
    await attempt(request, actor, 'connection.delete', { connectionId: id }, () =>
      connections.delete(id),
    );
    await record(request, actor, 'connection.delete', { connectionId: id });
    return { ok: true };
  });

  /** Authenticates and runs the probe query; a failure is reported by code, never thrown. */
  app.post('/api/admin/connections/:id/test', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.CONNECTIONS');
    const { id } = parseBody(idParam, request.params);
    const result = await connections.test(id);
    await record(request, actor, 'connection.test', { connectionId: id, ...result });
    return result;
  });
}
