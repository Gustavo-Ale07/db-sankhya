import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, api } from '../api/client';
import type { PendingApproval } from '../api/approvals';
import { ApprovalsPage, decisionErrorMessage } from './ApprovalsPage';

vi.mock('../api/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  api: { get: vi.fn(), post: vi.fn() },
}));

const base = (id: string, withSql: boolean): PendingApproval => ({
  id,
  planId: `plan-${id}`,
  planHash: 'h',
  requestedBy: 'requester-1',
  createdAt: '2026-01-01T10:00:00.000Z',
  expiresAt: '2026-01-01T11:00:00.000Z',
  plan: {
    environment: 'PRODUCTION',
    connectionId: 'c1',
    previewKind: 'UPDATE',
    action: 'DATA.UPDATE',
    entities: ['TGFPRO'],
    targetCount: 3,
    ...(withSql ? { sql: 'UPDATE TGFPRO SET ATIVO = 1', preview: { rows: 3 } } : {}),
  },
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ApprovalsPage />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.mocked(api.get).mockResolvedValue({ items: [base('a1', true), base('a2', false)] });
  vi.mocked(api.post).mockResolvedValue({ approval: {} });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ApprovalsPage', () => {
  it('lists items, showing sql only when present', async () => {
    renderPage();
    expect(await screen.findAllByTestId('approval-item')).toHaveLength(2);
    expect(screen.getAllByTestId('approval-sql')).toHaveLength(1);
    expect(screen.getByTestId('approval-sql').textContent).toContain('UPDATE TGFPRO');
    expect(screen.getAllByTestId('approval-no-sql')).toHaveLength(1);
    expect(screen.getAllByText('PRODUCTION')).toHaveLength(2);
  });

  it('approves only after confirmation, then refreshes', async () => {
    renderPage();
    await screen.findAllByTestId('approval-item');
    fireEvent.click(screen.getAllByText('Aprovar')[0]!);
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Motivo (opcional)'), { target: { value: ' ok ' } });
    fireEvent.click(screen.getByText('Confirmar'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/approvals/a1/decision', {
        decision: 'APPROVE',
        reason: 'ok',
      }),
    );
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    expect((await screen.findByTestId('approval-message')).textContent).toBe(
      'Aprovação registrada.',
    );
  });

  it('rejects after confirmation with a null reason', async () => {
    renderPage();
    await screen.findAllByTestId('approval-item');
    fireEvent.click(screen.getAllByText('Rejeitar')[1]!);
    fireEvent.click(screen.getByText('Confirmar'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/api/approvals/a2/decision', {
        decision: 'REJECT',
        reason: null,
      }),
    );
    expect((await screen.findByTestId('approval-message')).textContent).toBe(
      'Rejeição registrada.',
    );
  });

  it('shows the mapped message when the decision fails', async () => {
    vi.mocked(api.post).mockRejectedValue(new ApiError(409, { code: 'CONFLICT', message: 'x' }));
    renderPage();
    await screen.findAllByTestId('approval-item');
    fireEvent.click(screen.getAllByText('Aprovar')[0]!);
    fireEvent.click(screen.getByText('Confirmar'));
    expect((await screen.findByTestId('approval-message')).textContent).toBe(
      decisionErrorMessage(new ApiError(409, { code: 'CONFLICT', message: '' })),
    );
  });
});

describe('decisionErrorMessage', () => {
  const expected: Record<string, RegExp> = {
    FORBIDDEN: /não pode decidir/,
    CONFLICT: /já foi decidida/,
    CONFIRMATION_INVALID: /Confirmação inválida/,
    CONFIRMATION_EXPIRED: /expirou/,
    NOT_FOUND: /não encontrada/,
  };
  it.each(Object.keys(expected))('maps %s to a pt-BR message', (code) => {
    expect(decisionErrorMessage(new ApiError(400, { code, message: 'en' }))).toMatch(
      expected[code]!,
    );
  });
  it('falls back for unknown errors', () => {
    expect(decisionErrorMessage(new Error('x'))).toBe('Erro inesperado.');
  });
});
