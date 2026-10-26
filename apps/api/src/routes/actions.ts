import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '@dbx/shared';
import { ENV_CONNECTION_ID } from '../services/connections';
import { ApprovalsService } from '../services/approvals';
import { ACTION_WARNING, findAction, findStub } from '../services/business-actions';
import type { BusinessAction } from '../services/business-actions';
import { MutationService } from '../services/mutations';
import { PlansService } from '../services/plans';
import { clientIp, connectionIdSchema, noStore, parseBody, requireAuth } from '../http';

/**
 * Typed business actions (Task 11.3). Only actions of the registry exist; each one runs through
 * the same plan lifecycle as a SQL write (MutationService: PolicyEngine with the action's entity,
 * preview, confirmation, re-authorization, kill switches, verification, audit). There is no
 * other path to a gateway service.
 */

const actionParams = z.object({ id: z.string().min(1).max(128) }).strict();

const prepareBody = z
  .object({
    /** The action's input, validated by the action's own schema. */
    input: z.unknown(),
    /** Sankhya connection; the SANKHYA_* connection when omitted and configured. */
    connectionId: connectionIdSchema.optional(),
  })
  .strict();

const executeBody = z
  .object({
    planId: z.uuid(),
    token: z.string().min(1).max(200),
    strongConfirmation: z.string().max(300).optional(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export async function actionRoutes(app: FastifyInstance): Promise<void> {
  const { audit, connections, metadata, config, redact, policies, authz, security } = app.services;
  const plans = new PlansService(app.services.database.db, {
    secret: config.session.secret,
    ttlSeconds: config.planTtlSeconds,
    approvalTtlSeconds: config.approvalTtlMinutes * 60,
  });
  const ceilings = {
    sankhyaMaxReadRows: config.sankhya.maxRows,
    scratchMaxReadRows: config.scratch.maxRows,
  };
  const mutations = new MutationService({
    policies,
    authz,
    connections,
    metadata,
    audit,
    scratch: app.services.scratch,
    plans,
    approvals: new ApprovalsService(app.services.database.db, {
      plans,
      policies,
      authz,
      redact,
      logger: app.log,
      ceilings,
    }),
    security,
    switches: { safeMode: config.safeMode, writeToSankhya: config.writeToSankhya },
    serverSql: {
      enabled: config.serverSqlEnabled,
      productionOptIn: config.serverSqlProductionOptIn,
    },
    maxReadRows: ceilings.sankhyaMaxReadRows,
    scratchMaxReadRows: ceilings.scratchMaxReadRows,
    businessActionsEnabled: config.businessActionsEnabled,
    writeInstances: config.sankhyaWriteInstances,
    logger: app.log,
  });

  function actionOf(params: unknown): BusinessAction {
    const { id } = parseBody(actionParams, params);
    const action = findAction(id);
    if (action) return action;
    // A known service whose contract is not confirmed: documented, never executable.
    const stub = findStub(id);
    if (stub) {
      throw new AppError('OPERATION_NOT_SUPPORTED', `${stub.id} is not available: ${stub.reason}`, {
        action: stub.id,
        contract: stub.contract,
      });
    }
    throw new AppError('NOT_FOUND', 'Unknown business action.');
  }

  function defaultConnection(): string {
    if (config.sankhya.envConnection) return ENV_CONNECTION_ID;
    throw new AppError(
      'VALIDATION_ERROR',
      'connectionId is required: no default Sankhya connection is configured',
    );
  }

  // ------------------------------------------------------------ POST /api/actions/:id/prepare
  // Plans one business action and returns its preview (the row as it is and as the action is
  // expected to leave it), with the contract it follows and the warning that it was validated
  // on the mock only. Never calls the action: it runs only through /execute.
  app.post('/api/actions/:id/prepare', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    const action = actionOf(request.params);
    const body = parseBody(prepareBody, request.body);
    const prepared = await mutations.prepareAction({
      auth,
      connectionId: body.connectionId ?? defaultConnection(),
      action,
      input: body.input,
      meta: { ip: clientIp(request), requestId: request.id },
    });
    // Whether execute would pass the write switches right now (it checks them again itself).
    const globalWrite = (await security.globalWriteState()).effective;
    const available =
      globalWrite &&
      config.writeToSankhya &&
      !(config.safeMode && prepared.impact.environment === 'PRODUCTION');
    // The plan token is the caller's own confirmation credential: returned outside the redactor.
    const { token, permitted, ...shown } = prepared;
    return {
      ...(redact({
        type: 'preview',
        ...shown,
        contract: action.contract,
        warning: ACTION_WARNING,
        execution: {
          available,
          // Whether the caller holds the permission execute checks (false for DATA.PREVIEW only).
          permitted,
          safeMode: config.safeMode,
          globalWriteEnabled: globalWrite,
          writeToSankhya: config.writeToSankhya,
        },
      }) as Record<string, unknown>),
      token,
    };
  });

  // ------------------------------------------------------------ POST /api/actions/:id/execute
  // Executes a prepared action plan of this action: confirm, re-authorize, call once, verify,
  // audit. A plan of another action, or of a SQL statement, is refused.
  app.post('/api/actions/:id/execute', async (request, reply) => {
    noStore(reply);
    const auth = requireAuth(request);
    const action = actionOf(request.params);
    const body = parseBody(executeBody, request.body);
    const report = await mutations.execute({
      auth,
      planId: body.planId,
      token: body.token,
      idempotencyKey: body.idempotencyKey,
      actionId: action.id,
      ...(body.strongConfirmation !== undefined
        ? { strongConfirmation: body.strongConfirmation }
        : {}),
      meta: { ip: clientIp(request), requestId: request.id },
    });
    return redact({ type: 'execution', planId: body.planId, ...report });
  });
}
