import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { isPreparedPlan } from '../api/mutations';
import type { PreparedPlan } from '../api/mutations';
import type { AuditEvent, ConnectionOption } from '../api/types';
import { ENVIRONMENT_LABEL } from '../components/EnvironmentBanner';
import { ErrorBox } from '../components/ErrorBox';

/** The audit row as the server sends it: the lifecycle columns the base type leaves out. */
export interface RollbackEvent extends AuditEvent {
  connectionId?: string | null;
  planId?: string | null;
  environment?: string | null;
  snapshot?: unknown;
}

export interface RollbackConflict {
  detected: boolean;
  columns: Array<{ column: string; expected: unknown; current: unknown }>;
  message: string | null;
}

/**
 * POST /api/audit/:id/rollback-plan. `sql` is the first statement and `plan` the plan the server
 * prepared for it (linked to the source event by its `rollback.planned` audit row). The plan's
 * token lives only in memory.
 */
export interface RollbackPlan {
  type: 'rollback-plan';
  label: string;
  sourceEventId: string;
  sql: string;
  displaySql: string;
  statements: number;
  conflict: RollbackConflict;
  plan: PreparedPlan;
}

/** Opens the server-prepared plan in the mutation dialog, on `connectionId` exactly. */
export type OpenRollback = (
  req: { plan: PreparedPlan; sql: string; title: string },
  connectionId: string,
) => void;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Whether the event can back a rollback: a successful, VERIFIED UPDATE on a real connection with
 * a stored snapshot. The server decides for good (it also refuses redacted or clipped values);
 * this only hides the action where it can never apply.
 */
export function isRollbackEligible(e: RollbackEvent): boolean {
  if (e.action !== 'PLAN_EXECUTED' || e.status !== 'success') return false;
  if (!e.connectionId || e.connectionId === 'scratch') return false;
  if (!isRecord(e.details) || e.details.operation !== 'UPDATE') return false;
  if (e.details.snapshotsDisabled === true) return false;
  const report = e.details.report;
  if (!isRecord(report) || report.verification !== 'VERIFIED') return false;
  return isRecord(e.snapshot);
}

const show = (v: unknown) =>
  v === null || v === undefined ? 'NULL' : typeof v === 'string' ? v : JSON.stringify(v);

/**
 * "Gerar plano de rollback": asks the server for a new plan and opens that very plan in the
 * mutation dialog (no second preview, so execute consumes the plan the audit trail links to), on
 * the event's own connection only. `connections` is the caller's connection list: when the
 * event's connection is not in it, the plan is never handed over (no fallback to another one).
 */
export function RollbackPlanAction({
  event,
  onOpen,
  connections,
}: {
  event: RollbackEvent;
  onOpen: OpenRollback;
  connections?: readonly ConnectionOption[];
}) {
  const plan = useMutation({
    mutationFn: () => api.post<RollbackPlan>(`/api/audit/${event.id}/rollback-plan`),
  });
  if (!isRollbackEligible(event)) return null;
  const data = plan.data;
  const target = connections?.find((c) => c.id === event.connectionId);
  return (
    <section className="space-y-2 rounded border border-line p-3 text-xs" data-testid="rollback">
      <button type="button" className="btn" disabled={plan.isPending} onClick={() => plan.mutate()}>
        Gerar plano de rollback
      </button>
      <ErrorBox error={plan.error} />
      {data && (
        <div className="space-y-2">
          <div className="font-semibold text-warn" data-testid="rollback-label">
            {data.label}
          </div>
          {data.conflict.detected && (
            <div
              role="alert"
              className="rounded border border-warn/40 bg-warn/10 px-3 py-2"
              data-testid="rollback-conflict"
            >
              <div className="font-semibold">
                Conflito: a linha mudou depois da escrita original.
              </div>
              {data.conflict.message && <div>{data.conflict.message}</div>}
              {data.conflict.columns.length > 0 && (
                <ul className="mt-1 list-disc pl-4 font-mono">
                  {data.conflict.columns.map((c) => (
                    <li key={c.column}>
                      {c.column}: esperado {show(c.expected)}, atual {show(c.current)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <pre
            className="max-h-48 overflow-auto rounded bg-hover p-2 font-mono break-all whitespace-pre-wrap"
            data-testid="rollback-sql"
          >
            {data.displaySql}
          </pre>
          {data.statements > 1 && (
            <div className="text-muted" data-testid="rollback-statements">
              O editor recebe a instrução 1 de {data.statements}; as demais ficam acima para
              referência.
            </div>
          )}
          {!isPreparedPlan(data.plan) ? (
            <div
              role="alert"
              className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger"
              data-testid="rollback-plan-invalid"
            >
              O servidor não devolveu um plano utilizável; gere o plano de rollback de novo.
            </div>
          ) : target ? (
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() =>
                  onOpen({ plan: data.plan, sql: data.sql, title: 'Rollback assistido' }, target.id)
                }
              >
                Abrir prévia
              </button>
              <span data-testid="rollback-connection">
                {`Conexão de destino: ${target.name} · ${ENVIRONMENT_LABEL[target.environment]}`}
              </span>
            </div>
          ) : (
            <div
              role="alert"
              className="rounded border border-danger/40 bg-danger/10 px-3 py-2 text-danger"
              data-testid="rollback-connection-unavailable"
            >
              {`A conexão deste evento (${event.connectionId ?? '—'}) não está disponível para ` +
                'você agora; o plano não foi aberto no editor para não rodar em outra conexão.'}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
