import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiError, api } from '../api/client';
import type { ConnectionOption } from '../api/types';
import { AuditPage } from './AuditPage';
import { RollbackPlanAction, isRollbackEligible, type RollbackEvent } from './AuditRollback';

vi.mock('../api/client', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  api: { get: vi.fn(), post: vi.fn() },
}));

HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const ID = '00000000-0000-4000-8000-000000000001';
const CONNECTIONS: ConnectionOption[] = [
  { id: 'other', name: 'Outra', environment: 'SANDBOX' },
  { id: 'env', name: 'Principal', environment: 'PRODUCTION' },
];

function event(over: Partial<RollbackEvent> = {}): RollbackEvent {
  return {
    id: ID,
    createdAt: '2026-10-20T10:00:00.000Z',
    userId: null,
    userEmail: 'user@example.com',
    ip: null,
    requestId: null,
    action: 'PLAN_EXECUTED',
    operation: null,
    resource: null,
    statement: "UPDATE TGFPAR SET NOMEPARC = 'Novo' WHERE CODPARC = 1",
    targetIds: null,
    before: null,
    after: null,
    gatewayCalls: null,
    status: 'success',
    durationMs: 5,
    errorCode: null,
    errorMessage: null,
    connectionId: 'env',
    details: {
      operation: 'UPDATE',
      resource: 'TGFPAR',
      report: { status: 'success', verification: 'VERIFIED', steps: [] },
    },
    snapshot: { before: { rows: [] }, after: { rows: [] } },
    ...over,
  };
}

const PLAN = {
  type: 'rollback-plan',
  label: 'assisted rollback — requires new preview and confirmation',
  sourceEventId: ID,
  sql: "UPDATE TGFPAR SET NOMEPARC = 'Antigo' WHERE (CODPARC = 1)",
  displaySql:
    "UPDATE TGFPAR SET NOMEPARC = 'Antigo' WHERE (CODPARC = 1);\n" +
    "UPDATE TGFPAR SET NOMEPARC = 'Outro' WHERE (CODPARC = 2)",
  statements: 2,
  conflict: { detected: false, columns: [], message: null },
  // The server-prepared plan: the preview shape plus its token (no `type`, no `execution`).
  plan: {
    planId: '00000000-0000-4000-8000-0000000000aa',
    token: 'rollback-plan-token',
    expiresAt: '2026-10-20T10:05:00.000Z',
    capability: { class: 'SUPPORTED', route: 'SANKHYA_SAVE', reason: 'Native entity' },
    previewKind: 'IMPACT_ANALYSIS',
    previewLabels: ['IMPACT_ANALYSIS', 'SIMULATED_PREVIEW'],
    preview: { affected: 1, targets: [] },
    impact: { entities: ['TGFPAR'], rows: 1, environment: 'PRODUCTION' },
    requires: { strongConfirmation: 'PRODUCTION UPDATE 1 TGFPAR', approval: false },
  },
};

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('isRollbackEligible', () => {
  it('accepts a verified, snapshotted UPDATE', () => {
    expect(isRollbackEligible(event())).toBe(true);
  });

  const cases: Array<[string, RollbackEvent]> = [
    ['another action', event({ action: 'PLAN_CREATED' })],
    [
      'an INSERT',
      event({ details: { operation: 'INSERT', report: { verification: 'VERIFIED' } } }),
    ],
    [
      'an unverified write',
      event({ details: { operation: 'UPDATE', report: { verification: 'UNVERIFIED' } } }),
    ],
    ['no snapshot', event({ snapshot: null })],
    [
      'snapshots disabled',
      event({
        details: {
          operation: 'UPDATE',
          snapshotsDisabled: true,
          report: { verification: 'VERIFIED' },
        },
      }),
    ],
    ['a failed run', event({ status: 'partial' })],
    ['a scratch write', event({ connectionId: 'scratch' })],
    ['no details', event({ details: null })],
  ];
  for (const [name, e] of cases) {
    it(`refuses ${name}`, () => expect(isRollbackEligible(e)).toBe(false));
  }
});

