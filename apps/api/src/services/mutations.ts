/**
 * Mutation orchestrator.
 *
 * `prepare` (Task 11.2a) runs PARSE → VALIDATE → AUTHORIZE → PLAN → PREVIEW → IMPACT and persists
 * an immutable plan. It never writes: the only gateway call it can make is the before-snapshot
 * read (`executeQuery` through `executeRead`).
 *
 * `execute` (Task 11.2b) runs CONFIRM → RE-AUTHORIZE → EXECUTE → VERIFY → AUDIT on a plan:
 * - CONFIRM consumes the plan (token, session, exact strong phrase, idempotency key). A plan that
 *   requires approval is consumed only through `ApprovalsService.consumeForPlan`. A replay with
 *   the same idempotency key returns the stored report and never writes again.
 * - RE-AUTHORIZE reloads the grants and the policy rules: the policy version must be the frozen
 *   one, the decision must still ALLOW with gates no stricter than the frozen ones, the capability
 *   must be unchanged, and the targets are read again (TARGETS_CHANGED when they moved). Then the
 *   write switches: GLOBAL_WRITE_ENABLED (env AND runtime kill switch), WRITE_TO_SANKHYA (Sankhya
 *   plans) and SAFE_MODE (PRODUCTION plans), each failing closed with READ_ONLY_MODE.
 * - EXECUTE sends one save per target, in order, never retried. Before each save the switches and
 *   the policy version are checked again, so an emergency stop halts a run in progress. A definite
 *   failure or a stop ends the run (the rest is `not_attempted`); a timeout is `unknown`
 *   (WRITE_OUTCOME_UNKNOWN). Keys must be complete: a null key value is never saved.
 * - VERIFY reads every target back by key and labels the run VERIFIED, PARTIALLY_VERIFIED,
 *   UNVERIFIED or FAILED (see `verification.ts`).
 * - AUDIT records PLAN_EXECUTED (with the report, for replays) and VERIFICATION; every refusal
 *   after the consume is a PLAN_DENIED, every refusal of the consume a `write.denied`. The
 *   `auditSnapshots` policy limit (false wins) leaves only counts and keys in the audit. If the
 *   audit cannot be written after a save was sent, the answer is WRITE_OUTCOME_UNKNOWN.
 */
import { AppError, SNAPSHOT_MAX_ROWS, isAppError } from '@dbx/shared';
import type { Environment, ErrorCode, Permission, PolicyColumn, PolicyDecision } from '@dbx/shared';
import { classifyStatement, isTrivialWhere, resolveCapability } from '@dbx/sql-engine';
import type {
  Capability,
  Classified,
  Expr,
  InsertStatement,
  UpdateStatement,
  Value,
} from '@dbx/sql-engine';
import type { AuthState } from '../context';
import type { ApprovalsService } from './approvals';
import { gatesHold } from './approvals';
import type { AuthzService } from './authz';
import {
  actionEnabled,
  actionStatement,
  actionWord,
  parseActionStatement,
} from './business-actions';
import type { BusinessAction } from './business-actions';
import type { ConnectionsService } from './connections';
import type { Catalog, CatalogTable } from './metadata';
import type { MetadataService } from './metadata';
import type { ConsumedPlan, PlanRow, PlansService } from './plans';
import { strongConfirmationPhrase, targetsHashOf } from './plans';
import type { PolicyService } from './policy';
import { executeRead } from './read-executor';
import {
  SCRATCH_CONNECTION_ID,
  SCRATCH_ENVIRONMENT,
  authorizeConnection,
  connectionDenied,
  evaluateFor,
  readTargets,
} from './read-policy';
import type {
  DdlDryRunResult,
  DryRunResult,
  ScratchManager,
  ScratchWorkspace,
  TableStructure,
} from './scratch';
import { analyzeScratchSql } from './scratch-guard';
import type { ScratchStatement } from './scratch-guard';
import { dropEphemeral, planScratchCreateAs } from './hybrid';
import type { HybridPart } from './hybrid';
import type { AuditLifecycleContext, AuditService } from './records';
import type { SecuritySettingsService } from './security-settings';
import { labelOf, reportForAudit, statusOf, valuesMatch, verifyByKey } from './verification';
import type { ExecutionReport, ExecutionStep, VerifyResult } from './verification';

export type { ExecutionReport, ExecutionStep } from './verification';

export type PreviewKind = 'SIMULATED_PREVIEW' | 'IMPACT_ANALYSIS' | 'TRANSACTIONAL_DRY_RUN';

export type RecordValues = Record<string, Value>;

export interface PreviewTarget {
  key: RecordValues;
  before: RecordValues | null;
  after: RecordValues;
}

export interface PreparedMutation {
  planId: string;
  token: string;
  expiresAt: string;
  capability: Capability;
  /** The primary label, always one exact value. */
  previewKind: PreviewKind;
  /** Every label that applies: a Sankhya UPDATE is IMPACT_ANALYSIS (real before) + SIMULATED_PREVIEW. */
  previewLabels: PreviewKind[];
  preview: {
    targets: PreviewTarget[];
    affected: number;
    /** Scratch DDL: the target table before and after the dry run (null: it does not exist). */
    structure?: DdlDryRunResult;
    /** Scratch DROP TABLE: the rows the table holds now, lost with it. */
    lostRows?: number;
    /** CREATE TABLE tmp_… AS reading Sankhya: each part copied for the preview (cut or not). */
    sankhyaParts?: SankhyaCopy[];
    /** The Sankhya connection those parts were read from; execute reads them from it again. */
    sourceConnectionId?: string;
  };
  impact: { entities: string[]; rows: number; environment: Environment };
  requires: { strongConfirmation: string | null; approval: boolean };
  /** The kind of the planned SQL statement (from the parsed statement); absent for actions. */
  operation?: PlannedKind;
  /**
   * Whether the caller holds the permission `execute` checks first (the statement's DATA.*, or
   * TEMP.WRITE on scratch). False for a preview made only through DATA.PREVIEW.
   */
  permitted: boolean;
}

/** One Sankhya part copied into the caller's workspace (a read only). */
export interface SankhyaCopy {
  tables: string[];
  rows: number;
  truncated: boolean;
}

/**
 * Copies the Sankhya parts of a scratch statement into ephemeral tables of the workspace, through
 * the Sankhya read path and its policies (QUERY.SELECT and TEMP.MATERIALIZE). Only the query
 * routes provide one; without it a scratch table cannot be filled from Sankhya.
 */
export type SankhyaCopier = (
  workspace: ScratchWorkspace,
  parts: readonly HybridPart[],
  sourceConnectionId: string,
) => Promise<SankhyaCopy[]>;

export interface PrepareContext {
  auth: AuthState;
  connectionId: string;
  sql: string;
  /** Fills a CREATE TABLE tmp_… AS from Sankhya (see `SankhyaCopier`). */
  copier?: SankhyaCopier;
  /**
   * Accept DATA.PREVIEW in place of the statement permission (Sankhya writes only). Set only by
   * POST /api/query/preview; every other caller (rollback plans included) keeps needing the
   * statement permission. Default false.
   */
  allowPreviewOnly?: boolean;
  /** Request metadata for the audit trail. */
  meta?: { ip?: string | null; requestId?: string | null };
}

export interface PrepareActionContext {
  auth: AuthState;
  connectionId: string;
  /** A registered action (see `business-actions.ts`); the caller resolves unknown ids to 404. */
  action: BusinessAction;
  /** Unvalidated input; validated against the action's schema after the permission check. */
  input: unknown;
  meta?: { ip?: string | null; requestId?: string | null };
}

export type PreparedAction = PreparedMutation & { action: string };

export interface ExecuteContext {
  auth: AuthState;
  /**
   * Set by the business action route: the plan must be a plan of exactly this action. Without
   * it, the plan must be a SQL plan. A mismatch is CONFIRMATION_INVALID.
   */
  actionId?: string;
  planId: string;
  token: string;
  strongConfirmation?: string;
  idempotencyKey?: string;
  /** The same copier the preview used, for a CREATE TABLE tmp_… AS from Sankhya. */
  copier?: SankhyaCopier;
  meta?: { ip?: string | null; requestId?: string | null };
}

export interface MutationDeps {
  policies: PolicyService;
  authz: Pick<AuthzService, 'activeGroupIds' | 'grants'>;
  connections: ConnectionsService;
  metadata: Pick<MetadataService, 'table'>;
  plans: Pick<PlansService, 'create' | 'consume' | 'peek'>;
  /** The only consume path of plans that require approval. */
  approvals: Pick<ApprovalsService, 'consumeForPlan'>;
  scratch: Pick<ScratchManager, 'workspace'>;
  audit: AuditService;
  /** GLOBAL_WRITE_ENABLED: env AND the runtime kill switch. */
  security: Pick<SecuritySettingsService, 'globalWriteState'>;
  switches: { safeMode: boolean; writeToSankhya: boolean };
  /** SANKHYA_MAX_ROWS: read ceiling of the policy decisions and of the before-snapshot read. */
  maxReadRows: number;
  /** SCRATCH_MAX_ROWS: read ceiling of the scratch policy decisions. */
  scratchMaxReadRows?: number;
  /** BUSINESS_ACTIONS_ENABLED: action ids allowed on live connections (none when absent). */
  businessActionsEnabled?: readonly string[];
  /** Errors that cannot reach the audit (only ids and codes are logged, never values). */
  logger?: { error(obj: Record<string, unknown>, msg: string): void };
}

type WriteClassified = Extract<Classified, { kind: 'INSERT' | 'UPDATE' | 'DELETE' }>;
type DdlClassified = Extract<Classified, { kind: 'CREATE_TABLE' | 'ALTER_TABLE' | 'DROP_TABLE' }>;
type PlannedKind = WriteClassified['kind'] | DdlClassified['kind'];

const DDL_PERMISSION: Record<DdlClassified['kind'], Permission> = {
  CREATE_TABLE: 'TEMP.CREATE',
  ALTER_TABLE: 'TEMP.CREATE',
  DROP_TABLE: 'TEMP.DROP',
};

const PERMISSION: Record<WriteClassified['kind'], Permission> = {
  INSERT: 'DATA.INSERT',
  UPDATE: 'DATA.UPDATE',
  DELETE: 'DATA.DELETE',
};

