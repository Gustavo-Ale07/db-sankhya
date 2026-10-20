import type { FastifyInstance } from 'fastify';
import { ApprovalsService } from './approvals';
import { MutationService } from './mutations';
import { PlansService } from './plans';

/**
 * A MutationService wired to the app services, exactly as /api/query wires its own (plans and
 * approvals share the database, so instances are interchangeable).
 */
export function createMutationService(app: FastifyInstance): MutationService {
  const { config, policies, authz, connections, metadata, audit, redact, security } = app.services;
  const plans = new PlansService(app.services.database.db, {
    secret: config.session.secret,
    ttlSeconds: config.planTtlSeconds,
    approvalTtlSeconds: config.approvalTtlMinutes * 60,
  });
  const ceilings = {
    sankhyaMaxReadRows: config.sankhya.maxRows,
    scratchMaxReadRows: config.scratch.maxRows,
  };
  return new MutationService({
    policies,
    authz,
    connections,
    metadata,
    audit,
    scratch: app.services.scratch,
    plans,
    // Plans that require approval are consumed only through the approvals service.
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
    maxReadRows: ceilings.sankhyaMaxReadRows,
    scratchMaxReadRows: ceilings.scratchMaxReadRows,
    logger: app.log,
  });
}