describe('RollbackPlanAction', () => {
  it('renders nothing for an ineligible event', () => {
    wrap(
      <RollbackPlanAction
        event={event({ snapshot: null })}
        onOpen={vi.fn()}
        connections={CONNECTIONS}
      />,
    );
    expect(screen.queryByText('Gerar plano de rollback')).toBeNull();
  });

  it('requests the plan, shows label and SQL, and opens the server-prepared plan', async () => {
    vi.mocked(api.post).mockResolvedValue(PLAN);
    const onOpen = vi.fn();
    wrap(<RollbackPlanAction event={event()} onOpen={onOpen} connections={CONNECTIONS} />);
    fireEvent.click(screen.getByText('Gerar plano de rollback'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/api/audit/${ID}/rollback-plan`));
    expect((await screen.findByTestId('rollback-label')).textContent).toContain(PLAN.label);
    expect(screen.getByTestId('rollback-sql').textContent).toBe(PLAN.displaySql);
    expect(screen.getByTestId('rollback-statements').textContent).toMatch(/1 de 2/);
    expect(screen.queryByTestId('rollback-conflict')).toBeNull();
    expect(screen.getByTestId('rollback-connection').textContent).toBe(
      'Conexão de destino: Principal · PRODUÇÃO',
    );
    fireEvent.click(screen.getByText('Abrir prévia'));
    // The plan the server prepared (and linked to the source event) is the one handed over:
    // no second preview is requested.
    expect(onOpen).toHaveBeenCalledWith(
      { plan: PLAN.plan, sql: PLAN.sql, title: expect.any(String) },
      'env',
    );
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('refuses a plan without a usable token instead of opening it', async () => {
    const { token: _token, ...noToken } = PLAN.plan;
    vi.mocked(api.post).mockResolvedValue({ ...PLAN, plan: noToken });
    const onOpen = vi.fn();
    wrap(<RollbackPlanAction event={event()} onOpen={onOpen} connections={CONNECTIONS} />);
    fireEvent.click(screen.getByText('Gerar plano de rollback'));
    expect((await screen.findByTestId('rollback-plan-invalid')).getAttribute('role')).toBe('alert');
    expect(screen.queryByText('Abrir prévia')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows a conflict with the changed columns', async () => {
    vi.mocked(api.post).mockResolvedValue({
      ...PLAN,
      statements: 1,
      displaySql: PLAN.sql,
      conflict: {
        detected: true,
        columns: [{ column: 'NOMEPARC', expected: 'Novo', current: 'Mudou depois' }],
        message: 'The row changed after the original write.',
      },
    });
    wrap(<RollbackPlanAction event={event()} onOpen={vi.fn()} connections={CONNECTIONS} />);
    fireEvent.click(screen.getByText('Gerar plano de rollback'));
    const conflict = await screen.findByTestId('rollback-conflict');
    expect(conflict.textContent).toContain('The row changed after the original write.');
    expect(conflict.textContent).toContain('NOMEPARC');
    expect(conflict.textContent).toContain('Mudou depois');
    expect(screen.queryByTestId('rollback-statements')).toBeNull();
  });

  it('an event connection that is not available: an error, and the SQL stays out of the editor', async () => {
    vi.mocked(api.post).mockResolvedValue(PLAN);
    const onOpen = vi.fn();
    wrap(
      <RollbackPlanAction
        event={event({ connectionId: 'gone' })}
        onOpen={onOpen}
        connections={CONNECTIONS}
      />,
    );
    fireEvent.click(screen.getByText('Gerar plano de rollback'));
    const alert = await screen.findByTestId('rollback-connection-unavailable');
    expect(alert.textContent).toContain('A conexão deste evento (gone) não está disponível');
    expect(screen.queryByText('Abrir prévia')).toBeNull();
    expect(screen.queryByTestId('rollback-connection')).toBeNull();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('no connection list (not loaded or no access) counts as unavailable', async () => {
    vi.mocked(api.post).mockResolvedValue(PLAN);
    wrap(<RollbackPlanAction event={event()} onOpen={vi.fn()} />);
    fireEvent.click(screen.getByText('Gerar plano de rollback'));
    await screen.findByTestId('rollback-connection-unavailable');
    expect(screen.queryByText('Abrir prévia')).toBeNull();
  });

  it('shows the server refusal', async () => {
    vi.mocked(api.post).mockRejectedValue(
      new ApiError(409, { code: 'CONFLICT', message: 'No rollback plan for this event' }),
    );
    wrap(<RollbackPlanAction event={event()} onOpen={vi.fn()} connections={CONNECTIONS} />);
    fireEvent.click(screen.getByText('Gerar plano de rollback'));
    expect(await screen.findByText(/No rollback plan for this event/)).toBeTruthy();
  });
});

describe('AuditPage rollback action', () => {
  it('appears in the detail of an eligible event only', async () => {
    vi.mocked(api.get).mockResolvedValue({
      items: [event(), event({ id: 'other', snapshot: null })],
      total: 2,
    });
    wrap(<AuditPage onOpen={vi.fn()} connections={CONNECTIONS} />);
    const rows = await screen.findAllByTestId('audit-row');
    fireEvent.click(rows[0]!);
    expect(screen.getByText('Gerar plano de rollback')).toBeTruthy();
    fireEvent.click(rows[1]!);
    expect(screen.queryByText('Gerar plano de rollback')).toBeNull();
  });

  it('is hidden when the page cannot open the editor', async () => {
    vi.mocked(api.get).mockResolvedValue({ items: [event()], total: 1 });
    wrap(<AuditPage />);
    fireEvent.click((await screen.findAllByTestId('audit-row'))[0]!);
    expect(screen.queryByText('Gerar plano de rollback')).toBeNull();
  });
});