const SCRATCH_TABLE = /^tmp_/i;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** Every primary-key column has a value (a null key could match or create any row). */
function keyComplete(key: Record<string, unknown>, pk: string[]): boolean {
  return pk.length > 0 && pk.every((k) => key[k] !== null && key[k] !== undefined);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A refusal with the stage that produced it and audit-only details (never sent to the user). */
class Refusal extends AppError {
  constructor(
    readonly stage: string,
    err: AppError,
    readonly internal: Record<string, unknown> = {},
  ) {
    super(err.code, err.message, err.details);
  }
}

const refuse = (stage: string, err: AppError, internal?: Record<string, unknown>) =>
  new Refusal(stage, err, internal);

/** Everything the Sankhya AUTHORIZE → PREVIEW stages produce, at prepare and again at execute. */
interface SankhyaResolution {
  permission: Permission;
  environment: Environment;
  capability: Capability;
  decision: PolicyDecision;
  table: CatalogTable;
  targets: PreviewTarget[];
  /** UPDATE: the SET columns, in statement order. */
  setColumns: string[];
  previewKind: PreviewKind;
  previewLabels: PreviewKind[];
}

interface ScratchResolution {
  workspace: ScratchWorkspace;
  stmt: ScratchStatement;
  capability: Capability;
  decision: PolicyDecision;
  dry: DryRunResult;
  targets: PreviewTarget[];
  entity: string;
}

/** Scratch CREATE / ALTER / DROP: the structure dry run instead of a row diff. */
interface ScratchDdlResolution {
  workspace: ScratchWorkspace;
  stmt: ScratchStatement;
  permission: Permission;
  capability: Capability;
  decision: PolicyDecision;
  dry: DdlDryRunResult;
  /** One target: the table, its structure before and after (see `structureTarget`). */
  targets: PreviewTarget[];
  entity: string;
  /** Ephemeral copies of Sankhya parts, still in the workspace: the caller drops them. */
  ephemeral: HybridPart[];
  copies: SankhyaCopy[];
}

/** AUTHORIZE → PREVIEW of a business action, at prepare and again at execute. */
interface ActionResolution {
  action: BusinessAction;
  input: Record<string, unknown>;
  environment: Environment;
  capability: Capability;
  decision: PolicyDecision;
  table: CatalogTable;
  /** Exactly one: the row the action changes, with its real before values. */
  targets: PreviewTarget[];
}

const invalidPlan = (message: string) => new AppError('CONFIRMATION_INVALID', message);

export class MutationService {
  constructor(private readonly deps: MutationDeps) {}

  async prepare(ctx: PrepareContext): Promise<PreparedMutation> {
    const { auth, sql } = ctx;
    let classified: Classified | undefined;
    let environment: Environment | null = null;
    try {
      classified = classifyStatement(sql);

      // CREATE / ALTER / DROP of a tmp_ table: a structure dry run in the caller's workspace.
      const ddl = scratchDdlOf(classified);
      if (ddl) {
        environment = SCRATCH_ENVIRONMENT;
        const d = await this.resolveScratchDdl(auth, ddl, sql, ctx.copier, ctx.connectionId);
        await this.dropCopies(d);
        return await this.finishPlan(ctx, {
          operation: ddl.kind,
          kind: ddl.kind,
          permission: d.permission,
          environment: SCRATCH_ENVIRONMENT,
          connectionId: SCRATCH_CONNECTION_ID,
          capability: d.capability,
          decision: d.decision,
          targets: d.targets,
          entity: d.entity,
          previewKind: 'TRANSACTIONAL_DRY_RUN',
          previewLabels: ['TRANSACTIONAL_DRY_RUN'],
          structure: d.dry,
          ...(d.copies.length > 0
            ? { sankhyaParts: d.copies, sourceConnectionId: ctx.connectionId }
            : {}),
        });
      }

      const write = parseWrite(classified);

      // ---------------------------------------------------------------- VALIDATE
      validateWrite(write);

      // A write to a scratch table never touches Sankhya: it gets a transactional dry run.
      if (SCRATCH_TABLE.test(write.table)) {
        environment = SCRATCH_ENVIRONMENT;
        const s = await this.resolveScratch(auth, write, sql);
        return await this.finishPlan(ctx, {
          operation: write.kind,
          kind: write.kind,
          permission: 'TEMP.WRITE',
          environment: SCRATCH_ENVIRONMENT,
          connectionId: SCRATCH_CONNECTION_ID,
          capability: s.capability,
          decision: s.decision,
          targets: s.targets,
          entity: s.entity,
          previewKind: 'TRANSACTIONAL_DRY_RUN',
          previewLabels: ['TRANSACTIONAL_DRY_RUN'],
        });
      }

      const r = await this.resolveSankhya(
        auth,
        ctx.connectionId,
        write,
        ctx.allowPreviewOnly === true ? 'preview' : 'prepare',
        (e) => {
          environment = e;
        },
      );
      return await this.finishPlan(ctx, {
        operation: write.kind,
        kind: write.kind,
        permission: r.permission,
        environment: r.environment,
        connectionId: ctx.connectionId,
        capability: r.capability,
        decision: r.decision,
        targets: r.targets,
        entity: r.table.name.toUpperCase(),
        entityName: r.table.entityName,
        previewKind: r.previewKind,
        previewLabels: r.previewLabels,
      });
    } catch (err) {
      await this.auditRefusal(ctx, classified, environment, err);
      if (err instanceof Refusal) throw new AppError(err.code, err.message, err.details);
      throw err;
    }
  }

  /**
   * AUTHORIZE → PLAN → PREVIEW of a Sankhya write. Used by `prepare`, and again by `execute`
   * with fresh grants and rules, so both see exactly the same checks.
   *
   * UPDATE without WHERE is allowed only when the policy engine applies a WHERE override
   * (one ALLOW rule with `overrideWhereRequired` covering the entity), which forces the strong
   * phrase and four-eyes approval; anything else is WHERE_REQUIRED. That check runs before the
   * catalog is read, so a refused statement makes no gateway call.
   *
   * RBAC: `prepare` and `execute` need the statement's own permission. `preview` (a `prepare`
   * opted into with `allowPreviewOnly`, by POST /api/query/preview only) also accepts
   * DATA.PREVIEW, which only shows the plan: the policy is still evaluated on the statement's
   * write action (an explicit ALLOW is needed, exactly as for a writer), and `execute` refuses it.
   */
  private async resolveSankhya(
    auth: AuthState,
    connectionId: string,
    write: WriteClassified,
    mode: 'preview' | 'prepare' | 'execute',
    onEnvironment?: (environment: Environment) => void,
  ): Promise<SankhyaResolution> {
    const permission = PERMISSION[write.kind];
    // DELETE without WHERE never gets here (VALIDATE); INSERT has no WHERE at all.
    const noWhere = write.kind === 'UPDATE' && !write.hasWhere;
    const holds = auth.grants.permissions.has(permission);
    const previewOnly = !holds && mode === 'preview' && auth.grants.permissions.has('DATA.PREVIEW');
    if (!holds && !previewOnly) {
      throw refuse(
        'AUTHORIZE',
        noWhere && mode !== 'execute'
          ? whereRequired(write.kind)
          : new AppError('FORBIDDEN', 'You do not have permission for this action', { permission }),
      );
    }
    // The policy engine denies an action the caller does not hold. A preview-only caller is
    // evaluated as if it held the statement permission, so the rules decide exactly what they
    // would for a writer; this set is used only for the write-action decisions below.
    const writeAuth: AuthState = previewOnly
      ? {
          ...auth,
          grants: {
            ...auth.grants,
            permissions: new Set<Permission>([...auth.grants.permissions, permission]),
          },
        }
      : auth;
    const { policies, connections, metadata } = this.deps;
    const defaults = { maxReadRows: this.deps.maxReadRows };
    const groupIds = await this.deps.authz.activeGroupIds(auth.user.id);
    // The connection is authorized for reading first: the preview reads the targets, and a
    // write request without entities is always denied by the engine. The write itself is
    // authorized per entity below.
    const access = await authorizeConnection({
      policies,
      auth,
      groupIds,
      action: 'QUERY.SELECT',
      connectionId,
      connections,
    });
    if (!access.ok) throw refuse('AUTHORIZE', connectionDenied(), { reasons: access.reasons });
    const environment = access.environment;
    onEnvironment?.(environment);

    if (noWhere) {
      const override = await evaluateFor({
        policies,
        auth: writeAuth,
        groupIds,
        action: permission,
        environment,
        connectionId,
        entities: [write.table.toUpperCase()],
        hasWhere: false,
        defaults,
      });
      if (!overrideApplies(override)) {
        throw refuse('VALIDATE', whereRequired(write.kind), { reasons: override.reasons });
      }
    }

    // What no table could support (a Sankhya DELETE, a shape the save service cannot take) is
    // refused as such first; it does not depend on the table, so it tells nothing about it.
    const shape = resolveCapability(write, {
      catalog: { tables: [{ name: write.table }] },
      scratchTables: [],
    });
    if (shape.class === 'UNSUPPORTED' || shape.route !== 'SANKHYA_SAVE') {
      throw refuse(
        'AUTHORIZE',
        new AppError('OPERATION_NOT_SUPPORTED', shape.reason, { capability: shape.class }),
      );
    }

    // The table alone first, so a table the caller may not change is refused before its
    // dictionary is read and neither the cost nor a failure of that read tells it apart from one
    // they may change: a DENY on the table refuses it, and so does the lack of any ALLOW that can
    // reach it. An ALLOW limited to some of its columns passes here (`tableOnly`); which columns
    // the statement may change is decided by the full request below.
    const tableDecision = await evaluateFor({
      policies,
      auth: writeAuth,
      groupIds,
      action: permission,
      environment,
      connectionId,
      entities: [write.table.toUpperCase()],
      columns: [],
      hasWhere: true,
      defaults,
      tableOnly: true,
    });
    if (tableDecision.effect !== 'ALLOW') {
      throw refuse('AUTHORIZE', new AppError('FORBIDDEN', 'The change was denied by policy'), {
        reasons: tableDecision.reasons,
        matchedRuleIds: tableDecision.matchedRuleIds,
        policyVersion: tableDecision.policyVersion,
      });
    }

    const catalog = await tableCatalog(metadata, connectionId, write.table);
    let capability = resolveCapability(write, { catalog, scratchTables: [] });
    if (capability.class === 'UNSUPPORTED' || capability.route !== 'SANKHYA_SAVE') {
      throw refuse(
        'AUTHORIZE',
        new AppError('OPERATION_NOT_SUPPORTED', capability.reason, {
          capability: capability.class,
        }),
      );
    }
    if (capability.blocked) {
      // Only a missing WHERE blocks a capability, and the override was checked above; the
      // decision below must confirm it again.
      if (!noWhere) {
        throw refuse('VALIDATE', new AppError('WHERE_REQUIRED', capability.blocked.reason));
      }
      const { blocked: _blocked, ...rest } = capability;
      capability = rest;
    }
    const stmt = write.stmt;
    if (!stmt || stmt.type === 'delete') {
      throw refuse(
        'VALIDATE',
        new AppError('OPERATION_NOT_SUPPORTED', 'This statement shape cannot be previewed.'),
      );
    }
    const table = catalogTable(catalog, write.table);
    writeInstance(table);

    const decision = await evaluateFor({
      policies,
      auth: writeAuth,
      groupIds,
      action: permission,
      environment,
      connectionId,
      entities: [table.name.toUpperCase()],
      columns: writeColumns(stmt, table),
      hasWhere: write.hasWhere,
      defaults,
    });
    if (decision.effect !== 'ALLOW') {
      throw refuse('AUTHORIZE', new AppError('FORBIDDEN', 'The change was denied by policy'), {
        reasons: decision.reasons,
        matchedRuleIds: decision.matchedRuleIds,
        policyVersion: decision.policyVersion,
      });
    }
    if (noWhere && !overrideApplies(decision)) {
      throw refuse('VALIDATE', whereRequired(write.kind), { reasons: decision.reasons });
    }

    // ---------------------------------------------------------------- PLAN + PREVIEW
    const maxWriteRows = decision.limits.maxWriteRows;
    let targets: PreviewTarget[];
    let setColumns: string[] = [];
    let previewKind: PreviewKind;
    let previewLabels: PreviewKind[];
    if (stmt.type === 'insert') {
      targets = [insertTarget(stmt, table)];
      previewKind = 'SIMULATED_PREVIEW';
      previewLabels = ['SIMULATED_PREVIEW'];
    } else {
      const u = await this.updateTargets(auth, connectionId, stmt, table, catalog, {
        groupIds,
        environment,
        maxWriteRows,
      });
      targets = u.targets;
      setColumns = u.setColumns;
      previewKind = 'IMPACT_ANALYSIS';
      previewLabels = ['IMPACT_ANALYSIS', 'SIMULATED_PREVIEW'];
    }
    if (stmt.type === 'update') {
      const pk = table.columns.filter((c) => c.pk).map((c) => c.name.toUpperCase());
      if (!targets.every((t) => keyComplete(t.key, pk))) {
        throw refuse(
          'PREVIEW',
          new AppError(
            'OPERATION_NOT_SUPPORTED',
            `${table.name.toUpperCase()}: a row to change has no complete primary key; it cannot be saved by key.`,
          ),
        );
      }
    }
    if (targets.length > maxWriteRows) {
      throw refuse(
        'PREVIEW',
        new AppError(
          'WRITE_ROW_LIMIT_EXCEEDED',
          `The change affects more than ${maxWriteRows} rows.`,
          { maxWriteRows },
        ),
      );
    }
    return {
      permission,
      environment,
      capability,
      decision,
      table,
      targets,
      setColumns,
      previewKind,
      previewLabels,
    };
  }

  /** IMPACT: persists the immutable plan, audits it and shapes the response. */
  private async finishPlan(
    ctx: PrepareContext,
    o: {
      /** INSERT / UPDATE / DELETE, or the word of a business action (summary and phrase). */
      operation: string;
      /** The parsed statement kind of a SQL plan (none for a business action). */
      kind?: PlannedKind;
      permission: Permission;
      environment: Environment;
      connectionId: string;
      capability: Capability;
      decision: PolicyDecision;
      targets: PreviewTarget[];
      entity: string;
      /** The TDDINS instance a Sankhya plan saves through, frozen in the plan (see execute). */
      entityName?: string | undefined;
      previewKind: PreviewKind;
      previewLabels: PreviewKind[];
      /** Scratch DDL: the structure dry run, shown as BEFORE/AFTER. */
      structure?: DdlDryRunResult;
      sankhyaParts?: SankhyaCopy[];
      sourceConnectionId?: string;
    },
  ): Promise<PreparedMutation> {
    const { auth, sql } = ctx;
    const { operation, permission, environment, capability, decision, targets, entity } = o;
    const { previewKind, previewLabels } = o;
    const affected = targets.length;
    const preview = {
      targets,
      affected,
      ...(o.entityName ? { entityName: o.entityName } : {}),
      ...(o.structure ? { structure: o.structure } : {}),
      ...(o.structure && o.kind === 'DROP_TABLE'
        ? { lostRows: o.structure.before?.rows ?? 0 }
        : {}),
      ...(o.sankhyaParts ? { sankhyaParts: o.sankhyaParts } : {}),
      ...(o.sourceConnectionId ? { sourceConnectionId: o.sourceConnectionId } : {}),
    };
    const created = await this.deps.plans.create({
      userId: auth.user.id,
      sessionId: auth.session.id,
      connectionId: o.connectionId,
      environment,
      sql,
      params: null,
      capability,
      decision,
      targets,
      preview,
      previewKind,
      summary: { action: operation, count: affected, entity },
    });
    const needsPhrase = decision.limits.requireStrongConfirmation || environment === 'PRODUCTION';
    const prepared: PreparedMutation = {
      planId: created.id,
      token: created.token,
      expiresAt: created.expiresAt.toISOString(),
      capability,
      previewKind,
      previewLabels,
      preview,
      impact: { entities: [entity], rows: affected, environment },
      requires: {
        strongConfirmation: needsPhrase
          ? strongConfirmationPhrase(environment, operation, affected, entity)
          : null,
        approval: decision.limits.requireApproval,
      },
      ...(o.kind ? { operation: o.kind } : {}),
      permitted: auth.grants.permissions.has(permission),
    };
    await this.deps.audit.recordPlanCreated(
      {
        userId: auth.user.id,
        userEmail: auth.user.email,
        ip: ctx.meta?.ip ?? null,
        requestId: ctx.meta?.requestId ?? null,
        connectionId: o.connectionId,
        environment,
        planId: created.id,
        planHash: created.planHash,
        capability: permission,
      },
      {
        statement: sql,
        policyDecision: policySummary(decision),
        details: {
          operation,
          resource: entity,
          affected,
          previewKind,
          previewLabels,
          // Created through DATA.PREVIEW: the owner may look at it but not execute it.
          ...(prepared.permitted ? {} : { previewOnly: true }),
          // Without snapshots the audit keeps only the count and the keys.
          ...(decision.limits.auditSnapshots
            ? {}
            : { keys: targets.slice(0, SNAPSHOT_MAX_ROWS).map((t) => t.key) }),
        },
        auditSnapshots: decision.limits.auditSnapshots,
        before: targets.flatMap((t) => (t.before ? [t.before] : [])),
        after: targets.map((t) => t.after),
      },
    );
    return prepared;
  }

  /**
   * PARSE → … → IMPACT of a typed business action (Task 11.3). The input is validated against the
   * action's schema, the connection must allow the action (live connections only run the actions
   * listed in BUSINESS_ACTIONS_ENABLED), the PolicyEngine decides on the action's permission with
   * `entities = [action.entity]`, and the row is read for real (IMPACT_ANALYSIS) with the
   * expected effect applied (SIMULATED_PREVIEW). Nothing is called: the plan runs only through
   * `execute`.
   */
  async prepareAction(ctx: PrepareActionContext): Promise<PreparedAction> {
    const { action } = ctx;
    let environment: Environment | null = null;
    let statement = `ACTION ${action.id}`;
    const base = { auth: ctx.auth, connectionId: ctx.connectionId, meta: ctx.meta ?? {} };
    try {
      const a = await this.resolveAction(ctx.auth, ctx.connectionId, action, ctx.input, (e) => {
        environment = e;
      });
      statement = actionStatement(action, a.input);
      const prepared = await this.finishPlan(
        { ...base, sql: statement },
        {
          operation: actionWord(action),
          permission: action.permission,
          environment: a.environment,
          connectionId: ctx.connectionId,
          capability: a.capability,
          decision: a.decision,
          targets: a.targets,
          entity: a.table.name.toUpperCase(),
          entityName: a.table.entityName,
          previewKind: 'IMPACT_ANALYSIS',
          previewLabels: ['IMPACT_ANALYSIS', 'SIMULATED_PREVIEW'],
        },
      );
      return { ...prepared, action: action.id };
    } catch (err) {
      await this.auditRefusal({ ...base, sql: statement }, undefined, environment, err);
      if (err instanceof Refusal) throw new AppError(err.code, err.message, err.details);
      throw err;
    }
  }

  /** AUTHORIZE → PREVIEW of a business action; used by `prepareAction` and again by `execute`. */
  private async resolveAction(
    auth: AuthState,
    connectionId: string,
    action: BusinessAction,
    rawInput: unknown,
    onEnvironment?: (environment: Environment) => void,
  ): Promise<ActionResolution> {
    const permission = action.permission;
    if (!auth.grants.permissions.has(permission)) {
      throw refuse(
        'AUTHORIZE',
        new AppError('FORBIDDEN', 'You do not have permission for this action', { permission }),
      );
    }
    const parsed = action.input.safeParse(rawInput);
    if (!parsed.success) {
      throw refuse(
        'VALIDATE',
        new AppError('VALIDATION_ERROR', 'The action input is invalid.', {
          issues: parsed.error.issues.map((i) => ({
            path: i.path.map(String).join('.'),
            message: i.message,
          })),
        }),
      );
    }
    const input = parsed.data;
    const { policies, connections, metadata } = this.deps;
    const groupIds = await this.deps.authz.activeGroupIds(auth.user.id);
    const access = await authorizeConnection({
      policies,
      auth,
      groupIds,
      action: 'QUERY.SELECT',
      connectionId,
      connections,
    });
    if (!access.ok) throw refuse('AUTHORIZE', connectionDenied(), { reasons: access.reasons });
    const environment = access.environment;
    onEnvironment?.(environment);
    // Before any gateway call: a live connection runs only the actions explicitly enabled.
    const { mode } = await connections.get(connectionId);
    if (!actionEnabled(action, mode, this.deps.businessActionsEnabled ?? [])) {
      throw refuse(
        'AUTHORIZE',
        new AppError(
          'OPERATION_NOT_SUPPORTED',
          `${action.id} is not enabled on live connections (BUSINESS_ACTIONS_ENABLED).`,
          { action: action.id },
        ),
      );
    }

    const catalog = await tableCatalog(metadata, connectionId, action.entity);
    const table = catalogTable(catalog, action.entity);
    writeInstance(table);
    const entity = table.name.toUpperCase();
    const known = new Set(table.columns.map((c) => c.name.toUpperCase()));
    const pk = table.columns.filter((c) => c.pk).map((c) => c.name.toUpperCase());
    const key = action.key(input);
    if (
      pk.length === 0 ||
      pk.length !== Object.keys(key).length ||
      !pk.every((k) => key[k] !== undefined)
    ) {
      throw refuse(
        'PLAN',
        new AppError(
          'OPERATION_NOT_SUPPORTED',
          `${entity}: the action key does not match the primary key of the catalog.`,
        ),
      );
    }
    if (!table.entityName) {
      throw refuse(
        'PLAN',
        new AppError(
          'OPERATION_NOT_SUPPORTED',
          `${entity} has no entity name in the data dictionary: it cannot be verified.`,
        ),
      );
    }
    const effect = action.effect(input);
    const selected = [...new Set([...pk, ...action.columns, ...Object.keys(effect)])].map((c) =>
      columnOf(c, known),
    );
    const decision = await evaluateFor({
      policies,
      auth,
      groupIds,
      action: permission,
      environment,
      connectionId,
      entities: [entity],
      columns: selected.map((name) => ({ table: entity, name })),
      hasWhere: true,
      defaults: { maxReadRows: this.deps.maxReadRows },
    });
    if (decision.effect !== 'ALLOW') {
      throw refuse('AUTHORIZE', new AppError('FORBIDDEN', 'The action was denied by policy'), {
        reasons: decision.reasons,
        matchedRuleIds: decision.matchedRuleIds,
        policyVersion: decision.policyVersion,
      });
    }
    if (decision.limits.maxWriteRows < 1) {
      throw refuse(
        'PREVIEW',
        new AppError('WRITE_ROW_LIMIT_EXCEEDED', 'The action changes more rows than allowed.', {
          maxWriteRows: decision.limits.maxWriteRows,
        }),
      );
    }

    // ---------------------------------------------------------------- PREVIEW (the real row)
    const where = pk.map((k) => `${k} = ${literalSql(key[k]!)}`).join(' AND ');
    const runtime = await connections.getRuntime(connectionId);
    const out = await executeRead({
      runtime,
      catalog,
      sql: `SELECT ${selected.join(', ')} FROM ${entity} WHERE ${where}`,
      maxRows: 2,
      signal: new AbortController().signal,
      decide: async (analysis) => {
        const t = readTargets(analysis, catalog);
        const read = await evaluateFor({
          policies,
          auth,
          groupIds,
          action: 'QUERY.SELECT',
          environment,
          connectionId,
          entities: t.entities,
          columns: t.columns,
          defaults: { maxReadRows: 2 },
        });
        return read.effect === 'ALLOW'
          ? { effect: 'ALLOW', maxRows: read.limits.maxReadRows }
          : { effect: 'DENY', reason: 'The action was denied by policy' };
      },
    });
    if (out.rows.length !== 1) {
      throw refuse(
        'PREVIEW',
        out.rows.length === 0
          ? new AppError('RESOURCE_NOT_FOUND', `${entity}: the row does not exist.`)
          : new AppError(
              'OPERATION_NOT_SUPPORTED',
              `${entity}: the key matches more than one row.`,
            ),
      );
    }
    const index = out.columns.map((c) => c.toUpperCase());
    const before: RecordValues = {};
    for (const name of selected) {
      const i = index.indexOf(name);
      before[name] = i === -1 ? null : toValue(out.rows[0]![i]);
    }
    // A row already in the target state would read back as VERIFIED whether or not the action
    // did anything: refuse it instead.
    if (Object.entries(effect).every(([c, v]) => valuesMatch(v, before[c.toUpperCase()]))) {
      throw refuse(
        'PREVIEW',
        new AppError('OPERATION_NOT_SUPPORTED', `${entity}: the row is already in that state.`),
      );
    }
    const targetKey: RecordValues = {};
    for (const k of pk) targetKey[k] = before[k] ?? null;
    if (!keyComplete(targetKey, pk)) {
      throw refuse(
        'PREVIEW',
        new AppError('OPERATION_NOT_SUPPORTED', `${entity}: the row has no complete primary key.`),
      );
    }
    const after: RecordValues = { ...before };
    for (const [c, v] of Object.entries(effect)) after[c.toUpperCase()] = v;
    const capability: Capability = {
      class: 'SUPPORTED',
      route: 'SANKHYA_ACTION',
      reason: `Business action ${action.id} on ${entity}.`,
      action: 'SANKHYA.BUSINESS_ACTION.EXECUTE',
      actions: ['SANKHYA.BUSINESS_ACTION.EXECUTE'],
    };
    return {
      action,
      input,
      environment,
      capability,
      decision,
      table,
      targets: [{ key: targetKey, before, after }],
    };
  }

  /**
   * Scratch AUTHORIZE → PREVIEW: the statement runs inside a transaction of the caller's own
   * workspace and is rolled back (TRANSACTIONAL_DRY_RUN). Policy is evaluated first, exactly as
   * for a real write. Used by `prepare` and again by `execute`.
   */
  private async resolveScratch(
    auth: AuthState,
    write: WriteClassified,
    sql: string,
  ): Promise<ScratchResolution> {
    const permission: Permission = 'TEMP.WRITE';
    if (!auth.grants.permissions.has(permission)) {
      throw refuse(
        'AUTHORIZE',
        new AppError('FORBIDDEN', 'You do not have permission for this action', { permission }),
      );
    }
    const workspace = await this.deps.scratch.workspace(auth.user.id);
    const names = (await workspace.tables()).map((t) => t.name);
    const capability = resolveCapability(write, { catalog: { tables: [] }, scratchTables: names });
    if (capability.class === 'UNSUPPORTED' || capability.route !== 'SCRATCH') {
      throw refuse(
        'AUTHORIZE',
        new AppError('OPERATION_NOT_SUPPORTED', capability.reason, {
          capability: capability.class,
        }),
      );
    }
    if (capability.blocked) {
      throw refuse('VALIDATE', new AppError('WHERE_REQUIRED', capability.blocked.reason));
    }
    let stmt: ScratchStatement;
    try {
      stmt = analyzeScratchSql(sql);
    } catch (err) {
      throw refuse(
        'VALIDATE',
        isAppError(err) ? new AppError(err.code, err.message, err.details) : notSimulable(),
      );
    }
    if (stmt.target === null || !stmt.mutating || stmt.action !== 'TEMP.WRITE') {
      throw refuse(
        'VALIDATE',
        new AppError('OPERATION_NOT_SUPPORTED', 'Only INSERT, UPDATE and DELETE can be previewed.'),
      );
    }
    const entity = stmt.target.toUpperCase();
    const groupIds = await this.deps.authz.activeGroupIds(auth.user.id);
    const decision = await evaluateFor({
      policies: this.deps.policies,
      auth,
      groupIds,
      action: 'TEMP.WRITE',
      environment: SCRATCH_ENVIRONMENT,
      connectionId: SCRATCH_CONNECTION_ID,
      entities: [...new Set([...stmt.tables, stmt.target])],
      // An INSERT has no WHERE to give; the TEMP.WRITE rule only asks UPDATE and DELETE for one.
      hasWhere: write.kind === 'INSERT' || write.hasWhere,
      ...(this.deps.scratchMaxReadRows !== undefined
        ? { defaults: { maxReadRows: this.deps.scratchMaxReadRows } }
        : {}),
    });
    if (decision.effect !== 'ALLOW') {
      throw refuse('AUTHORIZE', new AppError('FORBIDDEN', 'The change was denied by policy'), {
        reasons: decision.reasons,
        matchedRuleIds: decision.matchedRuleIds,
        policyVersion: decision.policyVersion,
      });
    }
    // Like the scratch route, the write cap applies only when a rule sets it.
    const writeCap = decision.rowLimitsFromRules.maxWriteRows ? decision.limits.maxWriteRows : null;

    const dry = await workspace.transactionalDryRun(sql);
    if (writeCap !== null && dry.rowCount > writeCap) {
      throw refuse(
        'PREVIEW',
        new AppError('WRITE_ROW_LIMIT_EXCEEDED', `The change affects more than ${writeCap} rows.`, {
          maxWriteRows: writeCap,
        }),
      );
    }
    // A snapshot cut at the preview cap is a window, not the table: rows shift in and out of it
    // across the write, so before/after pairing would match unrelated rows. Refuse instead.
    if (dry.before.truncated || dry.after.truncated) {
      throw refuse(
        'PREVIEW',
        new AppError(
          'OPERATION_NOT_SUPPORTED',
          'The table is too large to preview: its rows exceed the scratch preview limit.',
          { reason: 'SNAPSHOT_TRUNCATED' },
        ),
      );
    }
    const targets = diffSnapshots(write.kind, dry.before, dry.after);
    if (targets.length !== dry.rowCount) {
      throw refuse(
        'PREVIEW',
        new AppError(
          'OPERATION_NOT_SUPPORTED',
          'The affected rows cannot be identified in the preview (large table or no visible change).',
        ),
      );
    }
    return { workspace, stmt, capability, decision, dry, targets, entity };
  }

  /**
   * Scratch DDL AUTHORIZE -> PREVIEW: TEMP.CREATE (CREATE, ALTER) or TEMP.DROP (DROP) and an ALLOW
   * of the policy on that action, then the statement runs inside a transaction of the caller's
   * workspace and is rolled back; the preview is the table's structure and row count before and
   * after. Used by `prepare` and again by `execute`.
   */
  private async resolveScratchDdl(
    auth: AuthState,
    ddl: DdlClassified,
    sql: string,
    copier: SankhyaCopier | undefined,
    sourceConnectionId: string | undefined,
  ): Promise<ScratchDdlResolution> {
    const permission = DDL_PERMISSION[ddl.kind];
    if (!auth.grants.permissions.has(permission)) {
      throw refuse(
        'AUTHORIZE',
        new AppError('FORBIDDEN', 'You do not have permission for this action', { permission }),
      );
    }
    const workspace = await this.deps.scratch.workspace(auth.user.id);
    const names = (await workspace.tables()).map((t) => t.name);
    if (ddl.kind !== 'CREATE_TABLE' && !names.includes(ddl.table.toLowerCase())) {
      throw refuse(
        'VALIDATE',
        new AppError('OPERATION_NOT_SUPPORTED', `${ddl.table} is not in your scratch area.`),
      );
    }
    const capability = resolveCapability(ddl, { catalog: { tables: [] }, scratchTables: names });
    // HYBRID: a CREATE TABLE tmp_… AS whose query reads Sankhya, copied first by the copier.
    const fromSankhya = capability.route === 'HYBRID' && ddl.kind === 'CREATE_TABLE';
    if (
      capability.class === 'UNSUPPORTED' ||
      (capability.route !== 'SCRATCH' && !fromSankhya) ||
      (fromSankhya && (copier === undefined || sourceConnectionId === undefined))
    ) {
      throw refuse(
        'AUTHORIZE',
        new AppError(
          'OPERATION_NOT_SUPPORTED',
          fromSankhya
            ? 'A scratch table filled from Sankhya rows is previewed through /api/query/preview.'
            : capability.reason,
          { capability: capability.class },
        ),
      );
    }
    let stmt: ScratchStatement;
    let parts: HybridPart[] = [];
    try {
      if (fromSankhya) {
        ({ statement: stmt, parts } = planScratchCreateAs(sql));
      } else {
        stmt = analyzeScratchSql(sql);
      }
    } catch (err) {
      throw refuse(
        'VALIDATE',
        isAppError(err) ? new AppError(err.code, err.message, err.details) : notSimulable(),
      );
    }
    const ephemeral = new Set(parts.map((p) => p.into));
    if (stmt.target === null || stmt.action !== permission) {
      throw refuse(
        'VALIDATE',
        new AppError('OPERATION_NOT_SUPPORTED', 'The statement could not be previewed.'),
      );
    }
    const groupIds = await this.deps.authz.activeGroupIds(auth.user.id);
    const decision = await evaluateFor({
      policies: this.deps.policies,
      auth,
      groupIds,
      action: permission,
      environment: SCRATCH_ENVIRONMENT,
      connectionId: SCRATCH_CONNECTION_ID,
      // The ephemeral copies are judged on the Sankhya side, by the copier.
      entities: [...new Set([...stmt.tables.filter((t) => !ephemeral.has(t)), stmt.target])],
      hasWhere: true,
      ...(this.deps.scratchMaxReadRows !== undefined
        ? { defaults: { maxReadRows: this.deps.scratchMaxReadRows } }
        : {}),
    });
    if (decision.effect !== 'ALLOW') {
      throw refuse('AUTHORIZE', new AppError('FORBIDDEN', 'The change was denied by policy'), {
        reasons: decision.reasons,
        matchedRuleIds: decision.matchedRuleIds,
        policyVersion: decision.policyVersion,
      });
    }
    let dry: DdlDryRunResult;
    let copies: SankhyaCopy[] = [];
    try {
      if (parts.length > 0) copies = await copier!(workspace, parts, sourceConnectionId!);
      dry = await workspace.ddlDryRun(stmt);
    } catch (err) {
      await this.dropCopies({ workspace, ephemeral: parts });
      if (err instanceof Refusal) throw err;
      throw refuse(
        'PREVIEW',
        isAppError(err) ? new AppError(err.code, err.message, err.details) : notSimulable(),
      );
    }
    return {
      workspace,
      stmt,
      permission,
      capability,
      decision,
      dry,
      targets: [structureTarget(dry)],
      entity: dry.table.toUpperCase(),
      ephemeral: parts,
      copies,
    };
  }

  /** Drops the ephemeral Sankhya copies of a scratch DDL; never throws. */
  private async dropCopies(d: Pick<ScratchDdlResolution, 'workspace' | 'ephemeral'>) {
    if (d.ephemeral.length === 0) return;
    await dropEphemeral(d.workspace, d.ephemeral, (err) =>
      this.deps.logger?.error(
        { errorName: err instanceof Error ? err.name : typeof err },
        'An ephemeral copy could not be dropped',
      ),
    );
  }

  /** Before snapshot of the UPDATE targets through the read path, capped at maxWriteRows + 1. */
  private async updateTargets(
    auth: AuthState,
    connectionId: string,
    stmt: UpdateStatement,
    table: CatalogTable,
    catalog: Catalog,
    opts: { groupIds: string[]; environment: Environment; maxWriteRows: number },
  ): Promise<{ targets: PreviewTarget[]; setColumns: string[] }> {
    const pk = table.columns.filter((c) => c.pk).map((c) => c.name.toUpperCase());
    if (pk.length === 0) {
      throw refuse(
        'PLAN',
        new AppError(
          'OPERATION_NOT_SUPPORTED',
          `${table.name} has no known primary key: its rows cannot be identified.`,
        ),
      );
    }
    const qualifiers = new Set([table.name.toUpperCase()]);
    if (stmt.table.alias) qualifiers.add(stmt.table.alias.toUpperCase());
    const known = new Set(table.columns.map((c) => c.name.toUpperCase()));
    const setColumns = stmt.set.map((s) => columnOf(s.column, known));
    for (const c of setColumns) {
      if (pk.includes(c))
        throw refuse(
          'VALIDATE',
          new AppError(
            'COLUMN_NOT_WRITABLE',
            `${c} is part of the primary key and cannot be changed.`,
          ),
        );
    }
    const referenced = new Set<string>();
    for (const s of stmt.set) collectColumns(s.value, qualifiers, known, referenced);
    const selected = [...new Set([...pk, ...setColumns, ...referenced])];
    // No WHERE only reaches here under a policy WHERE override (checked by the caller); the
    // snapshot then reads the whole table, still capped below.
    const where = stmt.where ? ` WHERE ${renderExpr(stmt.where, qualifiers, known)}` : '';
    const snapshotSql = `SELECT ${selected.join(', ')} FROM ${table.name.toUpperCase()}${where}`;

    const { policies, connections } = this.deps;
    const runtime = await connections.getRuntime(connectionId);
    const maxRows = Math.max(1, Math.min(this.deps.maxReadRows, opts.maxWriteRows));
    const out = await executeRead({
      runtime,
      catalog,
      sql: snapshotSql,
      maxRows,
      signal: new AbortController().signal,
      decide: async (analysis) => {
        const t = readTargets(analysis, catalog);
        const read = await evaluateFor({
          policies,
          auth,
          groupIds: opts.groupIds,
          action: 'QUERY.SELECT',
          environment: opts.environment,
          connectionId,
          entities: t.entities,
          columns: t.columns,
          defaults: { maxReadRows: maxRows },
        });
        return read.effect === 'ALLOW'
          ? { effect: 'ALLOW', maxRows: read.limits.maxReadRows }
          : { effect: 'DENY', reason: 'The change was denied by policy' };
      },
    });
    if (out.truncated) {
      // The snapshot may be cut by a read limit lower than the write limit: name both.
      throw refuse(
        'PREVIEW',
        new AppError(
          'WRITE_ROW_LIMIT_EXCEEDED',
          out.maxRows < opts.maxWriteRows
            ? `The change affects more than ${out.maxRows} rows, the most its preview may read; the write limit is ${opts.maxWriteRows}.`
            : `The change affects more than ${opts.maxWriteRows} rows.`,
          { maxWriteRows: opts.maxWriteRows, previewRows: out.maxRows },
        ),
      );
    }
    const index = out.columns.map((c) => c.toUpperCase());
    const targets = out.rows.map((raw) => {
      const before: RecordValues = {};
      selected.forEach((name) => {
        const i = index.indexOf(name);
        before[name] = i === -1 ? null : toValue(raw[i]);
      });
      const key: RecordValues = {};
      for (const k of pk) key[k] = before[k] ?? null;
      const after: RecordValues = { ...before };
      stmt.set.forEach((s, i) => {
        after[setColumns[i]!] = simulate(s.value, before, qualifiers);
      });
      return { key, before, after };
    });
    return { targets, setColumns };
  }

  // ======================================================================== execute

  async execute(ctx: ExecuteContext): Promise<ExecutionReport> {
    const { auth } = ctx;

    // ---------------------------------------------------------------- CONFIRM
    let consumed: ConsumedPlan & { approvalId?: string };
    try {
      const input = {
        id: ctx.planId,
        token: ctx.token,
        userId: auth.user.id,
        sessionId: auth.session.id,
        ...(ctx.strongConfirmation !== undefined
          ? { strongConfirmation: ctx.strongConfirmation }
          : {}),
        ...(ctx.idempotencyKey !== undefined ? { idempotencyKey: ctx.idempotencyKey } : {}),
      };
      const peek = await this.deps.plans.peek(ctx.planId, auth.user.id);
      // A plan sent to the wrong route (an action plan to /api/query/execute, a SQL plan or
      // another action's plan to an action route) is refused before it is consumed, so it can
      // still run on its own route. RE-AUTHORIZE checks it again on the consumed plan.
      if (peek && !routeMatches(peek, ctx.actionId)) {
        throw invalidPlan('This plan cannot be executed here.');
      }
      consumed = peek?.requiresApproval
        ? await this.deps.approvals.consumeForPlan(input)
        : await this.deps.plans.consume(input);
    } catch (err) {
      await this.auditConfirmRefusal(ctx, err);
      throw err;
    }
    const plan = consumed.plan;

    // A replay never runs anything: it answers with what the original call produced.
    if (consumed.replayed) return this.replay(plan);

    const started = Date.now();
    const lctx: AuditLifecycleContext = {
      userId: auth.user.id,
      userEmail: auth.user.email,
      ip: ctx.meta?.ip ?? null,
      requestId: ctx.meta?.requestId ?? null,
      connectionId: plan.connectionId,
      environment: plan.environment,
      planId: plan.id,
      planHash: plan.planHash,
      capability: null,
      approvalId: consumed.approvalId ?? null,
    };
    const scratch = plan.connectionId === SCRATCH_CONNECTION_ID;

    // ---------------------------------------------------------------- RE-AUTHORIZE
    let write: WriteClassified | undefined;
    let ddl: DdlClassified | null = null;
    // Holds ephemeral Sankhya copies until the run ends (dropped on every path).
    let ddlResolution: ScratchDdlResolution | undefined;
    let operation: string;
    let resolved:
      | { sankhya: SankhyaResolution }
      | { scratch: ScratchResolution }
      | { scratchDdl: ScratchDdlResolution }
      | { action: ActionResolution };
    let decision: PolicyDecision;
    let targets: PreviewTarget[];
    let entity: string;
    try {
      // A business action plan runs only through its own route, a SQL plan never through one.
      const act = actionPlanOf(plan);
      if (act !== undefined || ctx.actionId !== undefined) {
        if (act?.action.id !== ctx.actionId) {
          throw refuse('RE-AUTHORIZE', invalidPlan('This plan cannot be executed here.'));
        }
        lctx.capability = act!.action.permission;
        operation = actionWord(act!.action);
      } else {
        const classified = classifyStatement(plan.sql);
        ddl = scratch ? scratchDdlOf(classified) : null;
        if (ddl) {
          lctx.capability = DDL_PERMISSION[ddl.kind];
          operation = ddl.kind;
        } else {
          write = parseWrite(classified);
          lctx.capability = scratch ? 'TEMP.WRITE' : PERMISSION[write.kind];
          operation = write.kind;
          validateWrite(write);
        }
      }
      const fresh: AuthState = { ...auth, grants: await this.deps.authz.grants(auth.user.id) };
      await this.assertPolicyVersion(plan);

      if (act) {
        const a = await this.resolveAction(fresh, plan.connectionId, act.action, act.input);
        if (a.environment !== plan.environment) {
          throw refuse('RE-AUTHORIZE', invalidPlan('The connection changed after the preview.'));
        }
        resolved = { action: a };
        decision = a.decision;
        targets = a.targets;
        entity = a.table.name.toUpperCase();
      } else if (ddl) {
        const source = (plan.preview as { sourceConnectionId?: unknown } | null)
          ?.sourceConnectionId;
        const d = await this.resolveScratchDdl(
          fresh,
          ddl,
          plan.sql,
          ctx.copier,
          typeof source === 'string' ? source : undefined,
        );
        ddlResolution = d;
        resolved = { scratchDdl: d };
        decision = d.decision;
        targets = d.targets;
        entity = d.entity;
      } else if (scratch) {
        if (!SCRATCH_TABLE.test(write!.table))
          throw refuse('RE-AUTHORIZE', invalidPlan('The plan no longer matches its statement.'));
        const s = await this.resolveScratch(fresh, write!, plan.sql);
        resolved = { scratch: s };
        decision = s.decision;
        targets = s.targets;
        entity = s.entity;
      } else {
        const r = await this.resolveSankhya(fresh, plan.connectionId, write!, 'execute');
        if (r.environment !== plan.environment) {
          throw refuse('RE-AUTHORIZE', invalidPlan('The connection changed after the preview.'));
        }
        resolved = { sankhya: r };
        decision = r.decision;
        targets = r.targets;
        entity = r.table.name.toUpperCase();
      }
      const capability =
        'sankhya' in resolved
          ? resolved.sankhya.capability
          : 'action' in resolved
            ? resolved.action.capability
            : 'scratchDdl' in resolved
              ? resolved.scratchDdl.capability
              : resolved.scratch.capability;
      if (canonical(capability) !== canonical(plan.capability)) {
        throw refuse('RE-AUTHORIZE', invalidPlan('The capability changed after the preview.'));
      }
      if (!gatesHold(decision.limits, plan)) {
        throw refuse(
          'RE-AUTHORIZE',
          invalidPlan('The policy now requires more than the preview did; preview it again.'),
        );
      }
      // The instance the preview was made for is part of the plan; a dictionary that now names
      // another one for the table makes it a different change.
      const instance =
        'sankhya' in resolved
          ? resolved.sankhya.table.entityName
          : 'action' in resolved
            ? resolved.action.table.entityName
            : undefined;
      if (instance !== (plan.preview as { entityName?: unknown } | null)?.entityName) {
        throw refuse(
          'RE-AUTHORIZE',
          invalidPlan('The entity of the table changed after the preview; preview it again.'),
        );
      }
      if (targetsHashOf(targets) !== plan.targetsHash) {
        throw refuse(
          'IMPACT',
          new AppError(
            'TARGETS_CHANGED',
            'The rows changed after the preview; preview the change again.',
          ),
        );
      }
      if ('sankhya' in resolved && !resolved.sankhya.table.entityName) {
        throw refuse(
          'EXECUTE',
          new AppError(
            'OPERATION_NOT_SUPPORTED',
            `${entity} has no entity name in the data dictionary: it cannot be saved.`,
          ),
        );
      }
      await this.assertSwitches(plan, scratch);
      // The rules may have changed while the targets were read: check the version once more,
      // right before the first write.
      await this.assertPolicyVersion(plan);
    } catch (err) {
      if (ddlResolution) await this.dropCopies(ddlResolution);
      await this.auditExecuteRefusal(lctx, plan, err);
      if (err instanceof Refusal) throw new AppError(err.code, err.message, err.details);
      throw err;
    }

    // ---------------------------------------------------------------- EXECUTE + VERIFY
    let steps: ExecutionStep[];
    try {
      const guard = () => this.stillAllowed(plan);
      steps =
        'sankhya' in resolved
          ? await this.runSankhya(plan, write!, resolved.sankhya, guard)
          : 'action' in resolved
            ? await this.runAction(plan, resolved.action, guard)
            : 'scratchDdl' in resolved
              ? await this.runScratchDdl(resolved.scratchDdl).finally(() =>
                  this.dropCopies(resolved.scratchDdl),
                )
              : await this.runScratch(resolved.scratch);
    } catch (err) {
      // Nothing was sent (the runtime could not be built, for example): a failed execution.
      await this.deps.audit.recordPlanExecuted(lctx, {
        outcome: 'failed',
        affectedRows: 0,
        durationMs: Date.now() - started,
        errorCode: isAppError(err) ? err.code : 'INTERNAL_ERROR',
        errorMessage: err instanceof Error ? err.message : String(err),
        statement: plan.sql,
        policyDecision: policySummary(decision),
        details: { operation, resource: entity },
      });
      throw err;
    }

    if (!scratch) steps = await this.readableValues(auth, plan, entity, steps);

    // ---------------------------------------------------------------- AUDIT
    const report: ExecutionReport = {
      status: statusOf(steps),
      verification: labelOf(steps),
      steps,
    };
    const firstError = steps.find((s) => s.errorCode !== undefined);
    const sent = (o: ExecutionStep['outcome'] | undefined) => o === 'ok' || o === 'unknown';
    const attempted = targets.filter((_, i) => sent(steps[i]?.outcome));
    try {
      await this.deps.audit.recordPlanExecuted(lctx, {
        outcome: report.status,
        affectedRows: steps.filter((s) => s.outcome === 'ok').length,
        durationMs: Date.now() - started,
        errorCode: firstError?.errorCode ?? null,
        errorMessage: firstError
          ? firstError.outcome === 'not_attempted'
            ? `Stopped before step ${steps.indexOf(firstError) + 1}.`
            : `Step ${steps.indexOf(firstError) + 1} failed.`
          : null,
        statement: plan.sql,
        policyDecision: policySummary(decision),
        // The stored report (and so a replay) keeps no row values under auditSnapshots=false,
        // and otherwise only within the snapshot limits.
        details: {
          operation,
          resource: entity,
          report: reportForAudit(report, {
            snapshots: decision.limits.auditSnapshots !== false,
          }),
        },
        before: attempted.flatMap((t) => (t.before ? [t.before] : [])),
        after: attempted.map((t) => t.after),
        auditSnapshots: decision.limits.auditSnapshots,
      });
      await this.deps.audit.recordVerification(lctx, {
        passed: report.verification === 'VERIFIED',
        verification: {
          label: report.verification,
          verified: steps.filter((s) => s.verified === true).length,
          mismatched: steps.filter((s) => s.verified === false).length,
          unverified: steps.filter((s) => s.verified === undefined).length,
        },
      });
    } catch (err) {
      this.deps.logger?.error(
        { planId: plan.id, errorName: err instanceof Error ? err.name : typeof err },
        'The execution could not be audited',
      );
      if (!steps.some((st) => sent(st.outcome))) throw err;
      // Writes were sent: the caller must not read this as "nothing happened" and retry.
      throw new AppError(
        'WRITE_OUTCOME_UNKNOWN',
        'The change was sent, but its audit record could not be written. Check the records ' +
          'before doing anything else; do not repeat the change.',
        { planId: plan.id, status: report.status, verification: report.verification },
      );
    }
    return report;
  }

  /**
   * Checked before every save: the kill switch (and the other write switches) and the policy
   * version. An emergency stop or a rule change halts a run in progress.
   */
  private async stillAllowed(plan: PlanRow): Promise<AppError | null> {
    try {
      await this.assertSwitches(plan, false);
      await this.assertPolicyVersion(plan);
      return null;
    } catch (err) {
      if (isAppError(err)) return new AppError(err.code, err.message, err.details);
      return new AppError('READ_ONLY_MODE', 'The write switches could not be read.');
    }
  }

  /** One save per target, in order, never retried; then the read-back. */
  private async runSankhya(
    plan: PlanRow,
    write: WriteClassified,
    r: SankhyaResolution,
    guard: () => Promise<AppError | null>,
  ): Promise<ExecutionStep[]> {
    const runtime = await this.deps.connections.getRuntime(plan.connectionId);
    const entityName = r.table.entityName!;
    const update = write.kind === 'UPDATE';
    const pk = r.table.columns.filter((c) => c.pk).map((c) => c.name.toUpperCase());
    // Defence in depth (also refused at PREVIEW): a save by an incomplete key could hit any row.
    if (update && !r.targets.every((t) => keyComplete(t.key, pk))) {
      throw new AppError('OPERATION_NOT_SUPPORTED', 'A row to change has no complete primary key.');
    }
    const steps: ExecutionStep[] = r.targets.map((t) => ({
      key: t.key,
      outcome: 'not_attempted',
    }));
    const expected = r.targets.map((t) => {
      const fields = update ? r.setColumns : Object.keys(t.after);
      return Object.fromEntries(fields.map((f) => [f, t.after[f] ?? null]));
    });
    // The key each step is read back by: an INSERT without a complete key gets the one the
    // gateway generated, or stays incomplete (never verified).
    const keys = r.targets.map((t) => t.key);
    for (let i = 0; i < r.targets.length; i++) {
      const t = r.targets[i]!;
      const stop = await guard();
      if (stop) {
        // This step and the rest stay not_attempted; the reason is on the first of them.
        steps[i] = { key: t.key, outcome: 'not_attempted', errorCode: stop.code };
        break;
      }
      const values = Object.fromEntries(Object.entries(expected[i]!).map(([f, v]) => [f, wire(v)]));
      const record = update
        ? {
            pk: Object.fromEntries(Object.entries(t.key).map(([k, v]) => [k, wire(v)])),
            values,
          }
        : { values };
      // INSERT without a complete key: the gateway generates it. The missing key columns are
      // listed without a value, so the saved row comes back with them.
      const generated = update || keyComplete(t.key, pk) ? [] : pk.filter((k) => !(k in values));
      const fields = [...Object.keys(values), ...generated];
      try {
        const res = await runtime.client.save({ entityName, fields, records: [record] });
        if (generated.length > 0) {
          const key = generatedKey(res.results[0], fields, pk, r.table);
          if (key) keys[i] = key;
        }
        steps[i] = { key: keys[i]!, outcome: 'ok' };
      } catch (err) {
        // Anything but a definite gateway answer may have been applied: unknown, never retried.
        const code = isAppError(err) ? err.code : 'WRITE_OUTCOME_UNKNOWN';
        steps[i] = {
          key: t.key,
          outcome: code === 'WRITE_OUTCOME_UNKNOWN' ? 'unknown' : 'error',
          errorCode: code,
        };
        break;
      }
    }

    // VERIFY: the steps that ran (or may have run) are read back by key.
    const check = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.outcome === 'ok' || s.outcome === 'unknown');
    const results = await verifyByKey(runtime.client, {
      entityName,
      pk,
      targets: check.map(({ i }) => ({ key: keys[i]!, expected: expected[i]! })),
    });
    check.forEach(({ i }, n) => {
      steps[i] = readBack(steps[i]!, results[n]);
    });
    // Every step carries what the plan meant to write and the row before it (null for an
    // INSERT); `observed` only ever comes from the read-back above.
    return steps.map((st, i) => ({
      ...st,
      before: update ? pick(r.targets[i]!.before, expected[i]!) : null,
      expected: expected[i]!,
    }));
  }

  /**
   * One business action call, never retried, guarded like a save; then the row is read back by
   * key and compared with the action's expected effect.
   */
  private async runAction(
    plan: PlanRow,
    a: ActionResolution,
    guard: () => Promise<AppError | null>,
  ): Promise<ExecutionStep[]> {
    const runtime = await this.deps.connections.getRuntime(plan.connectionId);
    const t = a.targets[0]!;
    const expected = Object.fromEntries(
      Object.entries(a.action.effect(a.input)).map(([c, v]) => [c.toUpperCase(), v]),
    );
    const values = { before: pick(t.before, expected), expected };
    const stop = await guard();
    if (stop) return [{ key: t.key, outcome: 'not_attempted', errorCode: stop.code, ...values }];
    let step: ExecutionStep;
    try {
      await runtime.client.call(
        {
          module: a.action.module,
          serviceName: a.action.id,
          requestBody: a.action.requestBody(a.input),
        },
        { idempotent: false },
      );
      step = { key: t.key, outcome: 'ok' };
    } catch (err) {
      // Anything but a definite gateway answer may have been applied: unknown, never retried.
      const code = isAppError(err) ? err.code : 'WRITE_OUTCOME_UNKNOWN';
      step = {
        key: t.key,
        outcome: code === 'WRITE_OUTCOME_UNKNOWN' ? 'unknown' : 'error',
        errorCode: code,
      };
    }
    if (step.outcome === 'error') return [{ ...step, ...values }];
    const pk = a.table.columns.filter((c) => c.pk).map((c) => c.name.toUpperCase());
    const [result] = await verifyByKey(runtime.client, {
      entityName: a.table.entityName!,
      pk,
      targets: [{ key: t.key, expected }],
    });
    return [{ ...readBack(step, result), ...values }];
  }

  /**
   * Runs the statement for real in the caller's workspace (one transaction, so it either applies
   * entirely or not at all), then reads the table back and compares it with the dry-run result
   * taken at execute time.
   */
  /** Runs the scratch DDL for real, then reads the table's structure back (VERIFIED on a match). */
  private async runScratchDdl(d: ScratchDdlResolution): Promise<ExecutionStep[]> {
    const key = d.targets[0]!.key;
    try {
      await d.workspace.execStatement(d.stmt);
    } catch (err) {
      return [{ key, outcome: 'error', errorCode: isAppError(err) ? err.code : 'INTERNAL_ERROR' }];
    }
    try {
      const now = (await d.workspace.describe()).find((t) => t.name === d.dry.table) ?? null;
      return [{ key, outcome: 'ok', verified: sameStructure(now, d.dry.after) }];
    } catch {
      return [{ key, outcome: 'ok' }];
    }
  }

  private async runScratch(s: ScratchResolution): Promise<ExecutionStep[]> {
    const steps: ExecutionStep[] = s.targets.map((t) => ({ key: t.key, outcome: 'ok' }));
    try {
      await s.workspace.execStatement(s.stmt, undefined, { maxWriteRows: s.dry.rowCount });
    } catch (err) {
      const errorCode = isAppError(err) ? err.code : 'INTERNAL_ERROR';
      return s.targets.map((t) => ({ key: t.key, outcome: 'error', errorCode }));
    }
    let verified: boolean | undefined;
    try {
      const read = await s.workspace.execStatement(
        analyzeScratchSql(`SELECT * FROM ${s.dry.table}`),
        undefined,
        { maxResultRows: s.dry.after.rows.length + 1 },
      );
      verified = read.truncated ? undefined : sameRows(read, s.dry.after);
    } catch {
      verified = undefined;
    }
    return verified === undefined ? steps : steps.map((st) => ({ ...st, verified }));
  }

  /**
   * The row values a caller may see in the report: only the written columns the current policy
   * still lets them read (QUERY.SELECT, checked per column right after the read-back). A column
   * that is not readable, or any failure of the check, leaves its values out (fail closed). The
   * verification label is not affected: it comes from the full server-side comparison.
   */
  private async readableValues(
    auth: AuthState,
    plan: PlanRow,
    entity: string,
    steps: ExecutionStep[],
  ): Promise<ExecutionStep[]> {
    const fields = ['before', 'expected', 'observed'] as const;
    const columns = [
      ...new Set(steps.flatMap((st) => fields.flatMap((f) => Object.keys(st[f] ?? {})))),
    ];
    if (columns.length === 0) return steps;
    const readable = new Set<string>();
    try {
      const fresh: AuthState = { ...auth, grants: await this.deps.authz.grants(auth.user.id) };
      const groupIds = await this.deps.authz.activeGroupIds(auth.user.id);
      for (const name of columns) {
        const read = await evaluateFor({
          policies: this.deps.policies,
          auth: fresh,
          groupIds,
          action: 'QUERY.SELECT',
          environment: plan.environment,
          connectionId: plan.connectionId,
          entities: [entity],
          columns: [{ table: entity, name }],
          defaults: { maxReadRows: this.deps.maxReadRows },
        });
        if (read.effect === 'ALLOW') readable.add(name);
      }
    } catch {
      readable.clear();
    }
    return steps.map((st) => {
      const { before, expected, observed, ...rest } = st;
      const out: ExecutionStep = rest;
      if (before === null) out.before = null;
      for (const [f, v] of [
        ['before', before],
        ['expected', expected],
        ['observed', observed],
      ] as const) {
        if (!v) continue;
        const kept = Object.entries(v).filter(([c]) => readable.has(c));
        if (kept.length > 0) out[f] = Object.fromEntries(kept);
      }
      return out;
    });
  }

  /** The stored report of the original execution; never executes. */
  private async replay(plan: PlanRow): Promise<ExecutionReport> {
    const { audit } = this.deps;
    const [executed] = (
      await audit.list({ action: 'PLAN_EXECUTED', planId: plan.id, limit: 1, offset: 0 })
    ).items;
    const report = (executed?.details as Record<string, unknown> | null | undefined)?.report;
    if (isReport(report)) return report;
    const [denied] = (
      await audit.list({ action: 'PLAN_DENIED', planId: plan.id, limit: 1, offset: 0 })
    ).items;
    const code = executed?.errorCode ?? denied?.errorCode;
    if (code) {
      throw new AppError(
        code as ErrorCode,
        executed?.errorMessage ?? denied?.errorMessage ?? 'The execution was refused.',
      );
    }
    throw new AppError(
      'CONFLICT',
      'This plan is being executed, or its result is not available; check the audit log.',
    );
  }

  /** CONFIRMATION_INVALID unless the current rule set is the one the plan was built with. */
  private async assertPolicyVersion(plan: PlanRow): Promise<void> {
    let version: string;
    try {
      version = (await this.deps.policies.load()).version;
    } catch {
      throw refuse(
        'RE-AUTHORIZE',
        new AppError('FORBIDDEN', 'The policy rules could not be loaded; nothing was executed.'),
      );
    }
    if (version !== plan.policyVersion) {
      throw refuse(
        'RE-AUTHORIZE',
        invalidPlan('The policy rules changed after the preview; preview the change again.'),
        { planPolicyVersion: plan.policyVersion, policyVersion: version },
      );
    }
  }

  /** GLOBAL_WRITE_ENABLED, then WRITE_TO_SANKHYA (Sankhya), then SAFE_MODE (PRODUCTION). */
  private async assertSwitches(plan: PlanRow, scratch: boolean): Promise<void> {
    const off = (name: string) =>
      refuse(
        'EXECUTE',
        new AppError('READ_ONLY_MODE', `Writes are disabled (${name}).`, { switch: name }),
      );
    if (!(await this.deps.security.globalWriteState()).effective) throw off('GLOBAL_WRITE_ENABLED');
    if (scratch) return;
    if (!this.deps.switches.writeToSankhya) throw off('WRITE_TO_SANKHYA');
    if (plan.environment === 'PRODUCTION' && this.deps.switches.safeMode) throw off('SAFE_MODE');
  }

  /** The consume refused the request: `write.denied` with stage CONFIRM. */
  private async auditConfirmRefusal(ctx: ExecuteContext, err: unknown): Promise<void> {
    const code = isAppError(err) ? err.code : 'INTERNAL_ERROR';
    await this.deps.audit.record({
      userId: ctx.auth.user.id,
      userEmail: ctx.auth.user.email,
      ip: ctx.meta?.ip ?? null,
      requestId: ctx.meta?.requestId ?? null,
      action: isAppError(err) ? 'write.denied' : 'write.execute_failed',
      status: isAppError(err) ? 'denied' : 'failed',
      planId: typeof ctx.planId === 'string' && UUID_RE.test(ctx.planId) ? ctx.planId : null,
      errorCode: code,
      errorMessage: err instanceof Error ? err.message : String(err),
      details: { stage: 'CONFIRM' },
    });
  }

  /** A refusal after the consume: PLAN_DENIED (the plan is used up). */
  private async auditExecuteRefusal(
    lctx: AuditLifecycleContext,
    plan: PlanRow,
    err: unknown,
  ): Promise<void> {
    if (!isAppError(err)) {
      await this.deps.audit.recordPlanExecuted(lctx, {
        outcome: 'failed',
        affectedRows: 0,
        errorCode: 'INTERNAL_ERROR',
        errorMessage: err instanceof Error ? err.message : String(err),
        statement: plan.sql,
      });
      return;
    }
    await this.deps.audit.recordPlanDenied(lctx, {
      errorCode: err.code,
      errorMessage: err.message,
      statement: plan.sql,
      details: {
        stage: err instanceof Refusal ? err.stage : 'RE-AUTHORIZE',
        ...(err.details ?? {}),
        ...(err instanceof Refusal ? err.internal : {}),
      },
    });
  }

  private async auditRefusal(
    ctx: PrepareContext,
    classified: Classified | undefined,
    environment: Environment | null,
    err: unknown,
  ): Promise<void> {
    const code = isAppError(err) ? err.code : 'INTERNAL_ERROR';
    const denied =
      err instanceof Refusal ||
      ['FORBIDDEN', 'SQL_FORBIDDEN', 'SQL_UNSUPPORTED', 'SQL_PARSE_ERROR'].includes(code);
    const write =
      classified && classified.kind !== 'UNKNOWN' && classified.kind !== 'SELECT'
        ? classified
        : undefined;
    await this.deps.audit.record({
      userId: ctx.auth.user.id,
      userEmail: ctx.auth.user.email,
      ip: ctx.meta?.ip ?? null,
      requestId: ctx.meta?.requestId ?? null,
      action: denied ? 'write.denied' : 'write.preview_failed',
      status: denied ? 'denied' : 'failed',
      operation: write?.kind ?? null,
      resource: write?.table ?? null,
      statement: ctx.sql,
      connectionId: ctx.connectionId,
      environment,
      errorCode: code,
      errorMessage: err instanceof Error ? err.message : String(err),
      details: {
        connectionId: ctx.connectionId,
        stage: err instanceof Refusal ? err.stage : 'PREVIEW',
        preview: true,
        ...(err instanceof Refusal ? err.internal : {}),
      },
    });
  }
}

