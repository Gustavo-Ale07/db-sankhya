/**
 * DDL artifact route: turns a CREATE TABLE of a custom (prefixed) table into Add-on Studio files
 * (AutoDDL and/or dbscript XML) the customer deploys by hand. Nothing is executed and no
 * connection is written to: the catalog is only read to diff against an existing table. The
 * ADMIN role never grants this; it needs DDL.CUSTOM.GENERATE and an explicit policy ALLOW.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError, isAppError } from '@dbx/shared';
import type { Permission, PolicyDecision } from '@dbx/shared';
import {
  MAX_SQL_LENGTH,
  diffTable,
  tableFromCreateSql,
  toAutoDdlXml,
  toDbScriptXml,
  validateTableModel,
} from '@dbx/sql-engine';
import type { DdlChange, DdlSeverity, FieldModel, TableModel } from '@dbx/sql-engine';
import type { AuthState } from '../context';
import {
  clientIp,
  connectionIdSchema,
  hasPermission,
  noStore,
  parseBody,
  requireAuth,
} from '../http';
import { ENV_CONNECTION_ID } from '../services/connections';
import type { Catalog, CatalogColumn, CatalogTable } from '../services/metadata';
import { connectionDenied, evaluateFor } from '../services/read-policy';

const PERMISSION: Permission = 'DDL.CUSTOM.GENERATE';

const body = z
  .object({
    /** A single PostgreSQL-style CREATE TABLE of a custom table. */
    sql: z.string().min(1).max(MAX_SQL_LENGTH),
    /** Connection whose catalog is diffed against; the SANKHYA_* connection when omitted. */
    connectionId: connectionIdSchema.optional(),
    format: z.enum(['autoddl', 'dbscript', 'both']).optional(),
    /** The dbscript version, `n` in `V<n>.xml`. */
    version: z.number().int().min(1).max(999_999).optional(),
    /** Typed confirmation, exactly `DESTRUCTIVE <TABLE>`, for a destructive change. */
    confirm: z.string().max(100).optional(),
  })
  .strict();

type Artifact = {
  kind: 'autoddl' | 'dbscript';
  filename: string;
  contentType: string;
  content: string;
};

const XML_TYPE = 'application/xml; charset=utf-8';

const STRING_TYPES = new Set(['TEXTO', 'CAIXA_TEXTO', 'CHECKBOX', 'ARQUIVO']);

/**
 * The dictionary exposes names, a coarse type and the primary key only: no sizes, nullability or
 * defaults. Those are taken from the desired field of the same name (so they never show as a
 * change) and the response says so. A column without a counterpart gets a minimal placeholder
 * size; it can only be dropped or renamed, and any such change is DESTRUCTIVE anyway.
 */
function currentModel(table: CatalogTable, desired: TableModel): TableModel {
  const byName = new Map(desired.fields.map((f) => [f.name, f]));
  const fields = table.columns.map((c: CatalogColumn): FieldModel => {
    const d = byName.get(c.name.toUpperCase());
    const dataType = ((): FieldModel['dataType'] => {
      switch (c.type) {
        case 'integer':
          return 'INTEIRO';
        case 'decimal':
          return 'DECIMAL';
        case 'date':
          return 'DATA';
        case 'datetime':
          return d?.dataType === 'HORA' ? 'HORA' : 'DATA_HORA';
        default:
          return d && STRING_TYPES.has(d.dataType) ? d.dataType : 'TEXTO';
      }
    })();
    const same = d?.dataType === dataType;
    const f: FieldModel = {
      name: c.name.toUpperCase(),
      dataType,
      required: c.pk || (same && d.required),
    };
    if (dataType === 'TEXTO') f.size = same && d.size !== undefined ? d.size : 1;
    if (dataType === 'DECIMAL') {
      f.size = same && d.size !== undefined ? d.size : 1;
      f.scale = same && d.scale !== undefined ? d.scale : 0;
    }
    if (dataType === 'INTEIRO' && same && d.size !== undefined) f.size = d.size;
    if (same && d.default !== undefined) f.default = d.default;
    if (d?.description !== undefined) f.description = d.description;
    return f;
  });
  return {
    name: table.name.toUpperCase(),
    primaryKey: table.columns.filter((c) => c.pk).map((c) => c.name.toUpperCase()),
    fields,
  };
}

function existingTable(catalog: Catalog, name: string): CatalogTable | undefined {
  const degraded = catalog.degraded ?? [];
  const found = catalog.tables.find((t) => t.name.toUpperCase() === name);
  // The table list cut short or failed: absence proves nothing. Columns or keys missing: the
  // current model would be wrong. Either way a diff would mislead, so refuse (fail closed).
  const listBroken = degraded.some((d) => d.startsWith('TDDTAB:'));
  const detailBroken = degraded.some((d) => d.startsWith('TDDCAM:') || d.startsWith('PK:'));
  if (listBroken || (found && detailBroken)) {
    throw new AppError(
      'SQL_UNSUPPORTED',
      'The data dictionary could not be read completely, so the current table cannot be compared. Try again later.',
    );
  }
  return found;
}

