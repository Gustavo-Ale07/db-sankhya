import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { AuditEvent, ConnectionOption } from '../api/types';
import { ErrorBox } from '../components/ErrorBox';
import { JsonView } from '../components/JsonView';
import { Modal } from '../components/Modal';
import { formatDateTime, formatDuration } from '../lib/format';
import { RollbackPlanAction, type OpenRollback } from './AuditRollback';

const PAGE = 50;
const ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'auth.password_changed',
  'write.preview',
  'write.execute',
  'write.denied',
  'write.rejected',
  'user.create',
  'user.update',
  'user.reset_password',
  'user.roles',
  'group.create',
  'group.update',
  'group.delete',
  'group.members',
  'group.roles',
  'role.create',
  'role.update',
  'role.delete',
  'policy.create',
  'policy.update',
  'policy.delete',
  'connection.create',
  'connection.update',
  'connection.rotate_secrets',
  'connection.test',
  'connection.delete',
  'security.update',
  'approval.request',
  'approval.decide',
  'approval.execute',
  'ddl.generate',
  'ddl.denied',
  'read.denied',
  'scratch.materialize',
  'scratch.denied',
  'PLAN_CREATED',
  'PLAN_EXECUTED',
  'rollback.planned',
];
const STATUSES = ['success', 'partial', 'failed', 'denied', 'info'] as const;
const STATUS_CLS: Record<AuditEvent['status'], string> = {
  success: 'text-ok',
  partial: 'text-warn',
  failed: 'text-danger',
  denied: 'text-danger',
  info: 'text-muted',
};

interface Filters {
  action: string;
  userEmail: string;
  resource: string;
  status: string;
  from: string;
  to: string;
}
const EMPTY: Filters = { action: '', userEmail: '', resource: '', status: '', from: '', to: '' };

/**
 * `onOpen` hands a rollback statement to the SQL editor (without it the action is hidden);
 * `connections` are the caller's usable connections, so the target connection is named exactly.
 */
export function AuditPage({
  onOpen,
  connections,
}: { onOpen?: OpenRollback; connections?: readonly ConnectionOption[] } = {}) {
  const [form, setForm] = useState<Filters>(EMPTY);
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState<AuditEvent | null>(null);

  const audit = useQuery({
    queryKey: ['audit', filters, offset],
    queryFn: () =>
      api.get<{ items: AuditEvent[]; total: number }>('/api/audit', {
        query: {
          ...Object.fromEntries(Object.entries(filters).filter(([, v]) => v.trim() !== '')),
          limit: PAGE,
          offset,
        },
      }),
  });
  const items = audit.data?.items ?? [];
  const total = audit.data?.total ?? 0;

  const field = (k: keyof Filters, label: string, type = 'text') => (
    <label className="space-y-1 text-xs">
      <span className="block font-medium">{label}</span>
      <input
        className="input w-40"
        type={type}
        value={form[k]}
        onChange={(e) => setForm({ ...form, [k]: e.target.value })}
      />
    </label>
  );

  return (
    <div className="mx-auto max-w-7xl space-y-3 p-4">
      <h1 className="text-base font-semibold">Auditoria</h1>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setOffset(0);
          setFilters(form);
        }}
      >
        <label className="space-y-1 text-xs">
          <span className="block font-medium">Ação</span>
          <select
            className="input w-48"
            value={form.action}
            onChange={(e) => setForm({ ...form, action: e.target.value })}
          >
            <option value="">Todas</option>
            {ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        {field('userEmail', 'Usuário (e-mail)')}
        {field('resource', 'Recurso')}
        <label className="space-y-1 text-xs">
          <span className="block font-medium">Status</span>
          <select
            className="input w-32"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          >
            <option value="">Todos</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        {field('from', 'De', 'date')}
        {field('to', 'Até', 'date')}
        <button type="submit" className="btn btn-primary">
          Filtrar
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setForm(EMPTY);
            setFilters(EMPTY);
            setOffset(0);
          }}
        >
          Limpar
        </button>
      </form>
      <ErrorBox error={audit.error} />
      <div className="overflow-auto rounded border border-line bg-panel">
        <table className="table-std text-xs" data-testid="audit-table">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Usuário</th>
              <th>Ação</th>
              <th>Recurso</th>
              <th>Status</th>
              <th>Instrução</th>
              <th className="text-right">Tempo</th>
              <th>IP</th>
            </tr>
          </thead>
          <tbody>
            {items.map((a) => (
              <tr
                key={a.id}
                className="cursor-pointer hover:bg-hover"
                onClick={() => setDetail(a)}
                data-testid="audit-row"
              >
                <td className="whitespace-nowrap">{formatDateTime(a.createdAt)}</td>
                <td>{a.userEmail ?? '—'}</td>
                <td className="font-mono whitespace-nowrap">{a.action}</td>
                <td>{a.resource ?? '—'}</td>
                <td className={STATUS_CLS[a.status]}>
                  {a.status}
                  {a.errorCode && <div className="text-[11px]">{a.errorCode}</div>}
                </td>
                <td className="max-w-md">
                  <code className="line-clamp-2 font-mono break-all">{a.statement ?? ''}</code>
                </td>
                <td className="text-right whitespace-nowrap">{formatDuration(a.durationMs)}</td>
                <td className="whitespace-nowrap">{a.ip ?? '—'}</td>
              </tr>
            ))}
            {!audit.isPending && items.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center text-muted">
                  Nenhum evento encontrado.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-end gap-2 text-xs">
        <span className="mr-auto text-muted">{total} evento(s)</span>
        <button
          type="button"
          className="btn"
          disabled={offset === 0}
          onClick={() => setOffset((o) => Math.max(0, o - PAGE))}
        >
          ← Anteriores
        </button>
        <span className="text-muted">
          {items.length ? `${offset + 1}–${offset + items.length} de ${total}` : '0'}
        </span>
        <button
          type="button"
          className="btn"
          disabled={offset + items.length >= total}
          onClick={() => setOffset((o) => o + PAGE)}
        >
          Próximos →
        </button>
      </div>

      <Modal
        open={detail !== null}
        title={detail ? `${detail.action} · ${formatDateTime(detail.createdAt)}` : ''}
        onClose={() => setDetail(null)}
        wide
        testId="audit-detail"
      >
        {detail && (
          <div className="space-y-3">
            {onOpen && (
              <RollbackPlanAction
                key={detail.id}
                event={detail}
                onOpen={onOpen}
                connections={connections}
              />
            )}
            <div className="h-[60vh]">
              <JsonView value={detail} />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