/** Whether a plan (its route and statement) belongs to the route it was sent to. */
function routeMatches(
  plan: { route: unknown; sql: string },
  actionId: string | undefined,
): boolean {
  if (plan.route !== 'SANKHYA_ACTION') return actionId === undefined;
  return actionId !== undefined && parseActionStatement(plan.sql)?.action.id === actionId;
}

/**
 * The action and input of a business action plan, or undefined for a SQL plan. A plan marked as
 * an action whose statement no longer parses to a registered action is refused.
 */
function actionPlanOf(
  plan: PlanRow,
): { action: BusinessAction; input: Record<string, unknown> } | undefined {
  const route = (plan.capability as { route?: unknown } | null)?.route;
  if (route !== 'SANKHYA_ACTION') return undefined;
  const parsed = parseActionStatement(plan.sql);
  if (!parsed) throw refuse('RE-AUTHORIZE', invalidPlan('The plan no longer matches its action.'));
  return parsed;
}

/** A CREATE / ALTER / DROP TABLE of a tmp_ table, or null. */
function scratchDdlOf(c: Classified): DdlClassified | null {
  return (c.kind === 'CREATE_TABLE' || c.kind === 'ALTER_TABLE' || c.kind === 'DROP_TABLE') &&
    SCRATCH_TABLE.test(c.table)
    ? c
    : null;
}