export async function ddlRoutes(app: FastifyInstance): Promise<void> {
  const { audit, connections, metadata, policies, authz, config } = app.services;

  const recordDenial = (
    request: FastifyRequest,
    auth: AuthState,
    d: {
      resource: string | null;
      statement: string;
      err: AppError;
      details?: Record<string, unknown>;
    },
  ) =>
    audit.record({
      userId: auth.user.id,
      userEmail: auth.user.email,
      ip: clientIp(request),
      requestId: request.id,
      action: 'ddl.denied',
      status: 'denied',
      operation: PERMISSION,
      resource: d.resource,
      statement: d.statement,
      errorCode: d.err.code,
      errorMessage: d.err.message,
      ...(d.details ? { details: d.details } : {}),
    });

  const policyDetails = (decision: PolicyDecision) => ({
    reasons: decision.reasons,
    matchedRuleIds: decision.matchedRuleIds,
    policyVersion: decision.policyVersion,
  });

  app.post(
    '/api/ddl/artifact',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      noStore(reply);
      const auth = requireAuth(request);
      const input = parseBody(body, request.body);
      let resource: string | null = null;
      const denied = async (err: AppError, details?: Record<string, unknown>) => {
        await recordDenial(request, auth, {
          resource,
          statement: input.sql,
          err,
          ...(details ? { details } : {}),
        });
        return err;
      };

      if (!hasPermission(auth, PERMISSION)) {
        throw await denied(
          new AppError('FORBIDDEN', 'You do not have permission for this action', {
            permission: PERMISSION,
          }),
        );
      }

      const prefixes = config.customTablePrefixes;
      try {
        // Unparseable, multi-statement, non-CREATE and native-table input all fail here.
        const desired = tableFromCreateSql(input.sql, { customPrefixes: prefixes });
        resource = desired.name;

        const connectionId =
          input.connectionId ??
          (config.sankhya.envConnection
            ? ENV_CONNECTION_ID
            : (() => {
                throw new AppError(
                  'VALIDATION_ERROR',
                  'connectionId is required: no default Sankhya connection is configured',
                );
              })());
        let environment;
        try {
          environment = (await connections.get(connectionId)).environment;
        } catch (err) {
          if (isAppError(err) && err.code === 'NOT_FOUND') throw connectionDenied();
          throw err;
        }
        // DDL is default-deny: only an explicit ALLOW rule matching the table lets it through.
        const decision = await evaluateFor({
          policies,
          auth,
          groupIds: await authz.activeGroupIds(auth.user.id),
          action: PERMISSION,
          environment,
          connectionId,
          entities: [desired.name],
          columns: [],
        });
        if (decision.effect !== 'ALLOW') {
          throw new AppError('FORBIDDEN', 'The statement was denied by policy', {
            ...policyDetails(decision),
          });
        }

        const table = existingTable(await metadata.get(connectionId), desired.name);
        const current = table
          ? validateTableModel(currentModel(table, desired), { customPrefixes: prefixes })
          : null;
        const { changes, severity } = diffTable(current, desired);

        if (severity === 'DESTRUCTIVE') {
          const expected = `DESTRUCTIVE ${desired.name}`;
          if (input.confirm === undefined) {
            throw new AppError(
              'CONFIRMATION_REQUIRED',
              `This change is destructive. Send confirm: "${expected}" to generate it.`,
              {
                confirmation: expected,
                changes: changes.filter((c) => c.severity === 'DESTRUCTIVE'),
              },
            );
          }
          if (input.confirm !== expected) {
            throw new AppError('CONFIRMATION_INVALID', 'The typed confirmation does not match.');
          }
        }

        const format = input.format ?? 'both';
        const version = input.version ?? 1;
        const artifacts: Artifact[] = [];
        if (format !== 'dbscript') {
          artifacts.push({
            kind: 'autoddl',
            filename: `${desired.name}.xml`,
            contentType: XML_TYPE,
            content: toAutoDdlXml(desired, { customPrefixes: prefixes }),
          });
        }
        if (format !== 'autoddl') {
          const script = toDbScriptXml(current, desired, { customPrefixes: prefixes, version });
          artifacts.push({
            kind: 'dbscript',
            filename: `V${version}.xml`,
            contentType: XML_TYPE,
            content: script.xml,
          });
        }

        await audit.record({
          userId: auth.user.id,
          userEmail: auth.user.email,
          ip: clientIp(request),
          requestId: request.id,
          action: 'ddl.generate',
          status: 'success',
          operation: PERMISSION,
          resource: desired.name,
          statement: input.sql,
          details: {
            connectionId,
            format,
            version,
            severity,
            changes: changes.map((c) => c.kind),
            existing: current !== null,
          },
        });
        const warnings = current
          ? [
              'The data dictionary exposes no sizes, nullability or defaults of the current table: ' +
                'they are assumed unchanged. Review the changes before deploying.',
            ]
          : [];
        return { table: desired.name, severity, changes, warnings, artifacts } satisfies {
          table: string;
          severity: DdlSeverity;
          changes: DdlChange[];
          warnings: string[];
          artifacts: Artifact[];
        };
      } catch (err) {
        if (isAppError(err) && err.code !== 'CONFIRMATION_REQUIRED') {
          const { reasons, matchedRuleIds, policyVersion } = (err.details ?? {}) as Record<
            string,
            unknown
          >;
          // Policy internals go to the audit trail only, never to the caller.
          await denied(err, { reasons, matchedRuleIds, policyVersion });
          if (err.code === 'FORBIDDEN' && err.details) {
            throw new AppError('FORBIDDEN', err.message);
          }
        }
        throw err;
      }
    },
  );
}
