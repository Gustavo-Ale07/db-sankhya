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
 * - EXECUTE sends one save per target, in order, never retried. A definite failure stops the run
 *   (the rest is `not_attempted`); a timeout is `unknown` (WRITE_OUTCOME_UNKNOWN).
 * - VERIFY reads every target back by key and labels the run VERIFIED, PARTIALLY_VERIFIED,
 *   UNVERIFIED or FAILED (see `verification.ts`).
 * - AUDIT records PLAN_EXECUTED (with the report, for replays) and VERIFICATION; every refusal
 *   after the consume is a PLAN_DENIED, every refusal of the consume a `write.denied`.
 */
import { AppError, isAppError } from '@dbx/shared';
import type { Environment, ErrorCode, Permission, PolicyColumn, PolicyDecision } from '@dbx/shared';
import { classifyStatement, resolveCapability } from '@dbx/sql-engine';
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
import type { DryRunResult, ScratchManager, ScratchWorkspace } from './scratch';
import { analyzeScratchSql } from './scratch-guard';
import type { ScratchStatement } from './scratch-guard';
import type { AuditLifecycleContext, AuditService } from './records';
import type { SecuritySettingsService } from './security-settings';
import { labelOf, statusOf, verifyByKey } from './verification';
import type { ExecutionReport, ExecutionStep } from './verification';

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
  preview: { targets: PreviewTarget[]; affected: number };
  impact: { entities: string[]; rows: number; environment: Environment };
  requires: { strongConfirmation: string | null; approval: boolean };
}

export interface PrepareContext {
  auth: AuthState;
  connectionId: string;
  sql: string;
  /** Request metadata for the audit trail. */
  meta?: { ip?: string | null; requestId?: string | null };
}

export interface ExecuteContext {
  auth: AuthState;
  planId: string;
  token: string;
  strongConfirmation?: string;
  idempotencyKey?: string;
  meta?: { ip?: string | null; requestId?: string | null };
}

export interface MutationDeps {
  policies: PolicyService;
  authz: Pick<AuthzService, 'activeGroupIds' | 'grants'>;
  connections: ConnectionsService;
  metadata: Pick<MetadataService, 'get'>;
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
}

type WriteClassified = Extract<Classified, { kind: 'INSERT' | 'UPDATE' | 'DELETE' }>;

const PERMISSION: Record<WriteClassified['kind'], Permission> = {
  INSERT: 'DATA.INSERT',
  UPDATE: 'DATA.UPDATE',
  DELETE: 'DATA.DELETE',
};

const SCRATCH_TABLE = /^tmp_/i;
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
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

const invalidPlan = (message: string) => new AppError('CONFIRMATION_INVALID', message);

export class MutationService {
  constructor(private readonly deps: MutationDeps) {}