/** A structure as plan values: compared by `targetsHash` at execute and kept by the audit. */
function structureValues(s: TableStructure): RecordValues {
  return { COLUMNS: s.columns.map((c) => `${c.name} ${c.type}`).join(', '), ROWS: s.rows };
}

function structureTarget(dry: DdlDryRunResult): PreviewTarget {
  return {
    key: { TABLE: dry.table },
    before: dry.before ? structureValues(dry.before) : null,
    after: dry.after ? structureValues(dry.after) : {},
  };
}

function sameStructure(a: TableStructure | null, b: TableStructure | null): boolean {
  if (a === null || b === null) return a === b;
  return a.rows === b.rows && JSON.stringify(a.columns) === JSON.stringify(b.columns);
}

/** PARSE: AST classification only; anything the parser cannot positively identify is refused. */
function parseWrite(classified: Classified): WriteClassified {
  if (classified.kind === 'UNKNOWN') {
    throw refuse(
      'PARSE',
      new AppError('SQL_PARSE_ERROR', 'The statement could not be recognised.'),
      { reason: classified.reason },
    );
  }
  if (
    classified.kind !== 'INSERT' &&
    classified.kind !== 'UPDATE' &&
    classified.kind !== 'DELETE'
  ) {
    throw refuse(
      'PARSE',
      new AppError('SQL_UNSUPPORTED', 'Only INSERT, UPDATE and DELETE can be previewed.'),
    );
  }
  return classified;
}

