import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, POLICY_ADMIN_CONFLICTS, SEGREGATION_OVERRIDE } from '@dbx/shared';
import type { AuthState } from '../../context';
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
/**
 * Separation of duties: an account that can write ERP data, generate DDL or run business actions
 * may not change the rules that govern those writes (it could drop a WHERE requirement, four-eyes
 * or a row cap for itself). Reading the rules stays allowed.
 */
function assertSeparateFromWrites(auth: AuthState): void {
  // SECURITY.SEGREGATION_OVERRIDE (held only by SUPER_ADMIN) is the one, explicit exemption: such
  // an account may administer policies even though it can write. Everyone else stays segregated.
  if (auth.grants.permissions.has(SEGREGATION_OVERRIDE)) return;
  const conflicting = POLICY_ADMIN_CONFLICTS.filter((p) => auth.grants.permissions.has(p));
  if (conflicting.length > 0) {
    throw new AppError(
      'FORBIDDEN',
      'Accounts that can write data cannot change access policies (separation of duties)',
      { reason: 'separation_of_duties', conflicting },
    );
  }
}

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
  const { record, attempt } = adminAudit(app);
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
    const auth = requirePermission(request, 'ADMIN.POLICIES');
    const actor = auth.user;
    const body = parseBody(createPolicyBody, request.body);
    const item = await attempt(request, actor, 'policy.create', { name: body.name }, () => {
      assertSeparateFromWrites(auth);
      return policies.create(body as PolicyInput);
    });
    const policyVersion = await version();
    await record(request, actor, 'policy.create', { policyId: item.id, policyVersion, rule: item });
    void reply.code(201);
    return { item, policyVersion };
  });

  app.patch('/api/admin/policies/:id', async (request) => {
    const auth = requirePermission(request, 'ADMIN.POLICIES');
    const actor = auth.user;
    const { id } = parseBody(uuidParam, request.params);
    const body = parseBody(updatePolicyBody, request.body);
    const item = await attempt(request, actor, 'policy.update', { policyId: id }, () => {
      assertSeparateFromWrites(auth);
      return policies.update(id, body as PolicyPatch);
    });
    const policyVersion = await version();
    await record(request, actor, 'policy.update', {
      policyId: id,
      policyVersion,
      changes: body,
    });
    return { item, policyVersion };
  });

  app.delete('/api/admin/policies/:id', async (request) => {
    const auth = requirePermission(request, 'ADMIN.POLICIES');
    const actor = auth.user;
    const { id } = parseBody(uuidParam, request.params);
    await attempt(request, actor, 'policy.delete', { policyId: id }, () => {
      assertSeparateFromWrites(auth);
      return policies.delete(id);
    });
    const policyVersion = await version();
    await record(request, actor, 'policy.delete', { policyId: id, policyVersion });
    return { ok: true, policyVersion };
  });
}
