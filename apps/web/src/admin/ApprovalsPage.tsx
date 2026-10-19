import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { decideApproval, listPendingApprovals } from '../api/approvals';
import type { ApprovalDecision, PendingApproval } from '../api/approvals';
import { ApiError } from '../api/client';
import { translateCode } from '../api/errors';
import { ErrorBox } from '../components/ErrorBox';
import { formatDateTime, prettyJson } from '../lib/format';

/** pt-BR messages for the decision errors; other codes fall back to the shared table. */
const DECISION_ERRORS: Record<string, string> = {
  FORBIDDEN: 'Você não pode decidir esta aprovação (permissão ausente ou solicitação própria).',
  CONFLICT: 'Esta aprovação já foi decidida ou o plano mudou. A lista foi atualizada.',
  CONFIRMATION_INVALID: 'Confirmação inválida: o plano não corresponde mais ao aprovado.',
  CONFIRMATION_EXPIRED: 'A aprovação expirou. Peça uma nova solicitação.',
  NOT_FOUND: 'Aprovação não encontrada. Ela pode ter expirado ou sido removida.',
};

export function decisionErrorMessage(err: unknown): string {
  if (err instanceof ApiError) return DECISION_ERRORS[err.code] ?? translateCode(err.code);
  return 'Erro inesperado.';
}

interface Pending {
  item: PendingApproval;
  decision: ApprovalDecision;
}

export function ApprovalsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['approvals', 'pending'], queryFn: listPendingApprovals });
  const items = list.data?.items ?? [];
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const decide = useMutation({
    mutationFn: (p: Pending) => decideApproval(p.item.id, p.decision, reason),
    onSuccess: (_d, p) => {
      setMessage({
        ok: true,
        text: p.decision === 'APPROVE' ? 'Aprovação registrada.' : 'Rejeição registrada.',
      });
    },
    onError: (err) => setMessage({ ok: false, text: decisionErrorMessage(err) }),
    onSettled: () => {
      setPending(null);
      setReason('');
      void qc.invalidateQueries({ queryKey: ['approvals', 'pending'] });
    },
  });

  const start = (item: PendingApproval, decision: ApprovalDecision) => {
    setMessage(null);
    setReason('');
    setPending({ item, decision });
  };

  return (
    <div className="mx-auto max-w-5xl space-y-3 p-4">
      <h1 className="text-base font-semibold">Aprovações pendentes</h1>
      <p className="text-xs text-muted">
        Solicitações de outros usuários que você pode decidir. Você nunca decide as suas próprias.
      </p>
      <ErrorBox error={list.error} />
      {message && (
        <div
          role={message.ok ? 'status' : 'alert'}
          className={`rounded border px-3 py-2 text-xs ${
            message.ok ? 'border-ok/40 text-ok' : 'border-danger/40 bg-danger/10 text-danger'
          }`}
          data-testid="approval-message"
        >
          {message.text}
        </div>
      )}
      {!list.isPending && items.length === 0 && (
        <div className="text-center text-xs text-muted">Nenhuma aprovação pendente.</div>
      )}
      <ul className="space-y-3">
        {items.map((a) => {
          const confirming = pending?.item.id === a.id ? pending : null;
          return (
            <li
              key={a.id}
              className="space-y-2 rounded border border-line bg-panel p-3 text-xs"
              data-testid="approval-item"
            >
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 md:grid-cols-3">
                <div>
                  <dt className="text-muted">Solicitante</dt>
                  <dd className="font-mono break-all">{a.requestedBy}</dd>
                </div>
                <div>
                  <dt className="text-muted">Ambiente</dt>
                  <dd>{a.plan.environment}</dd>
                </div>
                <div>
                  <dt className="text-muted">Capacidade</dt>
                  <dd className="font-mono">{a.plan.action}</dd>
                </div>
                <div>
                  <dt className="text-muted">Resumo</dt>
                  <dd>
                    {a.plan.previewKind} · {a.plan.entities.join(', ') || '—'} ·{' '}
                    {a.plan.targetCount === null
                      ? 'registros desconhecidos'
                      : `${a.plan.targetCount} registro(s)`}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted">Solicitada em</dt>
                  <dd>{formatDateTime(a.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted">Expira em</dt>
                  <dd>{formatDateTime(a.expiresAt)}</dd>
                </div>
              </dl>
              {a.plan.sql !== undefined ? (
                <div className="space-y-1">
                  <pre
                    className="max-h-48 overflow-auto rounded border border-line p-2 font-mono break-all whitespace-pre-wrap"
                    data-testid="approval-sql"
                  >
                    {a.plan.sql}
                  </pre>
                  {a.plan.preview !== undefined && (
                    <pre
                      className="max-h-48 overflow-auto rounded border border-line p-2 font-mono whitespace-pre-wrap"
                      data-testid="approval-preview"
                    >
                      {prettyJson(a.plan.preview)}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="text-muted" data-testid="approval-no-sql">
                  O SQL e o preview não estão disponíveis para o seu perfil; apenas o resumo.
                </div>
              )}
              {confirming ? (
                <div className="space-y-2 rounded border border-warn/60 p-2" role="group">
                  <div className="font-semibold">
                    {confirming.decision === 'APPROVE'
                      ? 'Confirmar a aprovação desta solicitação?'
                      : 'Confirmar a rejeição desta solicitação?'}
                  </div>
                  <label className="block space-y-1">
                    <span className="block font-medium">Motivo (opcional)</span>
                    <input
                      className="input w-full"
                      maxLength={1000}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      className="btn btn-primary"
                      disabled={decide.isPending}
                      onClick={() => decide.mutate(confirming)}
                    >
                      Confirmar
                    </button>
                    <button
                      type="button"
                      className="btn"
                      disabled={decide.isPending}
                      onClick={() => setPending(null)}
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => start(a, 'APPROVE')}
                  >
                    Aprovar
                  </button>
                  <button type="button" className="btn" onClick={() => start(a, 'REJECT')}>
                    Rejeitar
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