const whereRequired = (kind: string) =>
  new AppError('WHERE_REQUIRED', `${kind} without WHERE affects every row and is blocked.`);

/**
 * VALIDATE: DELETE and scratch writes always need a WHERE; a Sankhya UPDATE without one goes on
 * to the policy override check. A WHERE that does not restrict rows is always refused.
 */
function validateWrite(write: WriteClassified): void {
  if (
    write.kind !== 'INSERT' &&
    !write.hasWhere &&
    (write.kind === 'DELETE' || SCRATCH_TABLE.test(write.table))
  ) {
    throw refuse('VALIDATE', whereRequired(write.kind));
  }
  if (write.kind !== 'INSERT' && write.stmt && 'where' in write.stmt && write.stmt.where) {
    if (isTrivialWhere(write.stmt.where)) {
      throw refuse(
        'VALIDATE',
        new AppError(
          'WHERE_REQUIRED',
          `${write.kind} with a condition that does not restrict rows is blocked.`,
        ),
      );
    }
  }
}

/** The engine applied a WHERE override: ALLOW with the forced phrase and four-eyes approval. */
function overrideApplies(d: PolicyDecision): boolean {
  return (
    d.effect === 'ALLOW' &&
    d.limits.requireWhere === false &&
    d.limits.requireStrongConfirmation === true &&
    d.limits.requireApproval === true
  );
}

