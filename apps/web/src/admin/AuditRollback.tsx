import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AuditEvent } from '../api/types';
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

/** POST /api/audit/:id/rollback-plan. `sql` is the first statement, prepared as a new plan. */
export interface RollbackPlan {
  type: 'rollback-plan';
  label: string;
  sourceEventId: string;
  sql: string;
  displaySql: string;
  statements: number;
  conflict: RollbackConflict;
  plan: Record<string, unknown>;
}

export type OpenRollback = (req: { sql: string; title: string }, connectionId: string) => void;

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

/** "Gerar plano de rollback": asks the server for a new plan and hands its SQL to the editor. */
export function RollbackPlanAction({
  event,
  onOpen,
}: {
  event: RollbackEvent;
  onOpen: OpenRollback;
}) {
  const plan = useMutation({
    mutationFn: () => api.post<RollbackPlan>(`/api/audit/${event.id}/rollback-plan`),
  });
  if (!isRollbackEligible(event)) return null;
  const data = plan.data;
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
          <button
            type="button"
            className="btn btn-primary"
            onClick={() =>
              onOpen({ sql: data.sql, title: 'Rollback assistido' }, event.connectionId ?? '')
            }
          >
            Abrir no editor
          </button>
        </div>
      )}
    </section>
  );
}