  async prepare(ctx: PrepareContext): Promise<PreparedMutation> {
    const { auth, sql } = ctx;
    let classified: Classified | undefined;
    let environment: Environment | null = null;
    try {
      classified = classifyStatement(sql);
      const write = parseWrite(classified);

      // ---------------------------------------------------------------- VALIDATE
      validateWrite(write);

      // A write to a scratch table never touches Sankhya: it gets a transactional dry run.
      if (SCRATCH_TABLE.test(write.table)) {
        environment = SCRATCH_ENVIRONMENT;
        const s = await this.resolveScratch(auth, write, sql);
        return await this.finishPlan(ctx, {
          write,
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

      const r = await this.resolveSankhya(auth, ctx.connectionId, write, 'prepare', (e) => {
        environment = e;
      });
      return await this.finishPlan(ctx, {
        write,
        permission: r.permission,
        environment: r.environment,
        connectionId: ctx.connectionId,
        capability: r.capability,
        decision: r.decision,
        targets: r.targets,
        entity: r.table.name.toUpperCase(),
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
   */
  private async resolveSankhya(
    auth: AuthState,
    connectionId: string,
    write: WriteClassified,
    mode: 'prepare' | 'execute',
    onEnvironment?: (environment: Environment) => void,
  ): Promise<SankhyaResolution> {
    const permission = PERMISSION[write.kind];
    // DELETE without WHERE never gets here (VALIDATE); INSERT has no WHERE at all.
    const noWhere = write.kind === 'UPDATE' && !write.hasWhere;
    if (!auth.grants.permissions.has(permission)) {
      throw refuse(
        'AUTHORIZE',
        noWhere && mode === 'prepare'
          ? whereRequired(write.kind)
          : new AppError('FORBIDDEN', 'You do not have permission for this action', { permission }),
      );
    }
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
        auth,
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

    const catalog = await metadata.get(connectionId);
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

    const decision = await evaluateFor({
      policies,
      auth,
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
      write: WriteClassified;
      permission: Permission;
      environment: Environment;
      connectionId: string;
      capability: Capability;
      decision: PolicyDecision;
      targets: PreviewTarget[];
      entity: string;
      previewKind: PreviewKind;
      previewLabels: PreviewKind[];
    },
  ): Promise<PreparedMutation> {
    const { auth, sql } = ctx;
    const { write, permission, environment, capability, decision, targets, entity } = o;
    const { previewKind, previewLabels } = o;
    const affected = targets.length;
    const preview = { targets, affected };
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
      summary: { action: write.kind, count: affected, entity },
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
          ? strongConfirmationPhrase(environment, write.kind, affected, entity)
          : null,
        approval: decision.limits.requireApproval,
      },
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
        details: { operation: write.kind, resource: entity, affected, previewKind, previewLabels },
        before: targets.flatMap((t) => (t.before ? [t.before] : [])),
        after: targets.map((t) => t.after),
      },
    );
    return prepared;
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
      hasWhere: write.hasWhere,
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
      throw refuse(
        'PREVIEW',
        new AppError(
          'WRITE_ROW_LIMIT_EXCEEDED',
          `The change affects more than ${out.maxRows} rows.`,
          { maxWriteRows: out.maxRows },
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
    let write: WriteClassified;
    let resolved: { sankhya: SankhyaResolution } | { scratch: ScratchResolution };
    let decision: PolicyDecision;
    let targets: PreviewTarget[];
    let entity: string;
    try {
      write = parseWrite(classifyStatement(plan.sql));
      lctx.capability = scratch ? 'TEMP.WRITE' : PERMISSION[write.kind];
      validateWrite(write);
      const fresh: AuthState = { ...auth, grants: await this.deps.authz.grants(auth.user.id) };
      await this.assertPolicyVersion(plan);

      if (scratch) {
        if (!SCRATCH_TABLE.test(write.table))
          throw refuse('RE-AUTHORIZE', invalidPlan('The plan no longer matches its statement.'));
        const s = await this.resolveScratch(fresh, write, plan.sql);
        resolved = { scratch: s };
        decision = s.decision;
        targets = s.targets;
        entity = s.entity;
      } else {
        const r = await this.resolveSankhya(fresh, plan.connectionId, write, 'execute');
        if (r.environment !== plan.environment) {
          throw refuse('RE-AUTHORIZE', invalidPlan('The connection changed after the preview.'));
        }
        resolved = { sankhya: r };
        decision = r.decision;
        targets = r.targets;
        entity = r.table.name.toUpperCase();
      }
      const capability =
        'sankhya' in resolved ? resolved.sankhya.capability : resolved.scratch.capability;
      if (canonical(capability) !== canonical(plan.capability)) {
        throw refuse('RE-AUTHORIZE', invalidPlan('The capability changed after the preview.'));
      }
      if (!gatesHold(decision.limits, plan)) {
        throw refuse(
          'RE-AUTHORIZE',
          invalidPlan('The policy now requires more than the preview did; preview it again.'),
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
      await this.auditExecuteRefusal(lctx, plan, err);
      if (err instanceof Refusal) throw new AppError(err.code, err.message, err.details);
      throw err;
    }

    // ---------------------------------------------------------------- EXECUTE + VERIFY
    let steps: ExecutionStep[];
    try {
      steps =
        'sankhya' in resolved
          ? await this.runSankhya(plan, write, resolved.sankhya)
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
        details: { operation: write.kind, resource: entity },
      });
      throw err;
    }

    // ---------------------------------------------------------------- AUDIT
    const report: ExecutionReport = {
      status: statusOf(steps),
      verification: labelOf(steps),
      steps,
    };
    const firstError = steps.find((s) => s.errorCode !== undefined);
    const attempted = targets.filter((_, i) => {
      const o = steps[i]?.outcome;
      return o === 'ok' || o === 'unknown';
    });
    await this.deps.audit.recordPlanExecuted(lctx, {
      outcome: report.status,
      affectedRows: steps.filter((s) => s.outcome === 'ok').length,
      durationMs: Date.now() - started,
      errorCode: firstError?.errorCode ?? null,
      errorMessage: firstError ? `Step ${steps.indexOf(firstError) + 1} failed.` : null,
      statement: plan.sql,
      policyDecision: policySummary(decision),
      details: { operation: write.kind, resource: entity, report },
      before: attempted.flatMap((t) => (t.before ? [t.before] : [])),
      after: attempted.map((t) => t.after),
      auditSnapshots:
        (decision.limits as unknown as Record<string, unknown>).auditSnapshots !== false,
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
    return report;
  }

  /** One save per target, in order, never retried; then the read-back. */
  private async runSankhya(
    plan: PlanRow,
    write: WriteClassified,
    r: SankhyaResolution,
  ): Promise<ExecutionStep[]> {
    const runtime = await this.deps.connections.getRuntime(plan.connectionId);
    const entityName = r.table.entityName!;
    const update = write.kind === 'UPDATE';
    const steps: ExecutionStep[] = r.targets.map((t) => ({
      key: t.key,
      outcome: 'not_attempted',
    }));
    const expected = r.targets.map((t) => {
      const fields = update ? r.setColumns : Object.keys(t.after);
      return Object.fromEntries(fields.map((f) => [f, t.after[f] ?? null]));
    });
    for (let i = 0; i < r.targets.length; i++) {
      const t = r.targets[i]!;
      const values = Object.fromEntries(Object.entries(expected[i]!).map(([f, v]) => [f, wire(v)]));
      const record = update
        ? {
            pk: Object.fromEntries(Object.entries(t.key).map(([k, v]) => [k, wire(v)])),
            values,
          }
        : { values };
      try {
        await runtime.client.save({ entityName, fields: Object.keys(values), records: [record] });
        steps[i] = { key: t.key, outcome: 'ok' };
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
    const pk = r.table.columns.filter((c) => c.pk).map((c) => c.name.toUpperCase());
    const check = steps
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => s.outcome === 'ok' || s.outcome === 'unknown');
    const results = await verifyByKey(runtime.client, {
      entityName,
      pk,
      targets: check.map(({ i }) => ({ key: r.targets[i]!.key, expected: expected[i]! })),
    });
    check.forEach(({ i }, n) => {
      const verified = results[n];
      if (verified !== undefined) steps[i] = { ...steps[i]!, verified };
    });
    return steps;
  }

  /**
   * Runs the statement for real in the caller's workspace (one transaction, so it either applies
   * entirely or not at all), then reads the table back and compares it with the dry-run result
   * taken at execute time.
   */
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

/** True when a column-free (constant) condition, or a column compared with itself, makes the WHERE match every row. */
function hasColumn(e: Expr): boolean {
  switch (e.kind) {
    case 'literal':
      return false;
    case 'column':
      return true;
    case 'compare':
    case 'arith':
    case 'and':
    case 'or':
      return hasColumn(e.left) || hasColumn(e.right);
    case 'not':
    case 'neg':
    case 'isNull':
      return hasColumn(e.expr);
    case 'in':
      return hasColumn(e.expr) || e.list.some(hasColumn);
    case 'between':
      return hasColumn(e.expr) || hasColumn(e.low) || hasColumn(e.high);
    case 'like':
      return hasColumn(e.expr) || hasColumn(e.pattern);
    case 'aggregate':
      return true;
  }
}

function isTrivialWhere(e: Expr): boolean {
  if (!hasColumn(e)) return true;
  if (e.kind === 'and') return isTrivialWhere(e.left) && isTrivialWhere(e.right);
  if (e.kind === 'or') return isTrivialWhere(e.left) || isTrivialWhere(e.right);
  if (
    e.kind === 'compare' &&
    e.op === '=' &&
    e.left.kind === 'column' &&
    e.right.kind === 'column'
  ) {
    return (
      e.left.name.toUpperCase() === e.right.name.toUpperCase() &&
      (e.left.table ?? '').toUpperCase() === (e.right.table ?? '').toUpperCase()
    );
  }
  return false;
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