/** Values as the gateway expects them: text, null stays null. */
function wire(v: Value | undefined): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 'S' : 'N';
  return String(v);
}

/** Key-order independent JSON, for comparing values that went through jsonb. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Whether two table reads hold the same rows (as a multiset, column order ignored). */
function sameRows(
  a: { columns: string[]; rows: unknown[][] },
  b: { columns: string[]; rows: unknown[][] },
): boolean {
  const sigs = (t: { columns: string[]; rows: unknown[][] }) =>
    t.rows
      .map((row) => {
        const r: Record<string, unknown> = {};
        t.columns.forEach((c, i) => (r[c] = SCALAR(row[i])));
        return canonical(r);
      })
      .sort();
  const x = sigs(a);
  const y = sigs(b);
  return x.length === y.length && x.every((s, i) => s === y[i]);
}

/** A step with its read-back: `verified` and `observed` only when the row was actually read. */
function readBack(step: ExecutionStep, result: VerifyResult | undefined): ExecutionStep {
  return {
    ...step,
    ...(result?.verified !== undefined ? { verified: result.verified } : {}),
    ...(result?.observed !== undefined ? { observed: result.observed } : {}),
  };
}

/** `row` restricted to the keys of `fields` (missing ones are null); null without a row. */
function pick(
  row: RecordValues | null,
  fields: Record<string, unknown>,
): Record<string, unknown> | null {
  if (!row) return null;
  return Object.fromEntries(Object.keys(fields).map((f) => [f, row[f] ?? null]));
}

