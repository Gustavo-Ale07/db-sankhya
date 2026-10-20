import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PolicyInput, PolicyPatch } from '../../services/policy';
import { noStore, parseBody, requirePermission, uuidParam } from '../../http';
import { adminAudit } from './shared';

/**
 * Only the known rule fields are accepted (no id, no timestamps: no mass assignment). Their values
 * are checked by PolicyService with `validatePolicyRule`, the same validation the stored rules get
 * on load, so the two can never disagree.
 */
const ruleFields = {
  name: z.unknown(),
  effect: z.unknown(),
  subjectType: z.unknown(),
  subjectId: z.unknown(),
  environments: z.unknown(),
  connectionIds: z.unknown(),
  actions: z.unknown(),
  entities: z.unknown(),
  columns: z.unknown(),
  limits: z.unknown(),
  overrideWhereRequired: z.unknown(),
  enabled: z.unknown(),
};
const createPolicyBody = z.object(ruleFields).strict();
const updatePolicyBody = z
  .object(ruleFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

/**
 * Access policy rules. Every response carries the resulting `policyVersion`, so the UI can tell
 * which rule set a plan was evaluated against.
 */
export async function adminPolicyRoutes(app: FastifyInstance): Promise<void> {
  const { policies } = app.services;
  const { record } = adminAudit(app);
  const version = async () => (await policies.current()).version;

  app.get('/api/admin/policies', async (request, reply) => {
    noStore(reply);
    requirePermission(request, 'ADMIN.POLICIES');
    const snapshot = await policies.current();
    return {
      items: await policies.list(),
      policyVersion: snapshot.version,
      invalid: snapshot.invalid,
    };
  });

  app.post('/api/admin/policies', async (request, reply) => {
    const { user: actor } = requirePermission(request, 'ADMIN.POLICIES');
    const body = parseBody(createPolicyBody, request.body);
    const item = await policies.create(body as PolicyInput);
    const policyVersion = await version();
    await record(request, actor, 'policy.create', { policyId: item.id, policyVersion, rule: item });
    void reply.code(201);
    return { item, policyVersion };
  });

  app.patch('/api/admin/policies/:id', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.POLICIES');
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(updatePolicyBody, request.body);
    const item = await policies.update(id, body as PolicyPatch);
    const policyVersion = await version();
    await record(request, actor, 'policy.update', {
      policyId: id,
      policyVersion,
      changes: body,
    });
    return { item, policyVersion };
  });

  app.delete('/api/admin/policies/:id', async (request) => {
    const { user: actor } = requirePermission(request, 'ADMIN.POLICIES');
    const { id } = parseBody(uuidParam, request.params);
    await policies.delete(id);
    const policyVersion = await version();
    await record(request, actor, 'policy.delete', { policyId: id, policyVersion });
    return { ok: true, policyVersion };
  });
}