function isReport(v: unknown): v is ExecutionReport {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.status === 'string' && typeof r.verification === 'string' && Array.isArray(r.steps)
  );
}

function policySummary(d: PolicyDecision): Record<string, unknown> {
  return {
    effect: d.effect,
    policyVersion: d.policyVersion,
    matchedRuleIds: d.matchedRuleIds,
    limits: d.limits,
  };
}

/**
 * A catalog holding only the written table, with its metadata read for that table alone: a
 * write is never authorized against the whole-dictionary catalog, which the gateway may cut at
 * its row cap. A table the connection does not have leaves it empty; a failed read throws.
 */
async function tableCatalog(
  metadata: Pick<MetadataService, 'table'>,
  connectionId: string,
  name: string,
): Promise<Catalog> {
  const table = await metadata.table(connectionId, name);
  return {
    tables: table ? [table] : [],
    fetchedAt: new Date().toISOString(),
    source: 'dictionary',
  };
}

/**
 * Refuses a Sankhya write to a table TDDINS lists with more than one instance: which of them the
 * change is meant for cannot be guessed, and each may save differently. A per-table choice of
 * instance (configuration) would be read here; there is none yet, so such a table is refused.
 */
function writeInstance(table: CatalogTable): void {
  const names = table.entityNames ?? [];
  if (names.length > 1) {
    const name = table.name.toUpperCase();
    throw refuse(
      'PLAN',
      new AppError(
        'OPERATION_NOT_SUPPORTED',
        `${name} has ${names.length} instances in the data dictionary (${names.join(', ')}); configure the instance to use before changing it.`,
        { instances: names },
      ),
    );
  }
}

function catalogTable(catalog: Catalog, name: string): CatalogTable {
  const t = catalog.tables.find((x) => x.name.toUpperCase() === name.toUpperCase());
  if (!t)
    throw refuse(
      'VALIDATE',
      new AppError('RESOURCE_NOT_FOUND', `Table ${name} is not in the catalog of this connection`),
    );
  return t;
}

function columnOf(name: string, known: Set<string>): string {
  const upper = name.toUpperCase();
  if (!IDENT.test(name) || !known.has(upper)) {
    throw refuse(
      'VALIDATE',
      new AppError('COLUMN_NOT_FOUND', `Unknown column "${name}".`, { column: name }),
    );
  }
  return upper;
}

function checkQualifier(table: string | undefined, qualifiers: Set<string>): void {
  if (table !== undefined && !qualifiers.has(table.toUpperCase())) {
    throw refuse(
      'VALIDATE',
      new AppError('COLUMN_NOT_FOUND', `Unknown table or alias "${table}".`),
    );
  }
}

/** Every column the write names (SET / INSERT columns and WHERE columns), for the policy check. */
function writeColumns(
  stmt: InsertStatement | UpdateStatement,
  table: CatalogTable,
): PolicyColumn[] {
  const entity = table.name.toUpperCase();
  const known = new Set(table.columns.map((c) => c.name.toUpperCase()));
  const names = new Set<string>();
  if (stmt.type === 'insert') {
    for (const c of stmt.columns) names.add(columnOf(c, known));
  } else {
    const qualifiers = new Set([entity]);
    if (stmt.table.alias) qualifiers.add(stmt.table.alias.toUpperCase());
    for (const s of stmt.set) {
      names.add(columnOf(s.column, known));
      collectColumns(s.value, qualifiers, known, names);
    }
    if (stmt.where) collectColumns(stmt.where, qualifiers, known, names);
  }
  return [...names].map((name) => ({ table: entity, name }));
}

function collectColumns(
  e: Expr,
  qualifiers: Set<string>,
  known: Set<string>,
  out: Set<string>,
): void {
  switch (e.kind) {
    case 'literal':
      return;
    case 'column':
      checkQualifier(e.table, qualifiers);
      out.add(columnOf(e.name, known));
      return;
    case 'compare':
    case 'arith':
    case 'and':
    case 'or':
      collectColumns(e.left, qualifiers, known, out);
      collectColumns(e.right, qualifiers, known, out);
      return;
    case 'not':
    case 'neg':
    case 'isNull':
      collectColumns(e.expr, qualifiers, known, out);
      return;
    case 'in':
      collectColumns(e.expr, qualifiers, known, out);
      for (const x of e.list) collectColumns(x, qualifiers, known, out);
      return;
    case 'between':
      collectColumns(e.expr, qualifiers, known, out);
      collectColumns(e.low, qualifiers, known, out);
      collectColumns(e.high, qualifiers, known, out);
      return;
    case 'like':
      collectColumns(e.expr, qualifiers, known, out);
      collectColumns(e.pattern, qualifiers, known, out);
      return;
    case 'aggregate':
      throw refuse(
        'VALIDATE',
        new AppError('OPERATION_NOT_SUPPORTED', 'Aggregates are not allowed in a write.'),
      );
  }
}

function literalSql(v: Value): string {
  if (v === null) return 'NULL';
  if (typeof v === 'number') {
    if (!Number.isFinite(v))
      throw refuse('VALIDATE', new AppError('SQL_UNSUPPORTED', 'Invalid numeric literal.'));
    return String(v);
  }
  if (typeof v === 'string') return `'${v.replace(/'/g, "''")}'`;
  throw refuse(
    'VALIDATE',
    new AppError('SQL_UNSUPPORTED', 'Boolean literals are not supported by the gateway dialects.'),
  );
}

/**
 * Renders the engine AST of a WHERE clause back to SQL for the before-snapshot SELECT. Only the
 * shapes the engine AST holds are rendered; columns are checked against the catalog and emitted
 * unqualified (the snapshot reads one table). The result still goes through the read gate.
 */
export function renderExpr(e: Expr, qualifiers: Set<string>, known: Set<string>): string {
  const r = (x: Expr) => renderExpr(x, qualifiers, known);
  switch (e.kind) {
    case 'literal':
      return literalSql(e.value);
    case 'column':
      checkQualifier(e.table, qualifiers);
      return columnOf(e.name, known);
    case 'compare':
    case 'arith':
      return `(${r(e.left)} ${e.op} ${r(e.right)})`;
    case 'and':
      return `(${r(e.left)} AND ${r(e.right)})`;
    case 'or':
      return `(${r(e.left)} OR ${r(e.right)})`;
    case 'not':
      return `(NOT ${r(e.expr)})`;
    case 'neg':
      // The space keeps a negated negative literal from forming `--`, a line comment.
      return `(- ${r(e.expr)})`;
    case 'in':
      return `(${r(e.expr)}${e.negated ? ' NOT' : ''} IN (${e.list.map(r).join(', ')}))`;
    case 'between':
      return `(${r(e.expr)}${e.negated ? ' NOT' : ''} BETWEEN ${r(e.low)} AND ${r(e.high)})`;
    case 'like':
      return `(${r(e.expr)}${e.negated ? ' NOT' : ''} LIKE ${r(e.pattern)}${
        e.escape !== undefined ? ` ESCAPE ${literalSql(e.escape)}` : ''
      })`;
    case 'isNull':
      return `(${r(e.expr)} IS${e.negated ? ' NOT' : ''} NULL)`;
    case 'aggregate':
      throw refuse(
        'VALIDATE',
        new AppError('OPERATION_NOT_SUPPORTED', 'Aggregates are not allowed in a write.'),
      );
  }
}

const notSimulable = () =>
  refuse(
    'PREVIEW',
    new AppError(
      'OPERATION_NOT_SUPPORTED',
      'The new value cannot be simulated: use literals, columns and + - * /.',
    ),
  );

const NUMERIC = /^-?\d+(\.\d+)?$/;

/** A number, or a decimal string as gateways return NUMBER columns; anything else is refused. */
function numeric(v: Value): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && NUMERIC.test(v.trim())) return Number(v);
  throw notSimulable();
}

/** Simulated after value of a SET expression for one before row. */
function simulate(e: Expr, row: RecordValues | null, qualifiers: Set<string>): Value {
  switch (e.kind) {
    case 'literal':
      return e.value;
    case 'column':
      // INSERT values have no row to read from.
      if (row === null) throw notSimulable();
      checkQualifier(e.table, qualifiers);
      return row[e.name.toUpperCase()] ?? null;
    case 'neg': {
      const v = simulate(e.expr, row, qualifiers);
      return v === null ? null : -numeric(v);
    }
    case 'arith': {
      const a = simulate(e.left, row, qualifiers);
      const b = simulate(e.right, row, qualifiers);
      if (a === null || b === null) return null;
      const [x, y] = [numeric(a), numeric(b)];
      if (e.op === '+') return x + y;
      if (e.op === '-') return x - y;
      if (e.op === '*') return x * y;
      return y === 0 ? null : x / y;
    }
    default:
      throw notSimulable();
  }
}

function insertTarget(stmt: InsertStatement, table: CatalogTable): PreviewTarget {
  const known = new Set(table.columns.map((c) => c.name.toUpperCase()));
  if (stmt.columns.length === 0 || stmt.columns.length !== stmt.values.length) {
    throw refuse(
      'VALIDATE',
      new AppError('OPERATION_NOT_SUPPORTED', 'INSERT must list its columns and one value each.'),
    );
  }
  const after: RecordValues = {};
  stmt.columns.forEach((c, i) => {
    after[columnOf(c, known)] = simulate(stmt.values[i]!, null, new Set());
  });
  const key: RecordValues = {};
  for (const c of table.columns) {
    const name = c.name.toUpperCase();
    if (c.pk && name in after) key[name] = after[name] ?? null;
  }
  return { key, before: null, after };
}

/**
 * The primary key of a row the gateway created, from the save result (aligned with `fields`).
 * Undefined unless every key column came back with a value: a guessed key is never verified.
 */
function generatedKey(
  row: unknown[] | undefined,
  fields: string[],
  pk: string[],
  table: CatalogTable,
): RecordValues | undefined {
  if (!Array.isArray(row) || pk.length === 0) return undefined;
  const key: RecordValues = {};
  for (const k of pk) {
    const i = fields.indexOf(k);
    let v: unknown = i === -1 ? undefined : row[i];
    // Some gateways wrap values as {"$": "..."}.
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && '$' in v) {
      v = (v as { $: unknown }).$;
    }
    if (typeof v !== 'string' && typeof v !== 'number') return undefined;
    const text = String(v).trim();
    if (text === '') return undefined;
    const type = table.columns.find((c) => c.name.toUpperCase() === k)?.type;
    key[k] = (type === 'integer' || type === 'decimal') && NUMERIC.test(text) ? Number(text) : text;
  }
  return key;
}

/** Gateway values to JSON-safe scalars. */
function toValue(v: unknown): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

const SCALAR = (v: unknown): Value => toValue(v);

/**
 * Per-row before/after from the two table snapshots of a dry run. A scratch table has no known
 * key, so rows are matched as whole values: rows only in `before` were changed or removed, rows
 * only in `after` were changed or added. Changed rows are paired in scan order.
 */
function diffSnapshots(
  kind: WriteClassified['kind'],
  before: { columns: string[]; rows: unknown[][] },
  after: { columns: string[]; rows: unknown[][] },
): PreviewTarget[] {
  const toRecord = (columns: string[], row: unknown[]): RecordValues => {
    const r: RecordValues = {};
    columns.forEach((c, i) => (r[c] = SCALAR(row[i])));
    return r;
  };
  const sig = (r: RecordValues) => JSON.stringify(r);
  const b = before.rows.map((r) => toRecord(before.columns, r));
  const a = after.rows.map((r) => toRecord(after.columns, r));
  const only = (xs: RecordValues[], ys: RecordValues[]): RecordValues[] => {
    const left = new Map<string, number>();
    for (const y of ys) left.set(sig(y), (left.get(sig(y)) ?? 0) + 1);
    return xs.filter((x) => {
      const n = left.get(sig(x)) ?? 0;
      if (n > 0) left.set(sig(x), n - 1);
      return n === 0;
    });
  };
  const removed = only(b, a);
  const added = only(a, b);
  if (kind === 'INSERT') return added.map((r) => ({ key: {}, before: null, after: r }));
  if (kind === 'DELETE') return removed.map((r) => ({ key: {}, before: r, after: {} }));
  return removed.map((r, i) => ({ key: {}, before: r, after: added[i] ?? {} }));
}
